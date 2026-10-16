import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { ConstraintRegistry } from '../memory/constraints.js';
import { isNotFoundError } from '../util/preflight.js';
import { listSymbols, pinNets, type PinNet, type SchematicSymbol } from './sexp.js';
import { parseSimulationBlocks, parseSpiceAssertion, parseSpiceNumber, type SimulationBlock } from './spice.js';

/** The intentionally narrow DC regulator slice of the SPICE roadmap. */
export interface RegulatorOpCircuit {
  ref: string;
  output: string | null;
  status: 'pass' | 'fail' | 'not_checked';
  target?: number;
  min?: number;
  max?: number;
  measured?: number;
  reason?: 'undeclared' | 'invalid_constraint' | 'missing_source' | 'missing_model' |
    'unsupported_circuit' | 'missing_ngspice' | 'non_convergence' | 'timeout' | 'simulation_failed' | 'out_of_tolerance';
  detail?: string;
}

export interface RegulatorOpReport {
  ok: boolean;
  circuits: RegulatorOpCircuit[];
}

export interface SpiceProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface RegulatorOpOptions {
  binary?: string;
  timeoutMs?: number;
  /** A subprocess seam for unit tests; the production path always uses execa. */
  execute?: (binary: string, args: string[], timeoutMs: number) => Promise<SpiceProcessResult>;
}

const SAFE_NODE = /^[A-Za-z0-9_./:+-]+$/;
const SAFE_MODEL = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const GROUND = /^(?:gnd|ground|0)$/i;
const INPUT_PIN = /^(?:vi|vin|in|input)$/i;
const OUTPUT_PIN = /^(?:vo|vout|out|output)$/i;
const GROUND_PIN = /^(?:gnd|ground)$/i;

export function withinVoltageTolerance(measured: number, min: number, max: number): boolean {
  return Number.isFinite(measured) && Number.isFinite(min) && Number.isFinite(max) &&
    min <= measured && measured <= max;
}

export function formatRegulatorOpReport(report: RegulatorOpReport): string {
  if (!report.circuits.length) return 'SPICE: not checked (no linear regulators found)';
  return report.circuits.map((c) => {
    const head = `SPICE ${c.ref}${c.output ? ` (${c.output})` : ''}`;
    if (c.status === 'not_checked') return `${head}: not checked — ${c.detail}`;
    const bound = c.target !== undefined && c.min !== undefined && c.max !== undefined
      ? `; target ${c.target} V, tolerance ${c.min}–${c.max} V`
      : '';
    if (c.status === 'pass') return `${head}: PASS — ${c.measured} V${bound}`;
    return `${head}: FAIL — ${c.measured === undefined ? `${c.detail}${bound}` : `${c.measured} V${bound}`}`;
  }).join('\n');
}

const fail = (base: RegulatorOpCircuit, reason: NonNullable<RegulatorOpCircuit['reason']>, detail: string): RegulatorOpCircuit =>
  ({ ...base, status: 'fail', reason, detail });

function regulatorPins(ref: string, pins: PinNet[]): { input: string; output: string; ground: string; byNumber: Map<string, string> } | null {
  const own = pins.filter((p) => p.ref === ref);
  const input = own.find((p) => INPUT_PIN.test(p.pinName))?.net;
  const output = own.find((p) => OUTPUT_PIN.test(p.pinName))?.net;
  const ground = own.find((p) => GROUND_PIN.test(p.pinName))?.net;
  if (!input || !output || !ground || !GROUND.test(ground) ||
      ![input, output, ground].every((n) => SAFE_NODE.test(n))) return null;
  return { input, output, ground, byNumber: new Map(own.map((p) => [p.pinNumber, p.net ?? ''])) };
}

