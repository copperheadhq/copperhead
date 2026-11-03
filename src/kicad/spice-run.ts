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
import type { Violation } from './report.js';
import {
  SimulationParseError,
  assembleSpiceDeck,
  collectGateMeasures,
  evaluateSpiceBlock,
  parseSimulationBlocks,
  spiceIncludePaths,
  spiceNetlistProblems,
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

/** ngspice was found but cannot be used: the probe hung or printed no ngspice banner. */
export class NgspiceUnusableError extends PreflightError {
  constructor(bin: string, why: string) {
    super(
      `ngspice is not usable: ${bin} (${why})`,
      'the SPICE gate needs a console ngspice that answers "ngspice -v" and exits',
      [
        `run "${bin} -v" by hand and check it prints an ngspice-<version> banner`,
        'on Windows, point COPPERHEAD_NGSPICE at ngspice_con.exe, not the GUI ngspice.exe',
      ],
    );
    this.name = 'NgspiceUnusableError';
  }
}

/** Bound on `ngspice -v`, so a binary that never exits cannot hang `check`. */
export const NGSPICE_PROBE_TIMEOUT_MS = 10_000;

export interface SpiceRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The batch run hit the configured timeout and was killed. */
  timedOut?: boolean;
}

/** The subset of an execa result the probe and runner read. */
export interface SpiceExecResult {
  exitCode?: number;
  stdout?: unknown;
  stderr?: unknown;
  timedOut?: boolean;
  code?: string;
  message?: string;
}

export type SpiceExec = (
  file: string,
  args: string[],
  options: { reject: false; timeout: number; stdin: 'ignore'; cwd?: string },
) => Promise<SpiceExecResult>;

const defaultExec: SpiceExec = (file, args, options) => execa(file, args, options) as Promise<SpiceExecResult>;

export interface SpiceGateDeps {
  exportNetlist: (schPath: string) => Promise<string>;
  runNgspice: (deck: string, timeoutMs: number, bin: string) => Promise<SpiceRunResult>;
  resolveNgspice: () => Promise<string>;
  /** The banner version from the probe (e.g. "ngspice-47"), when known. */
  ngspiceVersion: () => string | undefined;
  netsOf: (schPath: string) => Promise<string[]>;
  sheetsOf: (schPath: string) => Promise<string[]>;
  readInclude: (file: string) => Promise<string | null>;
}

export type SpiceGateStatus = 'pass' | 'fail' | 'skip' | 'idle';

/**
 * A failed assertion or failed simulation in the ERC/DRC violation shape
 * (`src/kicad/report.ts`), plus the measured value and the bound.
 */
export interface SpiceViolation extends Violation {
  type: 'spice_assertion' | 'spice_simulation_failed';
  measured?: number;
  bound?: string;
  line: number;
}

export interface SpiceGateReport {
  status: SpiceGateStatus;
  blocks: number;
  assertions: SpiceAssertionResult[];
  violations: SpiceViolation[];
  skipped?: string;
  unverified?: number;
  /** ngspice banner version, when the gate ran. */
  ngspice?: string;
  errors: string[];
}

const defaultDeps: SpiceGateDeps = {
  exportNetlist: exportSpiceNetlist,
  runNgspice: (deck, timeoutMs, bin) => runNgspice(deck, timeoutMs, bin),
  resolveNgspice,
  ngspiceVersion: () => cachedNgspice?.version,
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
  readInclude: async (file) => (existsSync(file) ? readFile(file, 'utf8') : null),
};

let cachedNgspice: { bin: string; version: string } | null | undefined;

export function resetNgspiceCache(): void {
  cachedNgspice = undefined;
}

/**
 * `<bin> -v`, bounded. Returns the banner version, or null when the binary is
 * absent. A Windows shell answers a missing command with exit 1 and "'ngspice'
 * is not recognized ...", so only exit 0 with an ngspice-<n> banner counts.
 */
