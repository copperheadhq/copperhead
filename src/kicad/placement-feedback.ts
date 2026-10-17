import { child, children, isList, parseSexp, type SexpNode } from './sexp.js';
import { moveFootprint } from './populate.js';
import {
  checkPlacementText,
  placementSummary,
  type PlacementCheckReport,
  type PlacementFinding,
} from './placement-checks.js';

/**
 * Closed-loop placement refinement for an already populated board.
 *
 * This module deliberately knows nothing about the initializer or legalizer
 * that produced the input.  The input bytes are checkpoint zero, every
 * candidate is evaluated in memory, and only strict non-regressing feedback
 * becomes the next checkpoint.
 */

export interface FeedbackPlacementOptions {
  /** Candidate evaluations, never milliseconds. Default 1,000. */
  evaluationBudget?: number;
  /** Coarse-to-fine translation steps in mm. Default 2, 1, 0.5, 0.25. */
  stepScheduleMm?: readonly number[];
  /** Try 90/180/270-degree rotations at the current origin. Default true. */
  allowRotations?: boolean;
  /** Additional footprints that must not move. */
  lockedRefs?: Iterable<string>;
  /** Exact KiCad net names guarded separately from total HPWL. */
  criticalNets?: Iterable<string>;
  /** Lock connectors, mounting holes and fiducials inferred from ref/id. Default true. */
  lockMechanical?: boolean;
}
export interface FeedbackPlacementMetrics {
  hardErrors: number;
  warnings: number;
  hpwlMm: number;
  criticalHpwlMm: number;
}

export interface FeedbackPlacementMove {
  evaluation: number;
  ref: string;
  operator: string;
  from: { x: number; y: number; rotation: number };
  to: { x: number; y: number; rotation: number };
  before: FeedbackPlacementMetrics;
  after: FeedbackPlacementMetrics;
}

export interface FeedbackPlacementReport {
  changed: boolean;
  deterministic: true;
  before: FeedbackPlacementMetrics;
  after: FeedbackPlacementMetrics;
  evaluationBudget: number;
  evaluated: number;
  /** Candidates that passed the cheap physical proxy and received exact universal checks. */
  exactEvaluated: number;
  accepted: number;
  rejected: number;
  plateauStepsMm: number[];
  stopReason: 'local-optimum' | 'evaluation-budget' | 'no-movable-parts';
  lockedRefs: string[];
  criticalNets: string[];
  operatorStats: { operator: string; evaluated: number; accepted: number }[];
  rejectionCounts: { reason: string; count: number }[];
  moves: FeedbackPlacementMove[];
}

export interface FeedbackPlacementResult {
  boardText: string;
  report: FeedbackPlacementReport;
}

interface Node {
  ref: string;
  footprint: string;
  x: number;
  y: number;
  rotation: number;
  nets: string[];
}

interface Measurement {
  report: PlacementCheckReport;
  hardKeys: string[];
  warningKeys: string[];
  /** Summed finding magnitude per key; a key absent here carries no magnitude. */
  magnitudes: Map<string, number>;
  metrics: FeedbackPlacementMetrics;
  netHpwlMm: Record<string, number>;
  proxy: ProxyMeasurement;
}

interface ProxyMeasurement {
  hpwlMm: number;
  criticalHpwlMm: number;
  netHpwlMm: Record<string, number>;
}

interface Candidate {
  operator: string;
  x: number;
  y: number;
  rotation: number;
}

const DEFAULT_STEPS = [2, 1, 0.5, 0.25] as const;
const DEFAULT_BUDGET = 1_000;
const POSITION_DIGITS = 4;
const EPS = 1e-6;
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round = (value: number, digits = 6): number => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;
const mod = (value: number, by: number): number => ((value % by) + by) % by;
const atom = (node: SexpNode[] | undefined, index: number): string | undefined => {
  const value = node?.[index];
  return typeof value === 'string' ? value : undefined;
};

function property(fp: SexpNode[], name: string): string {
  for (const entry of children(fp, 'property')) if (atom(entry, 1) === name) return atom(entry, 2) ?? '';
  for (const entry of children(fp, 'fp_text')) if (atom(entry, 1) === name.toLowerCase()) return atom(entry, 2) ?? '';
  return '';
}

