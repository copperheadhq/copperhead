/**
 * Routing orchestration shared by `copperhead pcb route`, the benchmark, and
 * (later) the closed loop: import the board, snapshot it, run the eligible
 * routers under the requested mode, materialize and verify every candidate,
 * score, rank, write the run directory, and return one Outcome.
 * LLM-free and network-free; only local engines run.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { copperStack, isThroughVia } from '../ir/layers.js';
import { defaultRoutingScoringFor } from '../verify/profiles/scoring/index.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { importBoard } from '../ir/kicad/import.js';
import { makeSnapshot, writeRunDir, DEFAULT_LIMITS, type ResourceLimits } from '../ir/snapshot.js';
import type { Outcome, LayoutStatus } from '../ir/status.js';
import { kicadCliVersion } from '../../kicad/cli.js';
import { loadProfile } from '../verify/profiles/index.js';
import { loadScoringProfile } from '../verify/profiles/scoring/index.js';
import { routingMetrics } from '../verify/metrics.js';
import { rank, type Ranking } from '../verify/scoring.js';
import { verifyDesign } from '../verify/index.js';
import type { Diagnostic } from '../verify/diagnostic.js';
import { EngineRegistry, DEFAULT_POLICY, type EnginePolicy } from './registry.js';
import { runRouting, dedupeCopper, type ExecutionMode, type Invocation } from './runner.js';
import { Budget } from './budget.js';
import { materialize, candidateFromRouting, type MaterializedCandidate } from './candidates.js';
import { defaultStagedPlan, type LayerPreference, type StagedPlan } from './plan.js';
import type { RoutingResult, RoutingStrategy } from './contracts.js';
import { ReferenceRouter, REFERENCE_ROUTER_MANIFEST } from './routers/reference/adapter.js';
import { FreeroutingRouter, FREEROUTING_MANIFEST } from './routers/freerouting/adapter.js';
import { KicadToolsRouter, KICAD_TOOLS_MANIFEST } from './routers/kicad-tools/adapter.js';
import { writeBoardRender } from './render.js';
import { OrthorouteRouter, ORTHOROUTE_MANIFEST } from './routers/orthoroute/adapter.js';

export interface RouteOptions {
  repoRoot: string;
  /** Absolute path of the board. */
  boardPath: string;
  projectPath?: string;
  runDir: string;
  /** Engine ids in preference order; default: every registered router. */
  routers?: string[];
  mode?: ExecutionMode;
  netNames?: string[];
  preserveExistingRoutes?: boolean;
  strategy?: RoutingStrategy;
  /** staged mode: nets routed after power and before the bulk, by name. */
  criticalNetNames?: string[];
  /** Layer-preference constraints, mapped onto the engines' layer settings. */
  layerPreferences?: LayerPreference[];
  seed?: number;
  limits?: Partial<ResourceLimits>;
  profile?: string;
  scoring?: string;
  policy?: EnginePolicy;
  maxParallel?: number;
  registry?: EngineRegistry;
  noKicad?: boolean;
  log?: (line: string) => void;
}

export interface RouteRun {
  outcome: Outcome<Diagnostic>;
  runDir: string;
  ranking: Ranking;
  invocations: Invocation<RoutingResult>[];
  candidates: MaterializedCandidate[];
  ineligible: { engineId: string; reasons: string[] }[];
  /** staged mode only. */
  plan?: StagedPlan;
}

/** The built-in routers, registered in preference order. */
export function defaultRegistry(repoRoot: string): EngineRegistry {
  const r = new EngineRegistry();
  r.register(new FreeroutingRouter({ repoRoot }), FREEROUTING_MANIFEST);
  r.register(new KicadToolsRouter({ repoRoot }), KICAD_TOOLS_MANIFEST);
  r.register(new OrthorouteRouter({ repoRoot }), ORTHOROUTE_MANIFEST);
  r.register(new ReferenceRouter(), REFERENCE_ROUTER_MANIFEST);
  return r;
}