async function probeNgspice(bin: string, exec: SpiceExec): Promise<string | null> {
  let res: SpiceExecResult;
  try {
    res = await exec(bin, ['-v'], { reject: false, timeout: NGSPICE_PROBE_TIMEOUT_MS, stdin: 'ignore' });
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
  if (isNotFoundError(res)) return null;
  if (res.timedOut) {
    throw new NgspiceUnusableError(bin, `"-v" did not exit within ${NGSPICE_PROBE_TIMEOUT_MS} ms`);
  }
  const banner = /ngspice-[\w.]+/i.exec(`${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`);
  if (res.exitCode !== 0 || !banner) return null;
  return banner[0];
}

export async function resolveNgspice(
  env = process.env,
  configuredPath?: string,
  exec: SpiceExec = defaultExec,
): Promise<string> {
  if (cachedNgspice) return cachedNgspice.bin;
  const override = env.COPPERHEAD_NGSPICE?.trim() || configuredPath?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new NgspiceBadOverrideError(override);
    }
    const version = await probeNgspice(override, exec);
    if (!version) throw new NgspiceUnusableError(override, 'no ngspice-<version> banner from "-v"');
    cachedNgspice = { bin: override, version };
    return override;
  }
  const version = await probeNgspice('ngspice', exec);
  if (version) {
    cachedNgspice = { bin: 'ngspice', version };
    return 'ngspice';
  }
  cachedNgspice = null;
  throw new NgspiceMissingError();
}

/**
 * One batch run in a fresh temp dir. `-n` skips `.spiceinit` (both the
 * working directory's and $HOME's): it is an ngspice script, and the gate
 * must not run commands the deck did not compile.
 */