function topology(boardText: string): Node[] {
  const root = parseSexp(boardText)[0];
  if (!root || !isList(root) || root[0] !== 'kicad_pcb') throw new Error('not a KiCad PCB s-expression file');
  const nodes: Node[] = [];
  for (const fp of children(root, 'footprint')) {
    const ref = property(fp, 'Reference');
    const at = child(fp, 'at');
    const x = Number(atom(at, 1));
    const y = Number(atom(at, 2));
    const rotation = Number(atom(at, 3) ?? 0);
    if (!ref || ![x, y, rotation].every(Number.isFinite)) continue;
    const nets = new Set<string>();
    for (const pad of children(fp, 'pad')) {
      const net = child(pad, 'net');
      const name = (net && net.length >= 3 ? atom(net, 2) : atom(net, 1)) ?? '';
      if (name) nets.add(name);
    }
    nodes.push({
      ref,
      footprint: atom(fp, 1) ?? '',
      x,
      y,
      rotation: mod(rotation, 360),
      nets: [...nets].sort(byCodeUnit),
    });
  }
  return nodes.sort((a, b) => byCodeUnit(a.ref, b.ref));
}

function findingKey(finding: PlacementFinding): string {
  return `${finding.id}\0${[...finding.refs].sort(byCodeUnit).join(',')}`;
}

function measurement(boardText: string, criticalNets: readonly string[], proxy?: ProxyMeasurement): Measurement {
  const report = checkPlacementText(boardText);
  // A candidate reaches this exact checker only after its physical-pad HPWL
  // proxy has already parsed every pad and net. Reuse that measurement instead
  // of parsing the complete board a second time for the same data.
  const physical = proxy ?? proxyMeasurement(boardText, criticalNets);
  const hardKeys = [...new Set(report.errors.map(findingKey))].sort(byCodeUnit);
  const warningKeys = [...new Set(report.warnings.map(findingKey))].sort(byCodeUnit);
  const magnitudes = new Map<string, number>();
  for (const finding of [...report.errors, ...report.warnings]) {
    if (finding.magnitude === undefined) continue;
    const key = findingKey(finding);
    magnitudes.set(key, round((magnitudes.get(key) ?? 0) + finding.magnitude));
  }
  return {
    report,
    hardKeys,
    warningKeys,
    magnitudes,
    metrics: {
      hardErrors: hardKeys.length,
      warnings: warningKeys.length,
      hpwlMm: round(report.metrics.hpwlMm),
      criticalHpwlMm: physical.criticalHpwlMm,
    },
    netHpwlMm: physical.netHpwlMm,
    proxy: physical,
  };
}

/** Cheap enough for every trial; exact polygons/pad checks run only after this gate. */
function proxyMeasurement(boardText: string, criticalNets: readonly string[]): ProxyMeasurement {
  const summary = placementSummary(boardText);
  return {
    hpwlMm: round(Object.values(summary.netHpwlMm).reduce((sum, value) => sum + value, 0)),
    criticalHpwlMm: round(criticalNets.reduce((sum, net) => sum + (summary.netHpwlMm[net] ?? 0), 0)),
    netHpwlMm: summary.netHpwlMm,
  };
}

function proxyAccepts(current: ProxyMeasurement, candidate: ProxyMeasurement, criticalNets: readonly string[]): { ok: boolean; reason: string } {
  if (candidate.hpwlMm > current.hpwlMm + EPS) return { ok: false, reason: 'hpwl-regression' };
  if (candidate.criticalHpwlMm > current.criticalHpwlMm + EPS) return { ok: false, reason: 'critical-hpwl-regression' };
  if (criticalNets.some((net) => (candidate.netHpwlMm[net] ?? 0) > (current.netHpwlMm[net] ?? 0) + EPS)) {
    return { ok: false, reason: 'critical-net-regression' };
  }
  return { ok: true, reason: 'candidate' };
}

function isSubset(candidate: readonly string[], current: readonly string[]): boolean {
  const allowed = new Set(current);
  return candidate.every((entry) => allowed.has(entry));
}

function continuousPlacementRegression(current: PlacementCheckReport, candidate: PlacementCheckReport): string | null {
  const nextDecoupling = new Map(
    candidate.metrics.decoupling.map((entry) => [`${entry.ref}\0${entry.rail}`, entry.distanceMm] as const),
  );
  for (const entry of current.metrics.decoupling) {
    const next = nextDecoupling.get(`${entry.ref}\0${entry.rail}`);
    if (entry.distanceMm !== null && next !== undefined && next !== null && next > entry.distanceMm + EPS) {
      return 'decoupling-distance-regression';
    }
  }
  const currentMedian = current.metrics.medianDecouplingMm;
  const candidateMedian = candidate.metrics.medianDecouplingMm;
  if (currentMedian !== null && candidateMedian !== null && candidateMedian > currentMedian + EPS) {
    return 'decoupling-median-regression';
  }

  const nextCrystals = new Map(candidate.metrics.crystals.map((entry) => [entry.ref, [...entry.distancesMm].sort((a, b) => a - b)]));
  for (const entry of current.metrics.crystals) {
    const before = [...entry.distancesMm].sort((a, b) => a - b);
    const next = nextCrystals.get(entry.ref);
    if (!next || next.length !== before.length || next.some((distance, index) => distance > before[index]! + EPS)) {
      return 'crystal-distance-regression';
    }
  }
  return null;
}

