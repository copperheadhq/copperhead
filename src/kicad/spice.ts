/**
 * Parser and assertion compiler for the opt-in SPICE verification gate.
 *
 * This module is deliberately pure: it reads strings and produces data or
 * ngspice deck fragments. Process execution belongs to `spice-run.ts`.
 */

export type SpiceAnalysis = 'op' | 'dc' | 'ac' | 'tran';

export type SimulationScope =
  | { kind: 'sheet'; sheet: string }
  | { kind: 'nets'; nets: string[] };

export interface SpiceNumber {
  raw: string;
  value: number;
  unit: string;
}

export type SpiceMeasurable =
  | { kind: 'voltage'; target: string }
  | { kind: 'current'; target: string }
  | { kind: 'corner'; target: string };

export type SpiceComparator =
  | { kind: 'between'; lower: SpiceNumber; upper: SpiceNumber }
  | { kind: 'less-than'; bound: SpiceNumber }
  | { kind: 'greater-than'; bound: SpiceNumber };

export interface SimulationAssertion {
  raw: string;
  line: number;
  measurable: SpiceMeasurable;
  comparator: SpiceComparator;
}

export interface SimulationSource {
  port: string;
  value: SpiceNumber;
  line: number;
}

export interface SimulationBlock {
  line: number;
  scope: SimulationScope;
  analysis: SpiceAnalysis;
  sources: SimulationSource[];
  assertions: SimulationAssertion[];
}

export interface CompiledSpiceAssertion {
  valueName: string;
  checks: Array<{
    name: string;
    pass: 'nonnegative' | 'positive';
  }>;
  lines: string[];
  deck: string;
}

export class SimulationParseError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = 'SimulationParseError';
    this.line = line;
  }
}

const ANALYSES = new Set<SpiceAnalysis>(['op', 'dc', 'ac', 'tran']);
const SAFE_TARGET = /^[A-Za-z0-9_./:+-]+$/;
const SAFE_MEASURE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SI_MULTIPLIERS: Readonly<Record<string, number>> = {
  '': 1,
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
};

/** Parse a SPICE-style number while preserving the original safe literal. */
export function parseSpiceNumber(raw: string, line = 1): SpiceNumber {
  const token = raw.trim();
  const match =
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?([a-z]*)$/i.exec(
      token,
    );
  if (!match) {
    throw new SimulationParseError(line, `invalid SPICE number "${raw}"`);
  }

  const base = Number(match[1]);
  const suffix = (match[2] ?? '').toLowerCase();
  // The regex limits suffixes to keys in SI_MULTIPLIERS.
  const multiplier = SI_MULTIPLIERS[suffix]!;

  const value = base * multiplier;
  if (!Number.isFinite(value)) {
    throw new SimulationParseError(line, `SPICE number is out of range "${raw}"`);
  }

  return {
    raw: token,
    value,
    unit: match[3] ?? '',
  };
}

/** Parse one assertion from the closed grammar in the SPICE delta spec. */
export function parseSpiceAssertion(raw: string, line = 1): SimulationAssertion {
  const text = raw.trim();
  const measurableMatch = /^(V|I|corner)\(([^()\s]+)\)\s+(.+)$/i.exec(text);
  if (!measurableMatch) {
    throw new SimulationParseError(line, `invalid SPICE assertion "${raw}"`);
  }

  const target = measurableMatch[2]!;
  if (!SAFE_TARGET.test(target)) {
    throw new SimulationParseError(line, `invalid measurable target "${target}"`);
  }

  const measurableToken = measurableMatch[1]!.toLowerCase();
  const measurable: SpiceMeasurable =
    measurableToken === 'v'
      ? { kind: 'voltage', target }
      : measurableToken === 'i'
        ? { kind: 'current', target }
        : { kind: 'corner', target };

  const comparatorText = measurableMatch[3]!.trim();
  const betweenMatch = /^between\s+(\S+)\s+and\s+(\S+)$/i.exec(comparatorText);
  let comparator: SpiceComparator;

  if (betweenMatch) {
    const lower = parseSpiceNumber(betweenMatch[1]!, line);
    const upper = parseSpiceNumber(betweenMatch[2]!, line);
    if (lower.unit.toLowerCase() !== upper.unit.toLowerCase()) {
      throw new SimulationParseError(line, 'between bounds use different units');
    }
    if (lower.value >= upper.value) {
      throw new SimulationParseError(line, 'between lower bound must be less than upper bound');
    }
    comparator = { kind: 'between', lower, upper };
  } else {
    const singleMatch = /^([<>])\s*(\S+)$/.exec(comparatorText);
    if (!singleMatch) {
      throw new SimulationParseError(line, `invalid comparator "${comparatorText}"`);
    }
    const bound = parseSpiceNumber(singleMatch[2]!, line);
    comparator =
      singleMatch[1] === '<'
        ? { kind: 'less-than', bound }
        : { kind: 'greater-than', bound };
  }

  return { raw: text, line, measurable, comparator };
}