export async function runNgspice(
  deck: string,
  timeoutMs: number,
  bin = 'ngspice',
  exec: SpiceExec = defaultExec,
): Promise<SpiceRunResult> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-spice-'));
  try {
    await writeFile(path.join(dir, 'gate.cir'), deck, 'utf8');
    const res = await exec(bin, ['-n', '-b', 'gate.cir'], {
      cwd: dir,
      reject: false,
      timeout: timeoutMs,
      stdin: 'ignore',
    });
    if (isNotFoundError(res)) throw new NgspiceMissingError();
    return {
      stdout: String(res.stdout ?? ''),
      stderr: String(res.stderr ?? ''),
      exitCode: res.exitCode ?? 1,
      ...(res.timedOut ? { timedOut: true } : {}),
    };
  } catch (err) {
    if (err instanceof NgspiceMissingError || isNotFoundError(err)) throw new NgspiceMissingError();
    const message = (err as Error).message || String(err);
    return { stdout: '', stderr: message, exitCode: 1 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MAX_INCLUDE_DEPTH = 8;

/**
 * Refusals for the exported netlist and every local file it `.include`s or
 * `.lib`s: ngspice runs a `.control` block from an included file too.
 * Missing include files are left for ngspice to report as unrunnable.
 */
export async function spiceDeckProblems(
  netlist: string,
  baseDir: string,
  readInclude: SpiceGateDeps['readInclude'],
): Promise<string[]> {
  const problems = spiceNetlistProblems(netlist).map((p) => p.message);
  const seen = new Set<string>();
  const queue = spiceIncludePaths(netlist).map((p) => ({ file: path.resolve(baseDir, p), depth: 1 }));
  while (queue.length) {
    const { file, depth } = queue.shift()!;
    if (seen.has(file) || depth > MAX_INCLUDE_DEPTH) continue;
    seen.add(file);
    const text = await readInclude(file);
    if (text === null) continue;
    for (const p of spiceNetlistProblems(text)) {
      problems.push(`${file}: ${p.message.replace(/^netlist /, '')}`);
    }
    for (const next of spiceIncludePaths(text)) {
      queue.push({ file: path.resolve(path.dirname(file), next), depth: depth + 1 });
    }
  }
  return problems;
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
  const version = report.ngspice ? ` (${report.ngspice})` : '';
  if (report.status === 'pass') {
    lines.push(`SPICE ✓ ${report.assertions.length} assertion(s)${version}`);
  } else {
    const failed = report.assertions.filter((a) => a.status !== 'pass').length;
    if (failed > 0) lines.push(`SPICE ✗ ${failed} failed${version}`);
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
  const fail = (blocks: number, errors: string[]): SpiceGateReport => ({
    status: 'fail',
    blocks,
    assertions: [],
    violations: [],
    errors,
  });
  if (!existsSync(subsPath)) {
    return { status: 'idle', blocks: 0, assertions: [], violations: [], errors: [] };
  }

  let blocks: SimulationBlock[];
  try {
    blocks = parseSimulationBlocks(await readFile(subsPath, 'utf8'));
  } catch (err) {
    const msg = err instanceof SimulationParseError ? err.message : (err as Error).message;
    return fail(0, [`SUBSYSTEMS.md: ${msg}`]);
  }
  if (!blocks.length) {
    return { status: 'idle', blocks: 0, assertions: [], violations: [], errors: [] };
  }

  const assertionCount = blocks.reduce((n, b) => n + b.assertions.length, 0);
  const skip = (): SpiceGateReport => ({
    status: 'skip',
    blocks: blocks.length,
    assertions: [],
    violations: [],
    skipped: 'ngspice not found',
    unverified: assertionCount,
    errors: [],
  });
  let bin: string;
  try {
    bin = await deps.resolveNgspice();
  } catch (err) {
    if (err instanceof NgspiceMissingError || isNotFoundError(err)) return skip();
    if (err instanceof NgspiceBadOverrideError || err instanceof NgspiceUnusableError) {
      return fail(blocks.length, [err.reason]);
    }
    throw err;
  }
  const version = deps.ngspiceVersion();

  const schPath = path.join(opts.repoRoot, opts.schematic);
  if (!existsSync(schPath)) {
    return fail(blocks.length, [`schematic missing: ${opts.schematic}`]);
  }

  const [nets, sheets] = await Promise.all([deps.netsOf(schPath), deps.sheetsOf(schPath)]);
  const errors: string[] = [];
  for (const block of blocks) errors.push(...spiceScopeProblems(block, nets, sheets));
  if (errors.length) return fail(blocks.length, errors);

  let netlist: string;
  try {
    netlist = await deps.exportNetlist(schPath);
  } catch (err) {
    return fail(blocks.length, [`spice netlist export failed: ${(err as Error).message}`]);
  }

  // Refuse before ngspice ever sees the deck (spice-verification: raw control
  // blocks are not accepted). KiCad copies schematic text into the netlist.
  const deckProblems = await spiceDeckProblems(netlist, path.dirname(schPath), deps.readInclude);
  if (deckProblems.length) return fail(blocks.length, deckProblems);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SPICE_TIMEOUT_MS;
  const assertions: SpiceAssertionResult[] = [];
  const violations: SpiceViolation[] = [];
  for (const block of blocks) {
    const sheet = block.scope.kind === 'sheet' ? { sheet: block.scope.sheet } : {};
    const unrunnable = (detail: string): void => {
      assertions.push({ assertion: `block line ${block.line}`, status: 'unrunnable', detail, line: block.line });
      violations.push({
        severity: 'error',
        type: 'spice_simulation_failed',
        description: detail,
        ...sheet,
        items: [],
        line: block.line,
      });
    };

    const deck = assembleSpiceDeck(netlist, block);
    let run: SpiceRunResult;
    try {
      run = await deps.runNgspice(deck.text, timeoutMs, bin);
    } catch (err) {
      if (err instanceof NgspiceMissingError) return skip();
      throw err;
    }
    if (run.timedOut) {
      unrunnable(`simulation timed out after ${timeoutMs} ms`);
      continue;
    }
    const { values, duplicates } = collectGateMeasures(run.stdout, deck.compiled);
    if (duplicates.length) {
      unrunnable(`ngspice printed measure ${duplicates.join(', ')} more than once; output not trusted`);
      continue;
    }
    if (Object.keys(values).length === 0 && run.exitCode !== 0) {
      const excerpt = (run.stderr || run.stdout).trim().split(/\r?\n/).slice(0, 6).join(' ');
      unrunnable(`simulation failed to run: ${excerpt || `ngspice exit ${run.exitCode}`}`);
      continue;
    }
    for (const result of evaluateSpiceBlock(block, values)) {
      assertions.push(result);
      if (result.status === 'pass') continue;
      violations.push({
        severity: 'error',
        type: 'spice_assertion',
        description: result.detail,
        ...sheet,
        ...(result.measured !== undefined ? { measured: result.measured } : {}),
        ...(result.bound !== undefined ? { bound: result.bound } : {}),
        items: [],
        line: result.line,
      });
    }
  }

  return {
    status: violations.length ? 'fail' : 'pass',
    blocks: blocks.length,
    assertions,
    violations,
    ...(version ? { ngspice: version } : {}),
    errors,
  };
}
