/**
 * ngspice wrapper and the opt-in SPICE verification gate (`check --spice`).
 * LLM-free and network-free: local subprocesses only.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PreflightError, isNotFoundError } from '../util/preflight.js';
import { listNets, listSymbols, pinNets } from './sexp.js';
import { exportSpiceNetlist } from './cli.js';
import {
  SimulationParseError,
  assembleSpiceDeck,
  evaluateSpiceBlock,
  parseNgspiceMeasures,
  parseSimulationBlocks,
  type SimulationBlock,
  type SpiceAssertionResult,
} from './spice.js';

export const DEFAULT_SPICE_TIMEOUT_MS = 30_000;

export class NgspiceMissingError extends PreflightError {
  constructor() {
    super(
      'ngspice not found on PATH',
      'the SPICE gate runs ngspice locally to check ## Simulation assertions in SUBSYSTEMS.md',
      [
        'install ngspice (https://ngspice.sourceforge.io/download.html)',
        'or set COPPERHEAD_NGSPICE to the ngspice binary',
        'confirm with "ngspice -v", then rerun with --spice',
      ],
    );
    this.name = 'NgspiceMissingError';
  }
}

/** Set-but-missing override: fail the gate rather than skip, matching kicad-cli. */
export class NgspiceBadOverrideError extends PreflightError {
  constructor(configured: string) {
    super(
      `ngspice path does not exist: ${configured}`,
      'the override wins over PATH, so falling back silently would run a different binary than the one you named',
      [
        `check the path: ls -l "${configured}"`,
        'or set COPPERHEAD_NGSPICE to a real ngspice binary',
        'or set spice.ngspice in .copperhead/config.json',
        'or unset the override to fall back to PATH',
      ],
    );
    this.name = 'NgspiceBadOverrideError';
  }
}

export interface SpiceRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpiceGateDeps {
  exportNetlist: (schPath: string) => Promise<string>;
  runNgspice: (deck: string, timeoutMs: number) => Promise<SpiceRunResult>;
  resolveNgspice: () => Promise<string>;
  netsOf: (schPath: string) => Promise<string[]>;
  sheetsOf: (schPath: string) => Promise<string[]>;
}

export type SpiceGateStatus = 'pass' | 'fail' | 'skip' | 'idle';

export interface SpiceGateReport {
  status: SpiceGateStatus;
  blocks: number;
  assertions: SpiceAssertionResult[];
  skipped?: string;
  unverified?: number;
  errors: string[];
}

const defaultDeps: SpiceGateDeps = {
  exportNetlist: exportSpiceNetlist,
  runNgspice,
  resolveNgspice,
  netsOf: async (schPath) => {
    const [names, pins] = await Promise.all([listNets(schPath), pinNets(schPath)]);
    const nets = new Set(names);
    for (const p of pins) if (p.net) nets.add(p.net);
    return [...nets];
  },
  sheetsOf: async (schPath) => {
    const symbols = await listSymbols(schPath);
    return [...new Set(['/', ...symbols.map((s) => s.sheet)])];
  },
};

let cachedNgspice: string | null | undefined;

export function resetNgspiceCache(): void {
  cachedNgspice = undefined;
}

export async function resolveNgspice(env = process.env, configuredPath?: string): Promise<string> {
  if (cachedNgspice) return cachedNgspice;
  const override = env.COPPERHEAD_NGSPICE?.trim() || configuredPath?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new NgspiceBadOverrideError(override);
    }
    cachedNgspice = override;
    return override;
  }
  try {
    const res = await execa('ngspice', ['-v'], { reject: false });
    if (res.exitCode === 0 || (res.stdout || res.stderr)) {
      cachedNgspice = 'ngspice';
      return 'ngspice';
    }
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  cachedNgspice = null;
  throw new NgspiceMissingError();
}

export async function ngspiceVersion(env = process.env): Promise<string> {
  const bin = await resolveNgspice(env);
  const res = await execa(bin, ['-v'], { reject: false });
  const text = `${res.stdout}\n${res.stderr}`;
  const line = text.split(/\r?\n/).find((l) => /ngspice/i.test(l));
  return (line ?? text).trim().slice(0, 120);
}