export async function routeBoard(opts: RouteOptions): Promise<RouteRun> {
  const log = opts.log ?? (() => {});
  const text = await readFile(opts.boardPath, 'utf8');
  const projectPath = opts.projectPath ?? (existsSync(opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro')) ? opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro') : undefined);
  const projectText = projectPath ? await readFile(projectPath, 'utf8') : undefined;
  let kicadVersion = 'unknown';
  if (!opts.noKicad) {
    try {
      kicadVersion = await kicadCliVersion();
    } catch {
      kicadVersion = 'unknown';
    }
  }
  const { design, warnings } = importBoard({ boardText: text, boardPath: path.relative(opts.repoRoot, opts.boardPath), ...(projectText ? { projectText, projectPath: path.relative(opts.repoRoot, projectPath!) } : {}), kicadVersion, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) });
  for (const w of warnings) log(`import: ${w}`);
  const profile = loadProfile(design.board.fabricationProfile);
  const scoring = loadScoringProfile(opts.scoring ?? defaultRoutingScoringFor(copperStack(design).length));
  const netIds = opts.netNames ? design.nets.filter((n) => opts.netNames!.includes(n.name)).map((n) => n.id) : null;
  const snapshot = makeSnapshot(design, { kind: 'routing', netIds, region: null, preserveExistingRoutes: opts.preserveExistingRoutes ?? false }, { seed: opts.seed ?? 0, limits: { ...DEFAULT_LIMITS, ...opts.limits } });
  await mkdir(opts.runDir, { recursive: true });
  const run = await writeRunDir(opts.runDir, snapshot, [opts.boardPath, ...(projectPath ? [projectPath] : [])]);
  const registry = opts.registry ?? defaultRegistry(opts.repoRoot);
  const wanted = opts.routers ?? registry.list('router').map((e) => e.manifest.id);
  const engines = wanted.map((id) => registry.get(id)).filter((e): e is NonNullable<typeof e> => !!e);
  const unknown = wanted.filter((id) => !registry.get(id)).map((engineId) => ({ engineId, reasons: [`not registered (known: ${registry.list('router').map((e) => e.manifest.id).join(', ')})`] }));
  // gate before any engine runs: a board that fails pre-flight or placement is refused, not routed (RFC 11 §10.4)
  const pre = verifyDesign({ design, profile });
  if (!pre.gates.preflight.passed || !pre.gates.placement.passed) {
    const failures = [...pre.gates.preflight.failures, ...pre.gates.placement.failures];
    const outcome: Outcome<Diagnostic> = { status: 'REFUSE', summary: `${pre.gates.preflight.passed ? 'placement' : 'pre-flight'} gate failed before routing: ${[...new Set(failures.map((d) => d.code))].join(', ')}`, detail: failures.map((d) => `${d.code}${d.entityReferences.length ? ` [${d.entityReferences.slice(0, 4).join(', ')}]` : ''}: ${d.message}`), diagnostics: pre.diagnostics.filter((d) => d.severity !== 'info') };
    const ranking: Ranking = rank([], scoring);
    await writeFile(path.join(run.root, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
    await writeFile(path.join(run.root, 'outcome.json'), JSON.stringify({ ...outcome, diagnostics: outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, entityReferences: d.entityReferences })) }, null, 2), 'utf8');
    await writeBoardRender(run.root, design, pre.diagnostics, log);
    return { outcome, runDir: run.root, ranking, invocations: [], candidates: [], ineligible: unknown };
  }
  const budget = new Budget(snapshot.limits.engineSeconds, snapshot.limits.wallSeconds);
  const mode = opts.mode ?? 'single';
  const layers = opts.layerPreferences?.length ? Object.fromEntries(opts.layerPreferences.map((p) => [p.layerId, p.mode === 'off' ? { active: false } : p.mode === 'any' ? { active: true } : { active: true, preferredDirection: p.mode }])) : undefined;
  const strategy: RoutingStrategy = { ...(layers ? { layers } : {}), ...(opts.strategy ?? {}) };
  const plan = mode === 'staged' ? defaultStagedPlan(design, { engineIds: engines.map((e) => e.manifest.id), netIds, clearanceNm: design.board.rules.clearanceNm, ...(opts.strategy?.noGenerous ? { noGenerous: true } : {}), ...(opts.criticalNetNames ? { criticalNetNames: opts.criticalNetNames } : {}), ...(opts.layerPreferences ? { layerPreferences: opts.layerPreferences } : {}) }) : undefined;
  if (plan) {
    await writeFile(path.join(run.root, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    for (const st of plan.stages) log(`stage ${st.name}: ${st.netIds ? `${st.netIds.length} net(s)` : 'every owed net'} via ${st.engineIds.join(st.race ? ' | ' : ', ')}${st.strategy.trackWidthNm ? ` at ${st.strategy.trackWidthNm / 1e6} mm` : ''}`);
  }
  const res = await runRouting({
    run, sourceText: text, design, ...(projectText ? { projectText } : {}), snapshotFileHash: run.fileHash, snapshot, budget, engines, mode, ...(opts.policy ? { policy: opts.policy } : { policy: DEFAULT_POLICY }), ...(opts.maxParallel ? { maxParallel: opts.maxParallel } : {}),
    job: { scope: { netIds, region: null, preserveExistingRoutes: opts.preserveExistingRoutes ?? false }, strategy: { ...strategy, ...(opts.strategy ?? {}) }, hardConstraints: [], objectives: [], seed: opts.seed ?? 0, limits: snapshot.limits },
    ...(plan ? { stages: plan.stages.map((st) => ({ ...st, strategy: { ...strategy, ...st.strategy } })) } : {}),
    log,
  });
  const candidates: MaterializedCandidate[] = [];
  const scored = [];
  // the candidates come from the last stage that produced copper: the final stage, or, when the budget cut the run short
  // before it (B4), the last one that ran, whose composite is what the board would carry
  const judged = judgedStage(res.invocations);
  const stack = copperStack(design);
  for (const inv of res.invocations) {
    if (!inv.result || inv.snapshotViolation) continue;
    if (inv.result.status === 'failed' || inv.result.status === 'unsupported') continue;
    // an engine may only return through vias on this release: anything else is output the harness cannot represent (D2)
    const odd = inv.result.vias.find((v) => !isThroughVia(v, stack));
    if (odd) {
      inv.error = { kind: 'malformed-output', message: `via on net ${design.nets.find((n) => n.id === odd.netId)?.name ?? odd.netId} spans ${odd.layers[0]} to ${odd.layers[1]}; only through vias are supported` };
      inv.result = null;
      log(`${inv.engineId}: invalid output: ${inv.error.message}`);
      continue;
    }
    if (inv.stage && inv.stage.index !== judged) continue; // other stages are not candidates; their copper rides in the judged branches
    // a staged branch is the union of the carried stages and its own copper
    const carried = inv.stage?.carried;
    const result: RoutingResult = carried ? { ...inv.result, ...dedupeCopper({ segments: [...carried.segments, ...inv.result.segments], arcs: [...carried.arcs, ...inv.result.arcs], vias: [...carried.vias, ...inv.result.vias] }) } : inv.result;
    // staged branches already carry the earlier stages' copper in the composite result; the board's original copper is kept only when asked
    const preserve = opts.preserveExistingRoutes ?? false;
    const cand = await materialize(inv, candidateFromRouting(result, preserve, design), { sourceText: text, design, ...(projectText ? { projectText } : {}), profile, kicadVersion, ...(opts.noKicad ? { noKicad: true } : {}) });
    candidates.push(cand);
    const wall = res.invocations.filter((x) => x === inv || (x.stage && x.stage.index < (inv.stage?.index ?? 0))).reduce((a, x) => a + (x.result?.runtime.wallSeconds ?? 0), 0);
    const metrics = routingMetrics({ design: cand.design, verify: cand.verify, baseline: design, runtimeSeconds: wall });
    await writeFile(path.join(inv.workDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
    const gates = cand.verify.gates;
    scored.push({ id: inv.engineId, metrics, gatesPassed: gates.preflight.passed && gates.routing.passed, gateFailures: [...gates.preflight.failures, ...gates.routing.failures].map((d) => d.code) });
  }
  const ranking = rank(scored, scoring);
  await writeFile(path.join(run.root, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
  const outcome = outcomeOf(res.invocations, candidates, ranking, [...unknown, ...res.ineligible], judged);
  await writeFile(path.join(run.root, 'outcome.json'), JSON.stringify({ ...outcome, diagnostics: outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, entityReferences: d.entityReferences })) }, null, 2), 'utf8');
  // the run's render, whatever the outcome: the selected candidate, else the first candidate (it explains the failure), else the board as given
  const drawn = (ranking.selected ? candidates.find((c) => c.engineId === ranking.selected) : undefined) ?? candidates[0];
  await writeBoardRender(run.root, drawn ? drawn.design : design, drawn ? drawn.verify.diagnostics : outcome.diagnostics, log);
  return { outcome, runDir: run.root, ranking, invocations: res.invocations, candidates, ineligible: [...unknown, ...res.ineligible], ...(plan ? { plan } : {}) };
}

/** The stage whose branches are judged: the last one with a usable result, else the final stage (every branch of which then explains the failure). */
function judgedStage(invocations: Invocation<RoutingResult>[]): number | null {
  const staged = invocations.filter((i) => i.stage);
  if (!staged.length) return null;
  const usable = staged.filter((i) => i.result && !i.snapshotViolation && i.result.status !== 'failed' && i.result.status !== 'unsupported');
  return usable.length ? Math.max(...usable.map((i) => i.stage!.index)) : Math.max(...staged.map((i) => i.stage!.index));
}

function outcomeOf(invocations: Invocation<RoutingResult>[], candidates: MaterializedCandidate[], ranking: Ranking, ineligible: { engineId: string; reasons: string[] }[], judged: number | null = judgedStage(invocations)): Outcome<Diagnostic> {
  const detail: string[] = [];
  for (const i of ineligible) detail.push(`${i.engineId}: ineligible (${i.reasons.join('; ')})`);
  for (const inv of invocations) {
    if (inv.snapshotViolation) detail.push(`${inv.engineId}: INVALID_OUTPUT, ${inv.snapshotViolation}`);
    else if (inv.error) detail.push(`${inv.engineId}: ${inv.error.kind}: ${inv.error.message}${inv.error.fix ? ` (fix: ${inv.error.fix})` : ''}`);
    else if (inv.result && (inv.result.status === 'failed' || inv.result.status === 'unsupported')) detail.push(`${inv.engineId}: ${inv.result.status}${inv.result.diagnostics[0] ? `: ${inv.result.diagnostics[0].message}` : ' (no copper, no explanation from the engine)'}`);
  }
  const selected = ranking.selected ? candidates.find((c) => c.engineId === ranking.selected) : undefined;
  if (selected) {
    const owed = selected.verify.metrics.unrouted_count ?? 0;
    const status: LayoutStatus = owed === 0 ? 'PASS' : 'PARTIAL';
    if (owed) detail.unshift(`${owed} connection(s) still owed on the selected candidate`);
    for (const c of ranking.candidates) detail.push(`${c.id}: rank ${c.rank}, ${c.reason}`);
    return { status, summary: `${ranking.selected} selected: ${ranking.reason}`, detail, diagnostics: selected.verify.diagnostics.filter((d) => d.severity !== 'info') };
  }
  if (!invocations.length) return { status: 'UNSUPPORTED', summary: 'no eligible routing engine', detail, diagnostics: [] };
  if (invocations.some((i) => i.snapshotViolation)) return { status: 'INVALID_OUTPUT', summary: 'an engine modified its input snapshot', detail, diagnostics: [] };
  if (!candidates.length && invocations.some((i) => i.error?.kind === 'malformed-output')) return { status: 'INVALID_OUTPUT', summary: `an engine returned copper the harness cannot represent (${invocations.filter((i) => i.error?.kind === 'malformed-output').map((i) => `${i.engineId}: ${i.error!.message}`).join('; ').slice(0, 300)})`, detail, diagnostics: [] };
  // the verdict rests on the invocations that could have produced a candidate: the final branches of a staged run, every one otherwise;
  // an engine that returned no copper ('failed') counts as an engine failure
  const finals = invocations.filter((i) => !i.stage || i.stage.index === judged);
  const failedKind = (i: Invocation<RoutingResult>): string | null => (i.error ? i.error.kind : i.result && (i.result.status === 'failed' || i.result.status === 'unsupported') ? i.result.status : null);
  if (!candidates.length && finals.length) {
    if (finals.every((i) => failedKind(i) === 'timeout')) return { status: 'TIMEOUT', summary: 'every engine ran out of budget', detail, diagnostics: [] };
    // nothing installed is a capability gap, not an engine crash: the board is unroutable here, and the fix lines say what to install
    if (finals.every((i) => ['no-binary', 'no-runtime', 'runtime-too-old'].includes(failedKind(i) ?? ''))) {
      return { status: 'UNSUPPORTED', summary: `no routing engine is installed (${finals.map((i) => `${i.engineId}: ${failedKind(i)}`).join(', ')})`, detail, diagnostics: [] };
    }
    // every engine that ran declined the board on its own rule (or is missing): the board is out of reach here, not broken
    if (finals.every((i) => ['declined', 'no-binary', 'no-runtime', 'runtime-too-old'].includes(failedKind(i) ?? ''))) {
      return { status: 'UNSUPPORTED', summary: `every routing engine declined the board (${finals.map((i) => `${i.engineId}: ${i.error?.message ?? failedKind(i)}`).join('; ').slice(0, 400)})`, detail, diagnostics: [] };
    }
    if (finals.every((i) => failedKind(i))) return { status: 'ENGINE_ERROR', summary: `no engine produced a candidate (${finals.map((i) => `${i.engineId}: ${failedKind(i)}`).join(', ')})`, detail, diagnostics: [] };
  }
  // candidates exist but none passed the gates
  const worst = candidates[0];
  for (const c of ranking.candidates) detail.push(`${c.id}: ${c.reason}`);
  return { status: 'PARTIAL', summary: 'every candidate failed a hard gate; the placed board is unchanged', detail, diagnostics: worst ? worst.verify.diagnostics.filter((d) => d.severity === 'error') : [] };
}