/**
 * Parse every `## Simulation` section from SUBSYSTEMS.md.
 *
 * Fields are line-oriented so errors can always identify the source line.
 */
export function parseSimulationBlocks(markdown: string): SimulationBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: SimulationBlock[] = [];
  let openFence: string | null = null;
  let inDocumentComment = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    const fence = markdownFence(line);
    if (openFence) {
      if (fence) openFence = toggleFence(openFence, fence);
      continue;
    }
    if (inDocumentComment) {
      if (line.includes('-->')) inDocumentComment = false;
      continue;
    }
    if (fence) {
      openFence = fence;
      continue;
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inDocumentComment = true;
      continue;
    }
    if (!/^##\s+Simulation\s*$/i.test(line)) continue;

    const headingLine = index + 1;
    const body: Array<{ text: string; line: number }> = [];
    let cursor = index + 1;
    let inComment = false;
    let bodyFence: string | null = null;

    for (; cursor < lines.length; cursor++) {
      const text = lines[cursor]!;
      const trimmed = text.trim();
      const bodyFenceMarker = markdownFence(trimmed);
      if (bodyFence) {
        if (bodyFenceMarker) bodyFence = toggleFence(bodyFence, bodyFenceMarker);
        continue;
      }
      if (inComment) {
        if (trimmed.includes('-->')) inComment = false;
        continue;
      }
      if (bodyFenceMarker) {
        bodyFence = bodyFenceMarker;
        continue;
      }
      if (/^#{1,6}\s+/.test(trimmed)) break;

      if (trimmed.startsWith('<!--')) {
        if (!trimmed.includes('-->')) inComment = true;
        continue;
      }
      if (trimmed.startsWith('.') || /^[A-Za-z]+\s*:/.test(trimmed)) {
        body.push({ text: trimmed, line: cursor + 1 });
      }
    }

    blocks.push(parseSimulationBlock(body, headingLine));
    index = cursor - 1;
  }

  return blocks;
}