async function runNgspice(deck: string, timeoutMs: number): Promise<SpiceRunResult> {
  const bin = await resolveNgspice();
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-spice-'));
  const cir = path.join(dir, 'gate.cir');
  try {
    await writeFile(cir, deck, 'utf8');
    const res = await execa(bin, ['-b', cir], { reject: false, timeout: timeoutMs });
    return {
      stdout: String(res.stdout ?? ''),
      stderr: String(res.stderr ?? ''),
      exitCode: res.exitCode ?? 1,
    };
  } catch (err) {
    if (isNotFoundError(err)) throw new NgspiceMissingError();
    const message = (err as Error).message || String(err);
    return { stdout: '', stderr: message, exitCode: 1 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function spiceScopeProblems(block: SimulationBlock, nets: string[], sheets: string[]): string[] {
  const netSet = new Set(nets.map((n) => n.toLowerCase()));
  const sheetSet = new Set(sheets.map((s) => s.toLowerCase()));
  if (block.scope.kind === 'sheet') {
    const want = block.scope.sheet.toLowerCase();
    const hit = [...sheetSet].some((s) => s === want || s.endsWith(want) || want.endsWith(s));
    if (!hit) {
      return [`Simulation block line ${block.line}: sheet "${block.scope.sheet}" is not in the schematic`];
    }
    return [];
  }
  return block.scope.nets
    .filter((n) => !netSet.has(n.toLowerCase()))
    .map((n) => `Simulation block line ${block.line}: net "${n}" is not in the schematic`);
}

export function formatSpiceGate(report: SpiceGateReport): string[] {
  if (report.status === 'idle') return ['SPICE skipped (no ## Simulation blocks)'];
  if (report.status === 'skip') {
    return [
      `SPICE gate skipped (${report.skipped ?? 'ngspice not found'}): ${report.unverified ?? 0} assertion(s) unverified`,
    ];
  }
  const lines: string[] = [];
  if (report.status === 'pass') {
    lines.push(`SPICE ✓ ${report.assertions.length} assertion(s)`);
  } else {
    const failed = report.assertions.filter((a) => a.status !== 'pass').length;
    if (failed > 0) lines.push(`SPICE ✗ ${failed} failed`);
    else if (report.errors.length) lines.push(`SPICE ✗ ${report.errors.length} error(s)`);
    else lines.push('SPICE ✗');
  }
  for (const err of report.errors) lines.push(`  ${err}`);
  for (const a of report.assertions) {
    if (a.status === 'pass') lines.push(`  ✓ ${a.detail}`);
    else lines.push(`  ✗ ${a.detail}`);
  }
  return lines;
}

export interface RunSpiceGateOptions {
  repoRoot: string;
  schematic: string;
  docsDir: string;
  timeoutMs?: number;
  /** From `spice.ngspice` in config. `COPPERHEAD_NGSPICE` still wins. */
  ngspicePath?: string;
  deps?: Partial<SpiceGateDeps>;
}

export async function runSpiceGate(opts: RunSpiceGateOptions): Promise<SpiceGateReport> {
  const deps: SpiceGateDeps = {
    ...defaultDeps,
    ...opts.deps,
    resolveNgspice:
      opts.deps?.resolveNgspice ?? (() => resolveNgspice(process.env, opts.ngspicePath)),
  };
  const subsPath = path.join(opts.repoRoot, opts.docsDir, 'SUBSYSTEMS.md');
  if (!existsSync(subsPath)) {
    return { status: 'idle', blocks: 0, assertions: [], errors: [] };
  }

  let blocks: SimulationBlock[];
  try {
    blocks = parseSimulationBlocks(await readFile(subsPath, 'utf8'));
  } catch (err) {
    const msg = err instanceof SimulationParseError ? err.message : (err as Error).message;
    return { status: 'fail', blocks: 0, assertions: [], errors: [`SUBSYSTEMS.md: ${msg}`] };
  }
  if (!blocks.length) {
    return { status: 'idle', blocks: 0, assertions: [], errors: [] };
  }

  const assertionCount = blocks.reduce((n, b) => n + b.assertions.length, 0);
  try {
    await deps.resolveNgspice();
  } catch (err) {
    if (err instanceof NgspiceMissingError || isNotFoundError(err)) {
      return {
        status: 'skip',
        blocks: blocks.length,
        assertions: [],
        skipped: 'ngspice not found',
        unverified: assertionCount,
        errors: [],
      };
    }
    if (err instanceof NgspiceBadOverrideError) {
      return {
        status: 'fail',
        blocks: blocks.length,
        assertions: [],
        errors: [err.reason],
      };
    }
    throw err;
  }

  const schPath = path.join(opts.repoRoot, opts.schematic);
  if (!existsSync(schPath)) {
    return {
      status: 'fail',
      blocks: blocks.length,
      assertions: [],
      errors: [`schematic missing: ${opts.schematic}`],
    };
  }

  const [nets, sheets] = await Promise.all([deps.netsOf(schPath), deps.sheetsOf(schPath)]);
  const errors: string[] = [];
  for (const block of blocks) errors.push(...spiceScopeProblems(block, nets, sheets));
  if (errors.length) {
    return { status: 'fail', blocks: blocks.length, assertions: [], errors };
  }

  let netlist: string;
  try {
    netlist = await deps.exportNetlist(schPath);
  } catch (err) {
    return {
      status: 'fail',
      blocks: blocks.length,
      assertions: [],
      errors: [`spice netlist export failed: ${(err as Error).message}`],
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SPICE_TIMEOUT_MS;
  const assertions: SpiceAssertionResult[] = [];
  for (const block of blocks) {
    const { text } = assembleSpiceDeck(netlist, block);
    const run = await deps.runNgspice(text, timeoutMs);
    const measures = parseNgspiceMeasures(`${run.stdout}\n${run.stderr}`);
    if (Object.keys(measures).length === 0 && run.exitCode !== 0) {
      const excerpt = (run.stderr || run.stdout).trim().split(/\r?\n/).slice(0, 6).join(' ');
      assertions.push({
        assertion: `block line ${block.line}`,
        status: 'unrunnable',
        detail: `simulation failed to run: ${excerpt || `ngspice exit ${run.exitCode}`}`,
        line: block.line,
      });
      continue;
    }
    assertions.push(...evaluateSpiceBlock(block, measures));
  }

  const failed = assertions.some((a) => a.status !== 'pass');
  return {
    status: failed ? 'fail' : 'pass',
    blocks: blocks.length,
    assertions,
    errors,
  };
}