function declaredTarget(registry: ConstraintRegistry, ref: string, output: string):
  { target: number; min: number; max: number } | 'invalid' | null {
  const matches = Object.entries(registry).filter(([key, c]) =>
    /(?:voltage|vout|_v$)/i.test(key) && c.affects?.includes(ref) && c.affects?.includes(output));
  if (!matches.length) return null;
  if (matches.length !== 1) return 'invalid';
  const c = matches[0]![1];
  if (typeof c.value !== 'number' || typeof c.min !== 'number' || typeof c.max !== 'number' ||
      ![c.value, c.min, c.max].every(Number.isFinite) || c.min >= c.max ||
      c.min > c.value || c.value > c.max) return 'invalid';
  return { target: c.value, min: c.min, max: c.max };
}

function declaredSource(
  blocks: SimulationBlock[], input: string, output: string, sheet: string,
  target: { min: number; max: number },
): number | null {
  const matches = blocks.filter((b) => b.analysis === 'op' &&
    (b.scope.kind === 'nets' ? b.scope.nets.includes(input) && b.scope.nets.includes(output) : b.scope.sheet === sheet) &&
    b.sources.some((s) => s.port === input) &&
    b.assertions.some((a) => a.measurable.kind === 'voltage' && a.measurable.target === output &&
      a.comparator.kind === 'between' && a.comparator.lower.value === target.min &&
      a.comparator.upper.value === target.max));
  if (matches.length !== 1) return null;
  const sources = matches[0]!.sources.filter((s) => s.port === input);
  if (sources.length !== 1 || !['', 'v'].includes(sources[0]!.value.unit.toLowerCase())) return null;
  const voltage = sources[0]!.value.value;
  return Number.isFinite(voltage) && voltage > 0 ? voltage : null;
}

function modelPinOrder(mapping: string, nodes: Map<string, string>): string[] | null {
  const pairs = [...mapping.matchAll(/(\d+)\s*=\s*(\d+)/g)];
  if (pairs.length !== 3 || mapping.replace(/(\d+)\s*=\s*(\d+)/g, '').replace(/[\s,;]+/g, '') !== '') return null;
  const ordered: string[] = [];
  const schematicPins = new Set<string>();
  for (const pair of pairs) {
    const schematicPin = pair[1]!;
    const modelPin = Number(pair[2]);
    if (modelPin < 1 || modelPin > 3 || ordered[modelPin - 1] ||
        schematicPins.has(schematicPin) || !nodes.get(schematicPin)) return null;
    schematicPins.add(schematicPin);
    ordered[modelPin - 1] = nodes.get(schematicPin)!;
  }
  return ordered.length === 3 && ordered.every(Boolean) ? ordered.map((n) => GROUND.test(n) ? '0' : n) : null;
}