function markdownFence(line: string): string | null {
  return /^(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
}

function toggleFence(openFence: string | null, marker: string): string | null {
  if (!openFence) return marker;
  if (marker[0] === openFence[0] && marker.length >= openFence.length) return null;
  return openFence;
}

function parseSimulationBlock(
  body: Array<{ text: string; line: number }>,
  headingLine: number,
): SimulationBlock {
  let scope: SimulationScope | undefined;
  let analysis: SpiceAnalysis | undefined;
  const sources: SimulationSource[] = [];
  const assertions: SimulationAssertion[] = [];

  for (const entry of body) {
    if (entry.text.startsWith('.')) {
      throw new SimulationParseError(
        entry.line,
        `raw ngspice statement "${entry.text.split(/\s/, 1)[0]}" is not allowed`,
      );
    }

    const fieldMatch = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(entry.text);
    if (!fieldMatch) {
      throw new SimulationParseError(entry.line, `expected "field: value", got "${entry.text}"`);
    }

    const field = fieldMatch[1]!.toLowerCase();
    const value = fieldMatch[2]!.trim();

    switch (field) {
      case 'scope':
        if (scope) throw new SimulationParseError(entry.line, 'duplicate scope');
        scope = parseScope(value, entry.line);
        break;
      case 'analysis': {
        if (analysis) throw new SimulationParseError(entry.line, 'duplicate analysis');
        const candidate = value.toLowerCase();
        if (!ANALYSES.has(candidate as SpiceAnalysis)) {
          throw new SimulationParseError(entry.line, `unsupported analysis "${value}"`);
        }
        analysis = candidate as SpiceAnalysis;
        break;
      }
      case 'source':
      case 'sources':
        sources.push(parseSource(value, entry.line));
        break;
      case 'assert':
        assertions.push(parseSpiceAssertion(value, entry.line));
        break;
      default:
        throw new SimulationParseError(entry.line, `unknown Simulation field "${field}"`);
    }
  }

  if (!scope) throw new SimulationParseError(headingLine, 'Simulation block is missing scope');
  if (!analysis) throw new SimulationParseError(headingLine, 'Simulation block is missing analysis');
  if (assertions.length === 0) {
    throw new SimulationParseError(headingLine, 'Simulation block needs at least one assertion');
  }
  for (const assertion of assertions) {
    if (assertion.measurable.kind === 'corner' && analysis !== 'ac') {
      throw new SimulationParseError(assertion.line, 'corner() requires an ac analysis');
    }
  }
  if (analysis === 'ac' && sources.length === 0) {
    // The first source carries the AC 1 stimulus; without one every AC node
    // voltage is 0 and no corner can ever be measured.
    throw new SimulationParseError(headingLine, 'ac analysis needs a source: line for the AC stimulus');
  }

  return { line: headingLine, scope, analysis, sources, assertions };
}

function parseScope(raw: string, line: number): SimulationScope {
  const match = /^(sheet|nets)(?:\s+(.*))?$/i.exec(raw);
  if (!match) {
    throw new SimulationParseError(line, 'scope must be "sheet <path>" or "nets <a>, <b>"');
  }

  const scopeValue = (match[2] ?? '').trim();
  if (match[1]!.toLowerCase() === 'sheet') {
    if (scopeValue.length === 0) {
      throw new SimulationParseError(line, 'sheet scope is empty');
    }
    return { kind: 'sheet', sheet: scopeValue };
  }

  const netList = scopeValue.replace(/^\[(.*)\]$/, '$1');
  const nets = netList
    .split(',')
    .map((net) => net.trim())
    .filter((net) => net.length > 0);
  if (nets.length === 0 || nets.some((net) => !SAFE_TARGET.test(net))) {
    throw new SimulationParseError(line, 'net scope must contain comma-separated net names');
  }
  return { kind: 'nets', nets: [...new Set(nets)] };
}

function parseSource(raw: string, line: number): SimulationSource {
  const match = /^([A-Za-z_][A-Za-z0-9_./:+-]*)\s*=\s*(\S+)$/.exec(raw);
  if (!match) {
    throw new SimulationParseError(line, 'source must be "<port>=<number>"');
  }
  return {
    port: match[1]!,
    value: parseSpiceNumber(match[2]!, line),
    line,
  };
}

/**
 * Compile a parsed assertion to one value measure and one or two margin
 * measures. Inclusive bounds pass at zero; strict bounds must be positive.
 */
export function compileSpiceAssertion(
  assertion: SimulationAssertion,
  analysis: SpiceAnalysis,
  name = `assertion_${assertion.line}`,
  /** op/dc: the sweep value the operating point is read at (the first source's value). */
  sweepAt = 0,
): CompiledSpiceAssertion {
  if (!SAFE_MEASURE_NAME.test(name)) {
    throw new SimulationParseError(assertion.line, `invalid measure name "${name}"`);
  }

  // ngspice's .meas accepts only tran, ac, dc and sp, so op is measured on a
  // narrow DC sweep around the declared operating point (see spiceAnalysisCard).
  const measAnalysis = spiceMeasureAnalysis(analysis);
  let valueLine: string;
  if (assertion.measurable.kind === 'corner') {
    if (analysis !== 'ac') {
      throw new SimulationParseError(assertion.line, 'corner() requires an ac analysis');
    }
    valueLine = `.meas ac ${name}_value WHEN vdb(${assertion.measurable.target})=-3 FALL=1`;
  } else {
    const expression =
      assertion.measurable.kind === 'voltage'
        ? `v(${assertion.measurable.target})`
        : spiceCurrentVector(assertion.measurable.target);
    const operation =
      measAnalysis === 'dc' ? `FIND ${expression} AT=${spiceLiteral(sweepAt)}` : `AVG ${expression}`;
    valueLine = `.meas ${measAnalysis} ${name}_value ${operation}`;
  }

  const valueName = `${name}_value`;
  const marginExpressions =
    assertion.comparator.kind === 'between'
      ? [
          [`${name}_lower_margin`, `${valueName} - ${assertion.comparator.lower.raw}`],
          [`${name}_upper_margin`, `${assertion.comparator.upper.raw} - ${valueName}`],
        ]
      : assertion.comparator.kind === 'less-than'
        ? [[`${name}_margin`, `${assertion.comparator.bound.raw} - ${valueName}`]]
        : [[`${name}_margin`, `${valueName} - ${assertion.comparator.bound.raw}`]];

  const checks = marginExpressions.map(([checkName]) => ({
    name: checkName!,
    pass: assertion.comparator.kind === 'between' ? ('nonnegative' as const) : ('positive' as const),
  }));
  const checkLines = marginExpressions.map(
    ([checkName, expression]) => `.meas ${measAnalysis} ${checkName} PARAM='${expression}'`,
  );
  const compiledLines = [valueLine, ...checkLines];

  return {
    valueName,
    checks,
    lines: compiledLines,
    deck: compiledLines.join('\n'),
  };
}

/** Stable measure prefix for assertion index `i` of a block starting at `line`. */
export function spiceMeasureName(line: number, index: number): string {
  return `a${line}_${index}`;
}

export function formatSpiceBound(assertion: SimulationAssertion): string {
  if (assertion.comparator.kind === 'between') {
    return `${assertion.comparator.lower.raw} .. ${assertion.comparator.upper.raw}`;
  }
  if (assertion.comparator.kind === 'less-than') {
    return `< ${assertion.comparator.bound.raw}`;
  }
  return `> ${assertion.comparator.bound.raw}`;
}

/** Drop a trailing `.end` so the gate can append sources, analysis, and measures. */
export function stripSpiceEnd(netlist: string): string {
  return netlist.replace(/^\s*\.end\b.*$/gim, '').trimEnd();
}

/** The `.meas` analysis type for a block analysis: ngspice cannot measure `op`. */
export function spiceMeasureAnalysis(analysis: SpiceAnalysis): 'dc' | 'ac' | 'tran' {
  return analysis === 'op' ? 'dc' : analysis;
}

/**
 * ngspice vector for `I(<refdes>)`. Only voltage sources have a branch
 * current `i(...)`; any other device exposes its current as `@ref[i]`, which
 * ngspice records only when it is named in a `.save` card.
 */
export function spiceCurrentVector(target: string): string {
  return /^v/i.test(target) ? `i(${target})` : `@${target}[i]`;
}

function sourceElementName(port: string): string {
  const token = port.replace(/[^A-Za-z0-9_]/g, '_');
  return `Vsrc_${token}`;
}

/** Swept by op/dc blocks that drive no port, so `.meas dc` has a sweep to read. */
export const SPICE_SWEEP_SOURCE = 'Vcopperhead_sweep copperhead_sweep 0 DC 0';

/** `ac` puts the AC 1 stimulus on the block's first source. */
export function spiceSourceCard(source: SimulationSource, ac = false): string {
  return `${sourceElementName(source.port)} ${source.port} 0 DC ${source.value.raw}${ac ? ' AC 1' : ''}`;
}

function spiceLiteral(n: number): string {
  return String(parseFloat(n.toPrecision(10)));
}

/** The op/dc sweep point: the first driven source's value, or 0 on the stand-in source. */
export function spiceSweepPoint(sources: SimulationSource[]): number {
  return sources[0]?.value.value ?? 0;
}

export function spiceAnalysisCard(analysis: SpiceAnalysis, sources: SimulationSource[]): string {
  switch (analysis) {
    case 'op':
    case 'dc': {
      // A three-point sweep centred on the declared value: the middle point is
      // solved exactly at that value, and FIND ... AT= needs it strictly inside
      // the swept interval (a one-point sweep reports "out of interval").
      const source = sources[0];
      const element = source ? sourceElementName(source.port) : 'Vcopperhead_sweep';
      const at = spiceSweepPoint(sources);
      const delta = Math.abs(at) * 1e-3 || 1e-3;
      return `.dc ${element} ${spiceLiteral(at - delta)} ${spiceLiteral(at + delta)} ${spiceLiteral(delta)}`;
    }
    case 'ac':
      return '.ac dec 10 1 1meg';
    case 'tran':
      return '.tran 1u 1m';
  }
}

export interface SpiceNetlistProblem {
  line: number;
  message: string;
}

const NETLIST_FORBIDDEN = /^\s*\.(control|endc|meas|measure)\b/i;
const NETLIST_INCLUDE = /^\s*\.(include|inc|lib)\s+("[^"]*"|'[^']*'|\S+)/i;

/**
 * Netlist (or included file) content the gate refuses before ngspice runs.
 * `.control` blocks execute interpreter commands (including `shell`) in batch
 * mode, and a netlist `.meas` could forge one of the gate's measure names.
 */
export function spiceNetlistProblems(netlist: string): SpiceNetlistProblem[] {
  const problems: SpiceNetlistProblem[] = [];
  netlist.split(/\r?\n/).forEach((text, index) => {
    const forbidden = NETLIST_FORBIDDEN.exec(text);
    if (forbidden) {
      problems.push({
        line: index + 1,
        message: `netlist line ${index + 1}: ".${forbidden[1]!.toLowerCase()}" is not allowed in a SPICE gate deck`,
      });
      return;
    }
    const include = NETLIST_INCLUDE.exec(text);
    if (include && /^[a-z][a-z0-9+.-]*:\/\//i.test(unquote(include[2]!))) {
      problems.push({
        line: index + 1,
        message: `netlist line ${index + 1}: .${include[1]!.toLowerCase()} of a URL is not allowed`,
      });
    }
  });
  return problems;
}

/** Paths named by `.include` / `.inc` / `.lib` cards, unquoted, in order. */
export function spiceIncludePaths(netlist: string): string[] {
  const out: string[] = [];
  for (const text of netlist.split(/\r?\n/)) {
    const include = NETLIST_INCLUDE.exec(text);
    if (include) out.push(unquote(include[2]!));
  }
  return out;
}

function unquote(token: string): string {
  return token.replace(/^(["'])(.*)\1$/, '$2');
}

export interface AssembledSpiceDeck {
  text: string;
  compiled: CompiledSpiceAssertion[];
}

/** Netlist + driven ports + analysis + `.meas` cards. Pure: no subprocess. */
export function assembleSpiceDeck(netlist: string, block: SimulationBlock): AssembledSpiceDeck {
  const sweepAt = spiceSweepPoint(block.sources);
  const compiled = block.assertions.map((assertion, index) =>
    compileSpiceAssertion(assertion, block.analysis, spiceMeasureName(block.line, index), sweepAt),
  );
  const deviceCurrents = [
    ...new Set(
      block.assertions
        .filter((a) => a.measurable.kind === 'current')
        .map((a) => spiceCurrentVector(a.measurable.target))
        .filter((v) => v.startsWith('@')),
    ),
  ];
  const sweeps = block.analysis === 'op' || block.analysis === 'dc';
  const text = [
    '* copperhead spice verification gate',
    '.options TEMP=27',
    stripSpiceEnd(netlist),
    '* driven ports',
    ...block.sources.map((source, index) => spiceSourceCard(source, block.analysis === 'ac' && index === 0)),
    ...(sweeps && block.sources.length === 0 ? [SPICE_SWEEP_SOURCE] : []),
    // Without `.save all` ngspice -b keeps no AC vectors for .meas to read;
    // device currents (`@r1[i]`) are recorded only when named here.
    ['.save all', ...deviceCurrents].join(' '),
    spiceAnalysisCard(block.analysis, block.sources),
    ...compiled.flatMap((c) => c.lines),
    '.end',
    '',
  ].join('\n');
  return { text, compiled };
}

/** Parse `name = 1.23e-3` lines from ngspice batch stdout. */
export function parseNgspiceMeasures(stdout: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match =
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
        line,
      );
    if (!match) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) out[match[1]!.toLowerCase()] = value;
  }
  return out;
}

export interface GateMeasures {
  values: Record<string, number>;
  /** Gate measure names printed more than once: the output cannot be trusted. */
  duplicates: string[];
}

/**
 * Read only the measures this deck compiled from ngspice stdout. Any other
 * `name = value` line (a banner, a stray echo) is ignored, and a gate name
 * that appears twice is reported instead of trusted.
 */
export function collectGateMeasures(stdout: string, compiled: CompiledSpiceAssertion[]): GateMeasures {
  const wanted = new Set(
    compiled.flatMap((c) => [c.valueName, ...c.checks.map((check) => check.name)]).map((n) => n.toLowerCase()),
  );
  const seen = new Map<string, number>();
  const values: Record<string, number> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    if (!wanted.has(name)) continue;
    seen.set(name, (seen.get(name) ?? 0) + 1);
    const parsed = parseNgspiceMeasures(line)[name];
    if (parsed !== undefined) values[name] = parsed;
  }
  const duplicates = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
  return { values, duplicates };
}