/**
 * A finding that persists must not grow: an edge connector drifting further
 * from the edge keeps the same id and refs, so key identity alone would miss it.
 */
function worsenedFinding(current: Measurement, candidate: Measurement, keys: readonly string[]): boolean {
  return keys.some((key) => (candidate.magnitudes.get(key) ?? 0) > (current.magnitudes.get(key) ?? 0) + EPS);
}

function lessenedFinding(current: Measurement, candidate: Measurement): boolean {
  return [...current.magnitudes].some(([key, magnitude]) => (candidate.magnitudes.get(key) ?? 0) < magnitude - EPS);
}

function accepts(current: Measurement, candidate: Measurement): { ok: boolean; reason: string } {
  if (!isSubset(candidate.hardKeys, current.hardKeys)) return { ok: false, reason: 'new-hard-finding' };
  if (!isSubset(candidate.warningKeys, current.warningKeys)) return { ok: false, reason: 'new-soft-finding' };
  if (worsenedFinding(current, candidate, candidate.hardKeys)) return { ok: false, reason: 'worsened-hard-finding' };
  if (worsenedFinding(current, candidate, candidate.warningKeys)) return { ok: false, reason: 'worsened-soft-finding' };
  const distanceRegression = continuousPlacementRegression(current.report, candidate.report);
  if (distanceRegression) return { ok: false, reason: distanceRegression };
  if (candidate.metrics.hpwlMm > current.metrics.hpwlMm + EPS) return { ok: false, reason: 'hpwl-regression' };
  if (candidate.metrics.criticalHpwlMm > current.metrics.criticalHpwlMm + EPS) return { ok: false, reason: 'critical-hpwl-regression' };
  const improved =
    candidate.hardKeys.length < current.hardKeys.length ||
    candidate.warningKeys.length < current.warningKeys.length ||
    lessenedFinding(current, candidate) ||
    candidate.metrics.hpwlMm < current.metrics.hpwlMm - EPS ||
    candidate.metrics.criticalHpwlMm < current.metrics.criticalHpwlMm - EPS;
  return improved ? { ok: true, reason: 'improved' } : { ok: false, reason: 'no-strict-improvement' };
}

function inferredMechanical(node: Node): boolean {
  return /^(J|H|FID|MH)\d/i.test(node.ref) || /Connector|MountingHole|Fiducial/i.test(node.footprint);
}

function netMaps(nodes: readonly Node[]): { byNet: Map<string, Node[]>; byRef: Map<string, Node> } {
  const byNet = new Map<string, Node[]>();
  const byRef = new Map(nodes.map((node) => [node.ref, node]));
  for (const node of nodes) for (const net of node.nets) byNet.set(net, [...(byNet.get(net) ?? []), node]);
  for (const members of byNet.values()) members.sort((a, b) => byCodeUnit(a.ref, b.ref));
  return { byNet, byRef };
}

function connectedTarget(node: Node, byNet: ReadonlyMap<string, Node[]>, critical: ReadonlySet<string>): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let total = 0;
  for (const net of node.nets) {
    const others = (byNet.get(net) ?? []).filter((member) => member.ref !== node.ref);
    if (!others.length) continue;
    const netWeight = (critical.has(net) ? 4 : 1) / others.length;
    for (const other of others) {
      x += other.x * netWeight;
      y += other.y * netWeight;
      total += netWeight;
    }
  }
  return total ? { x: x / total, y: y / total } : null;
}

const shift = (value: number, delta: number): number => round(value + delta, POSITION_DIGITS);