async function modelFor(
  repoRoot: string, schematic: string, symbol: SchematicSymbol, nodes: Map<string, string>,
): Promise<{ library: string; name: string; nodes: string[] } | string> {
  const model = symbol.simulation;
  if (!model?.library || !model.name || !model.pins || !SAFE_MODEL.test(model.name)) {
    return `${symbol.ref} has no usable KiCad Sim.Library, Sim.Name, and Sim.Pins mapping`;
  }
  const ordered = modelPinOrder(model.pins, nodes);
  if (!ordered) return `${symbol.ref} needs an explicit three-pin Sim.Pins model mapping`;
  const library = path.resolve(path.dirname(schematic), model.library);
  const root = await realpath(repoRoot);
  let resolved: string;
  try { resolved = await realpath(library); } catch { return `simulation model missing: ${model.library}`; }
  if (!resolved.startsWith(root + path.sep)) return `simulation model must be inside the repository: ${model.library}`;
  if (/["\r\n]/.test(resolved)) return `simulation model path cannot be used in a SPICE deck: ${model.library}`;
  let content: string;
  try { content = await readFile(resolved, 'utf8'); }
  catch { return `simulation model cannot be read: ${model.library}`; }
  const definition = content.split(/\r?\n/).find((line) =>
    new RegExp(`^\\s*\\.subckt\\s+${model.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i').test(line));
  if (!definition) return `subcircuit ${model.name} is absent from ${model.library}`;
  const ports = definition.trim().split(/\s+/).slice(2).filter((token) => !/^params:/i.test(token));
  if (ports.length !== 3) return `${model.name} is not a three-pin regulator model`;
  return { library: resolved, name: model.name, nodes: ordered };
}

/** Convert only a three-terminal linear regulator and its DC resistive load. */
export function regulatorDeck(
  symbol: SchematicSymbol, pins: PinNet[], model: { library: string; name: string; nodes: string[] },
  input: string, output: string, sourceVoltage: number, symbols: SchematicSymbol[],
): string {
  const lines = [`Copperhead DC regulator ${symbol.ref}`, `.include "${model.library.replace(/\\/g, '/')}"`,
    `V_COPPERHEAD ${input} 0 ${sourceVoltage}`, `X${symbol.ref} ${model.nodes.join(' ')} ${model.name}`];
  const byRef = new Map(symbols.map((s) => [s.ref, s]));
  for (const p of pins.filter((entry) => entry.net === output && entry.ref !== symbol.ref)) {
    const part = byRef.get(p.ref);
    if (!part || /^Connector/.test(part.libId) || part.libId === 'Device:C') continue;
    if (part.libId !== 'Device:R') throw new Error(`${p.ref} on ${output} has no supported DC model`);
    const ends = pins.filter((entry) => entry.ref === p.ref).map((entry) => entry.net);
    if (ends.length !== 2 || !ends.includes(output) || !ends.some((n) => n && GROUND.test(n))) {
      throw new Error(`${p.ref} is not a direct output-to-ground load; downstream circuit is not modeled`);
    }
    const value = parseSpiceNumber(part.value);
    if (value.value <= 0 || value.unit && value.unit.toLowerCase() !== 'ohm') {
      throw new Error(`${p.ref} has an unusable resistance value ${part.value}`);
    }
    lines.push(`${p.ref} ${output} 0 ${value.value}`);
  }
  lines.push('.control', 'op', `print v(${output})`, '.endc', '.end');
  return lines.join('\n') + '\n';
}

export function parseOperatingPoint(output: string, net: string): number | null {
  const escaped = net.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*v\\(${escaped}\\)\\s*=\\s*([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)\\b`, 'im').exec(output);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

async function executeDeck(deck: string, opts: RegulatorOpOptions): Promise<SpiceProcessResult> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-spice-'));
  const file = path.join(dir, 'regulator.cir');
  try {
    await writeFile(file, deck, 'utf8');
    const timeout = opts.timeoutMs ?? 10_000;
    if (opts.execute) return await opts.execute(opts.binary ?? process.env.COPPERHEAD_NGSPICE ?? 'ngspice', ['-b', file], timeout);
    const result = await execa(opts.binary ?? process.env.COPPERHEAD_NGSPICE ?? 'ngspice', ['-b', file],
      { reject: false, timeout });
    if (result.failed && isNotFoundError(result)) {
      throw Object.assign(new Error('ngspice not found'), { code: 'ENOENT' });
    }
    return { exitCode: result.exitCode ?? null, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runRegulatorOpCheck(
  repoRoot: string, schematic: string, docsDir: string, registry: ConstraintRegistry,
  opts: RegulatorOpOptions = {},
): Promise<RegulatorOpReport> {
  const [symbols, pins] = await Promise.all([listSymbols(schematic), pinNets(schematic)]);
  const regulators = symbols.filter((s) => s.libId.startsWith('Regulator_Linear:'));
  const docs = path.join(repoRoot, docsDir, 'SUBSYSTEMS.md');
  let blocks: SimulationBlock[] = [];
  let blockError: string | null = null;
  if (existsSync(docs)) {
    try { blocks = parseSimulationBlocks(await readFile(docs, 'utf8')); }
    catch (err) { blockError = (err as Error).message; }
  }
  const circuits: RegulatorOpCircuit[] = [];
  for (const symbol of regulators) {
    if (symbol.sheet !== '/') {
      circuits.push(fail({ ref: symbol.ref, output: null, status: 'not_checked' },
        'unsupported_circuit', 'this first DC slice requires a flat schematic with named regulator rails'));
      continue;
    }
    const rail = regulatorPins(symbol.ref, pins);
    const base: RegulatorOpCircuit = { ref: symbol.ref, output: rail?.output ?? null, status: 'not_checked' };
    if (!rail) {
      circuits.push(fail(base, 'unsupported_circuit', 'requires named input/output nets and a GND pin on a three-terminal linear regulator'));
      continue;
    }
    const target = declaredTarget(registry, symbol.ref, rail.output);
    if (target === null) {
      circuits.push({ ...base, reason: 'undeclared', detail: 'no output-voltage target and tolerance declared in constraints.json' });
      continue;
    }
    if (target === 'invalid') {
      circuits.push(fail(base, 'invalid_constraint', 'output-voltage constraint needs one numeric value, min, and max affecting this regulator and rail'));
      continue;
    }
    Object.assign(base, target);
    if (blockError) {
      circuits.push(fail(base, 'missing_source', `SUBSYSTEMS.md Simulation block: ${blockError}`));
      continue;
    }
    const source = declaredSource(blocks, rail.input, rail.output, symbol.sheet, target);
    if (source === null) {
      circuits.push(fail(base, 'missing_source',
        `declare one op Simulation block with source: ${rail.input}=<voltage> and V(${rail.output}) between ${target.min} and ${target.max} in SUBSYSTEMS.md`));
      continue;
    }
    const model = await modelFor(repoRoot, schematic, symbol, rail.byNumber);
    if (typeof model === 'string') {
      circuits.push(fail(base, 'missing_model', model));
      continue;
    }
    let deck: string;
    try { deck = regulatorDeck(symbol, pins, model, rail.input, rail.output, source, symbols); }
    catch (err) { circuits.push(fail(base, 'unsupported_circuit', (err as Error).message)); continue; }
    let result: SpiceProcessResult;
    try { result = await executeDeck(deck, opts); }
    catch (err) {
      const error = err as NodeJS.ErrnoException;
      const reason = error.code === 'ENOENT' ? 'missing_ngspice'
        : (error as NodeJS.ErrnoException & { timedOut?: boolean }).timedOut || error.code === 'ETIMEDOUT'
          ? 'timeout' : 'simulation_failed';
      circuits.push(fail(base, reason,
        reason === 'missing_ngspice' ? 'ngspice not found; install ngspice or set COPPERHEAD_NGSPICE' : error.message));
      continue;
    }
    const transcript = `${result.stdout}\n${result.stderr}`;
    if (result.timedOut) { circuits.push(fail(base, 'timeout', 'ngspice DC operating point timed out')); continue; }
    if (/no convergence|convergence failed|singular matrix|timestep too small/i.test(transcript)) {
      circuits.push(fail(base, 'non_convergence', transcript.trim().slice(-500))); continue;
    }
    if (/unknown subcircuit|model .*not found|could not find.*model|undefined model/i.test(transcript)) {
      circuits.push(fail(base, 'missing_model', transcript.trim().slice(-500))); continue;
    }
    const measured = parseOperatingPoint(transcript, rail.output);
    if (result.exitCode !== 0 || measured === null) {
      circuits.push(fail(base, 'simulation_failed', transcript.trim().slice(-500) || 'ngspice returned no operating-point voltage'));
      continue;
    }
    // Reuse the existing closed assertion grammar for inclusive voltage bounds.
    const assertion = parseSpiceAssertion(`V(${rail.output}) between ${target.min} and ${target.max}`);
    const comparator = assertion.comparator;
    if (comparator.kind !== 'between') throw new Error('expected between assertion');
    circuits.push(withinVoltageTolerance(measured, comparator.lower.value, comparator.upper.value)
      ? { ...base, status: 'pass', measured }
      : { ...base, status: 'fail', reason: 'out_of_tolerance', measured,
          detail: `${measured} V is outside ${target.min}–${target.max} V` });
  }
  return { ok: circuits.every((c) => c.status !== 'fail'), circuits };
}