export type SpiceAssertionStatus = 'pass' | 'fail' | 'unrunnable';

export interface SpiceAssertionResult {
  assertion: string;
  status: SpiceAssertionStatus;
  measured?: number;
  bound?: string;
  detail: string;
  line: number;
}

const MARGIN_EPS = 1e-12;

export function evaluateSpiceBlock(
  block: SimulationBlock,
  measures: Record<string, number>,
): SpiceAssertionResult[] {
  return block.assertions.map((assertion, index) => {
    const compiled = compileSpiceAssertion(
      assertion,
      block.analysis,
      spiceMeasureName(block.line, index),
    );
    const bound = formatSpiceBound(assertion);
    const value = measures[compiled.valueName.toLowerCase()];
    if (value === undefined) {
      return {
        assertion: assertion.raw,
        status: 'fail',
        bound,
        detail: `no measured ${compiled.valueName}`,
        line: assertion.line,
      };
    }
    for (const check of compiled.checks) {
      const margin = measures[check.name.toLowerCase()];
      if (margin === undefined) {
        return {
          assertion: assertion.raw,
          status: 'fail',
          measured: value,
          bound,
          detail: `no measured ${check.name}`,
          line: assertion.line,
        };
      }
      const ok = check.pass === 'nonnegative' ? margin >= -MARGIN_EPS : margin > MARGIN_EPS;
      if (!ok) {
        return {
          assertion: assertion.raw,
          status: 'fail',
          measured: value,
          bound,
          detail: `${assertion.raw}: measured ${value} (bound ${bound})`,
          line: assertion.line,
        };
      }
    }
    return {
      assertion: assertion.raw,
      status: 'pass',
      measured: value,
      bound,
      detail: `${assertion.raw}: measured ${value}`,
      line: assertion.line,
    };
  });
}