function candidates(node: Node, step: number, byNet: ReadonlyMap<string, Node[]>, critical: ReadonlySet<string>, allowRotations: boolean): Candidate[] {
  const out: Candidate[] = [];
  const target = connectedTarget(node, byNet, critical);
  if (target) {
    const dx = Math.max(-step, Math.min(step, target.x - node.x));
    const dy = Math.max(-step, Math.min(step, target.y - node.y));
    out.push({ operator: 'toward-connected', x: shift(node.x, dx), y: shift(node.y, dy), rotation: node.rotation });
    out.push({ operator: 'toward-connected-x', x: shift(node.x, dx), y: node.y, rotation: node.rotation });
    out.push({ operator: 'toward-connected-y', x: node.x, y: shift(node.y, dy), rotation: node.rotation });
  }
  const directions: [string, number, number][] = [
    ['left', -1, 0],
    ['right', 1, 0],
    ['up', 0, -1],
    ['down', 0, 1],
    ['up-left', -1, -1],
    ['up-right', 1, -1],
    ['down-left', -1, 1],
    ['down-right', 1, 1],
  ];
  for (const [operator, dx, dy] of directions) {
    out.push({ operator, x: shift(node.x, dx * step), y: shift(node.y, dy * step), rotation: node.rotation });
  }
  if (allowRotations) {
    for (const delta of [90, 180, 270]) {
      out.push({ operator: `rotate-${delta}`, x: node.x, y: node.y, rotation: mod(node.rotation + delta, 360) });
    }
  }
  const seen = new Set<string>();
  return out.filter((candidate) => {
    const key = `${candidate.x}\0${candidate.y}\0${candidate.rotation}`;
    if (seen.has(key) || (candidate.x === node.x && candidate.y === node.y && candidate.rotation === node.rotation)) return false;
    seen.add(key);
    return true;
  });
}

function prioritizedRefs(nodes: readonly Node[], current: Measurement, locked: ReadonlySet<string>): string[] {
  const errors = new Set(current.report.errors.flatMap((finding) => finding.refs));
  const priority = new Map<string, number>();
  for (const node of nodes) {
    let incident = 0;
    for (const net of node.nets) incident += current.netHpwlMm[net] ?? 0;
    priority.set(node.ref, incident);
  }
  return nodes
    .filter((node) => !locked.has(node.ref) && (node.nets.length > 0 || errors.has(node.ref)))
    .sort((a, b) => Number(errors.has(b.ref)) - Number(errors.has(a.ref)) || (priority.get(b.ref) ?? 0) - (priority.get(a.ref) ?? 0) || byCodeUnit(a.ref, b.ref))
    .map((node) => node.ref);
}

function validBudget(value: number | undefined): number {
  const budget = value ?? DEFAULT_BUDGET;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 1_000_000) throw new Error('evaluationBudget must be an integer from 1 to 1000000');
  return budget;
}

function validSteps(values: readonly number[] | undefined): number[] {
  const steps = [...(values ?? DEFAULT_STEPS)];
  if (!steps.length || steps.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('stepScheduleMm must contain positive finite numbers');
  return steps.map((value) => round(value, POSITION_DIGITS));
}

/** Optimize a board entirely in memory; callers own spec/DRC/write gating. */
export function optimizePlacementText(boardText: string, options: FeedbackPlacementOptions = {}): FeedbackPlacementResult {
  const evaluationBudget = validBudget(options.evaluationBudget);
  const steps = validSteps(options.stepScheduleMm);
  const criticalNets = [...new Set(options.criticalNets ?? [])].filter(Boolean).sort(byCodeUnit);
  const critical = new Set(criticalNets);
  const explicitLocks = new Set([...new Set(options.lockedRefs ?? [])].filter(Boolean));
  const firstNodes = topology(boardText);
  const locked = new Set(firstNodes.filter((node) => (options.lockMechanical ?? true) && inferredMechanical(node)).map((node) => node.ref));
  for (const ref of explicitLocks) locked.add(ref);

  let currentText = boardText;
  let current = measurement(boardText, criticalNets);
  const routed = Object.entries(current.report.metrics.copper).filter(([, count]) => count > 0);
  if (routed.length) {
    throw new Error(
      `feedback placement only supports unrouted boards; found ${routed.map(([kind, count]) => `${count} ${kind}`).join(', ')}`,
    );
  }
  const before = current.metrics;
  let evaluated = 0;
  let exactEvaluated = 0;
  let rejected = 0;
  const moves: FeedbackPlacementMove[] = [];
  const plateauStepsMm: number[] = [];
  const operator = new Map<string, { evaluated: number; accepted: number }>();
  const rejection = new Map<string, number>();
  let movableSeen = false;

  search: for (const step of steps) {
    let improvedAtStep = false;
    let restart = true;
    while (restart && evaluated < evaluationBudget) {
      restart = false;
      const nodes = topology(currentText);
      const { byNet, byRef } = netMaps(nodes);
      const refs = prioritizedRefs(nodes, current, locked);
      if (refs.length) movableSeen = true;
      for (const ref of refs) {
        const node = byRef.get(ref)!;
        const proposed = candidates(node, step, byNet, critical, options.allowRotations ?? true).sort((a, b) => {
          const ac = operator.get(a.operator)?.accepted ?? 0;
          const bc = operator.get(b.operator)?.accepted ?? 0;
          return bc - ac;
        });
        for (const candidate of proposed) {
          if (evaluated >= evaluationBudget) break search;
          evaluated++;
          const stats = operator.get(candidate.operator) ?? { evaluated: 0, accepted: 0 };
          stats.evaluated++;
          operator.set(candidate.operator, stats);
          let candidateText: string;
          try {
            candidateText = moveFootprint(currentText, ref, candidate.x, candidate.y, candidate.rotation);
          } catch {
            rejected++;
            rejection.set('invalid-transform', (rejection.get('invalid-transform') ?? 0) + 1);
            continue;
          }
          const proxy = proxyMeasurement(candidateText, criticalNets);
          const proxyVerdict = proxyAccepts(current.proxy, proxy, criticalNets);
          if (!proxyVerdict.ok) {
            rejected++;
            rejection.set(proxyVerdict.reason, (rejection.get(proxyVerdict.reason) ?? 0) + 1);
            continue;
          }
          exactEvaluated++;
          const measured = measurement(candidateText, criticalNets, proxy);
          const verdict = accepts(current, measured);
          if (!verdict.ok) {
            rejected++;
            rejection.set(verdict.reason, (rejection.get(verdict.reason) ?? 0) + 1);
            continue;
          }
          moves.push({
            evaluation: evaluated,
            ref,
            operator: candidate.operator,
            from: { x: node.x, y: node.y, rotation: node.rotation },
            to: { x: candidate.x, y: candidate.y, rotation: candidate.rotation },
            before: current.metrics,
            after: measured.metrics,
          });
          stats.accepted++;
          currentText = candidateText;
          current = measured;
          improvedAtStep = true;
          restart = true;
          break;
        }
        if (restart) break;
      }
    }
    if (!improvedAtStep) plateauStepsMm.push(step);
  }

  const stopReason: FeedbackPlacementReport['stopReason'] = !movableSeen
    ? 'no-movable-parts'
    : evaluated >= evaluationBudget
      ? 'evaluation-budget'
      : 'local-optimum';
  return {
    boardText: currentText,
    report: {
      changed: currentText !== boardText,
      deterministic: true,
      before,
      after: current.metrics,
      evaluationBudget,
      evaluated,
      exactEvaluated,
      accepted: moves.length,
      rejected,
      plateauStepsMm,
      stopReason,
      lockedRefs: [...locked].sort(byCodeUnit),
      criticalNets,
      operatorStats: [...operator.entries()]
        .sort(([a], [b]) => byCodeUnit(a, b))
        .map(([name, stats]) => ({ operator: name, ...stats })),
      rejectionCounts: [...rejection.entries()]
        .sort(([a], [b]) => byCodeUnit(a, b))
        .map(([reason, count]) => ({ reason, count })),
      moves,
    },
  };
}

export function formatFeedbackPlacement(report: FeedbackPlacementReport): string {
  const delta = (after: number, before: number): string => `${round(after - before) >= 0 ? '+' : ''}${round(after - before)}`;
  return [
    `feedback placement: ${report.changed ? 'IMPROVED' : 'UNCHANGED'} — ${report.accepted} accepted / ${report.evaluated} evaluated; ${report.exactEvaluated} exact checks (${report.stopReason})`,
    `  hard findings: ${report.before.hardErrors} → ${report.after.hardErrors}; warnings: ${report.before.warnings} → ${report.after.warnings}`,
    `  HPWL: ${report.before.hpwlMm} → ${report.after.hpwlMm} mm (${delta(report.after.hpwlMm, report.before.hpwlMm)})`,
    ...(report.criticalNets.length
      ? [`  critical HPWL: ${report.before.criticalHpwlMm} → ${report.after.criticalHpwlMm} mm (${delta(report.after.criticalHpwlMm, report.before.criticalHpwlMm)})`]
      : []),
    `  immutable fallback: ${report.changed ? 'input retained as checkpoint zero' : 'input bytes returned unchanged'}`,
  ].join('\n');
}
