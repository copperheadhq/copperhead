/**
 * Placement orchestration (RFC 11 §8, Phase 3): import, snapshot with the
 * movable set, run the eligible placers, materialize and verify every
 * candidate (ripping up copper the moved parts invalidated), measure, probe
 * routability when asked, rank under the placement profile, and end in one
 * Outcome. LLM-free and network-free.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { importBoard } from '../ir/kicad/import.js';
import { makeSnapshot, writeRunDir, DEFAULT_LIMITS, type ResourceLimits } from '../ir/snapshot.js';
import type { Outcome, LayoutStatus } from '../ir/status.js';
import { kicadCliVersion } from '../../kicad/cli.js';
import { loadProfile } from '../verify/profiles/index.js';
import { loadScoringProfile } from '../verify/profiles/scoring/index.js';
import { placementMetrics, tierMetrics } from '../verify/metrics.js';
import { rank, type Ranking } from '../verify/scoring.js';
import { verifyDesign } from '../verify/index.js';
import type { Diagnostic } from '../verify/diagnostic.js';
import { EngineRegistry, DEFAULT_POLICY, type EnginePolicy } from './registry.js';
import { runPlacement, type ExecutionMode, type Invocation } from './runner.js';
import { Budget } from './budget.js';
import { materialize, type MaterializedCandidate } from './candidates.js';
import type { PlacementResult } from './contracts.js';
import { routabilityProbe } from './probe.js';
import { defaultRegistry as defaultRouterRegistry } from './route.js';
import { FixedPlacer, FIXED_PLACER_MANIFEST } from './placers/fixed/adapter.js';
import { ReferencePlacer, REFERENCE_PLACER_MANIFEST } from './placers/reference/adapter.js';
import { PyplacerPlacer, PYPLACER_MANIFEST } from './placers/pyplacer/adapter.js';
import { KicadToolsPlacer, KCT_PHYSICS_MANIFEST, KCT_EVOLUTIONARY_MANIFEST } from './placers/kicad-tools/adapter.js';
import { AnchorsPlacer, ANCHORS_PLACER_MANIFEST } from './placers/anchors/adapter.js';
import { AttachPlacer, ATTACH_PLACER_MANIFEST, type AttachedConstraint } from './placers/attach/adapter.js';
import { ReuseCopyPlacer, REUSE_COPY_MANIFEST } from './placers/reuse-copy/adapter.js';
import { ReusePackPlacer, REUSE_PACK_MANIFEST } from './placers/reuse-pack/adapter.js';
import { HeuristicPlacer, HEURISTIC_PLACER_MANIFEST } from './placers/heuristic/adapter.js';
import type { PlacementPlan as LayoutPlan } from './reuse/plan.js';
import type { LayoutBlockSpec } from './placers/layout-reuse/adapter.js';
import { applyCandidate } from '../ir/kicad/export.js';
import { writeBoardRender } from './render.js';
import { bbox, bboxOf, type Polygon } from '../ir/geometry.js';
import type { PlacedComponent, ComponentInstance, PcbDesign } from '../ir/types.js';
import { connectorEdgeConstraints, type Block } from '../intent/blocks.js';
import { loadConstraints } from '../intent/load.js';
import { placeMechanical, legalizeKeepouts, legalizeRegions, legalizeSeparation, legalizeEdge } from './legalize.js';
import type { Constraint } from '../../memory/constraints.js';

export interface PlaceOptions {
  repoRoot: string;
  boardPath: string;
  projectPath?: string;
  runDir: string;
  /** Engine ids in preference order; default: every registered placer. */
  placers?: string[];
  mode?: Exclude<ExecutionMode, 'staged'>;
  /** Refdes to move; default: every component not locked in KiCad. */
  movableReferences?: string[];
  seed?: number;
  limits?: Partial<ResourceLimits>;
  profile?: string;
  scoring?: string;
  policy?: EnginePolicy;
  maxParallel?: number;
  registry?: EngineRegistry;
  noKicad?: boolean;
  /** Routability probe per candidate (spec §5.3); false to skip. */
  probe?: { routerId?: string; budgetSeconds?: number; registry?: EngineRegistry; maxCandidates?: number } | false;
  /**
   * Functional blocks: turns the run into the staged plan (RFC 11 §8.5): locked
   * parts stay, each block's anchor is placed at its region centroid first and
   * locked, then the wrapped placers place the remainder.
   */
  blocks?: Block[];
  /**
   * The placement plan the engines place from (`layout.plan`): subsystems,
   * anchors, connector edges, critical relationships, phase order. A model may
   * write one with `copperhead pcb plan`; reading it here keeps this command
   * LLM-free and network-free, as its contract requires. Not to be confused
   * with the intent file, which is the constraint registry (`intentPath`).
   */
  layoutPlan?: LayoutPlan;
  /** Stage 3 inputs: reference blocks to copy around their anchors, and single attachments (`relative.attached`). */
  reuse?: LayoutBlockSpec[];
  attached?: Omit<AttachedConstraint, 'kind'>[];
  /**
   * Layout constraints for the intent checker. Default: the board's intent file
   * (beside the board or under docs) plus its own rules. Their attachments feed
   * stage 3 and their functional groups feed the anchors when no blocks are given.
   */
  constraints?: Record<string, Constraint> | null;
  docsDir?: string;
  intentPath?: string | null;
  log?: (line: string) => void;
}

export interface PlacementPlan {
  stages: { name: string; engineId: string; componentIds: string[] }[];
  blocks: Block[];
}

export interface PlaceRun {
  outcome: Outcome<Diagnostic>;
  runDir: string;
  ranking: Ranking;
  invocations: Invocation<PlacementResult>[];
  candidates: MaterializedCandidate[];
  ineligible: { engineId: string; reasons: string[] }[];
  movableIds: string[];
  plan?: PlacementPlan;
}

/** The built-in placers, in preference order: kct physics, pyplacer, kct evolutionary, the fixed control, the harness reference. */
export function defaultPlacerRegistry(repoRoot: string): EngineRegistry {
  const r = new EngineRegistry();
  r.register(new KicadToolsPlacer('force-directed', { repoRoot }), KCT_PHYSICS_MANIFEST);
  r.register(new PyplacerPlacer(), PYPLACER_MANIFEST);
  r.register(new KicadToolsPlacer('evolutionary', { repoRoot }), KCT_EVOLUTIONARY_MANIFEST);
  r.register(new FixedPlacer(), FIXED_PLACER_MANIFEST);
  r.register(new ReferencePlacer(), REFERENCE_PLACER_MANIFEST);
  // the reuse placers only do anything with a reference board in the job (add-reuse-placer)
  r.register(new ReuseCopyPlacer(), REUSE_COPY_MANIFEST);
  r.register(new ReusePackPlacer(), REUSE_PACK_MANIFEST);
  // the engineer's basic rules; it needs no reference board, only an intent (its own when none is given)
  r.register(new HeuristicPlacer(), HEURISTIC_PLACER_MANIFEST);
  return r;
}

export async function placeBoard(opts: PlaceOptions): Promise<PlaceRun> {
  const log = opts.log ?? (() => {});
  const projectPath = opts.projectPath ?? (existsSync(opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro')) ? opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro') : undefined);
  const projectText = projectPath ? await readFile(projectPath, 'utf8') : undefined;
  let text = await readFile(opts.boardPath, 'utf8');
  let kicadVersion = 'unknown';
  if (!opts.noKicad) {
    try {
      kicadVersion = await kicadCliVersion();
    } catch {
      kicadVersion = 'unknown';
    }
  }
  const imported = importBoard({ boardText: text, boardPath: path.relative(opts.repoRoot, opts.boardPath), ...(projectText ? { projectText, projectPath: path.relative(opts.repoRoot, projectPath!) } : {}), kicadVersion, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) });
  for (const w of imported.warnings) log(`import: ${w}`);
  const profile = loadProfile(imported.design.board.fabricationProfile);
  const scoring = loadScoringProfile(opts.scoring ?? 'default-placement-2-layer');
  const wantedRefs = opts.movableReferences ? new Set(opts.movableReferences) : null;
  let design = imported.design;
  // the constraint registry: intent + the board's own rules unless the caller passed one (null = none)
  let constraints: Record<string, Constraint> = {};
  if (opts.constraints !== null) {
    if (opts.constraints) constraints = opts.constraints;
    else {
      const loaded = await loadConstraints(design, opts.boardPath, { ...(opts.intentPath !== undefined ? { intentPath: opts.intentPath } : {}), ...(opts.docsDir ? { docsDir: opts.docsDir } : {}), repoRoot: opts.repoRoot });
      constraints = loaded.registry;
      for (const h of loaded.holds) log(`intent: ${h}`);
      if (loaded.intentPath) log(`intent: ${path.relative(opts.repoRoot, loaded.intentPath)} (${Object.keys(constraints).filter((k) => k.startsWith('layout.')).length} constraint(s) with the board's own rules)`);
    }
  }
  // A connector belongs on a board edge. The classifier already knows which
  // parts are connectors, but nothing turned that into a position unless a
  // hand-written intent file said `placement.fixed[].edge`, so an intent-less
  // board got its receptacles packed mid-board. Derive the missing ones from
  // the blocks' signal-flow regions; anything the registry already states wins.
  if (opts.blocks?.length && opts.constraints !== null) {
    for (const [k, c] of Object.entries(connectorEdgeConstraints(opts.blocks, design, constraints))) {
      constraints[k] = c;
      log(`intent: ${c.scope?.refs?.[0]} -> ${c.parameters?.edge} edge (derived from its block region)`);
    }
  }
  // stage-3 attachments from the registry (relative.attached, hard or soft), unless the caller supplied its own
  const attached = opts.attached ?? Object.entries(constraints).filter(([k, c]) => k.startsWith('layout.relative.attached.') && c.class === 'relative').map(([, c]) => ({ ref: String(c.scope?.refs?.[0] ?? ''), to: `${String(c.parameters?.target ?? '')}${Array.isArray(c.parameters?.pins) && (c.parameters!.pins as string[]).length ? `.${(c.parameters!.pins as string[])[0]}` : ''}`, max_distance_nm: Number(c.parameters?.max_distance_nm ?? 2_000_000) })).filter((a) => a.ref && a.to);
  let movableIds = design.components.filter((c) => !c.attributes.locked && (!wantedRefs || wantedRefs.has(c.reference))).map((c) => c.id);
  await mkdir(opts.runDir, { recursive: true });
  let plan: PlacementPlan | undefined;
  const hasMechanical = Object.entries(constraints).some(([k, c]) => c.class === 'mechanical' && (k.startsWith('layout.mechanical.edge.') || k.startsWith('layout.mechanical.fixed.')) && c.source !== 'ecad_rules');
  if (opts.blocks?.length || opts.reuse?.length || attached.length || hasMechanical) {
    // staged plan, stages 1 to 3: locked parts stay; anchors go to their region centroids and are locked for the wrapped placer
    const lockedIds = design.components.filter((c) => c.attributes.locked).map((c) => c.id);
    // stage 1: parts a mechanical constraint fixes outright (edge, fixed position), then held
    const mech = placeMechanical(design, constraints, new Set(movableIds));
    if (mech.placements.length) {
      text = applyCandidate(text, design, { placement: mech.placements }).text;
      design = importBoard({ boardText: text, boardPath: path.relative(opts.repoRoot, opts.boardPath), ...(projectText ? { projectText, projectPath: path.relative(opts.repoRoot, projectPath!) } : {}), kicadVersion, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) }).design;
      for (const n of mech.notes) log(`stage 1: ${n}`);
    }
    const mechIds = new Set(mech.placements.map((p) => p.id));
    movableIds = movableIds.filter((id) => !mechIds.has(id));
    for (const id of mechIds) lockedIds.push(id);
    const anchorsPlacer = new AnchorsPlacer();
    const preSnapshot = makeSnapshot(design, { kind: 'placement', movableComponentIds: movableIds }, { seed: opts.seed ?? 0, limits: { ...DEFAULT_LIMITS, ...opts.limits } });
    const anchors = await anchorsPlacer.place({ runId: 'anchors', snapshot: preSnapshot, movableComponentIds: movableIds, constraints: (opts.blocks ?? []).map((block) => ({ kind: 'functional.group', block })), objectives: [], seed: opts.seed ?? 0, limits: preSnapshot.limits }, { workDir: opts.runDir, boardPath: opts.boardPath, log });
    if (anchors.placements.length) {
      text = applyCandidate(text, design, { placement: anchors.placements }).text;
      design = importBoard({ boardText: text, boardPath: path.relative(opts.repoRoot, opts.boardPath), ...(projectText ? { projectText, projectPath: path.relative(opts.repoRoot, projectPath!) } : {}), kicadVersion, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) }).design;
    }
    const anchorIds = new Set(anchors.placements.map((p) => p.id));
    movableIds = movableIds.filter((id) => !anchorIds.has(id));
    // stage 3: reference blocks around their anchors and single attachments, then locked like the anchors
    let attachedIds = new Set<string>();
    if (opts.reuse?.length || attached.length) {
      const stageSnapshot = makeSnapshot(design, { kind: 'placement', movableComponentIds: movableIds }, { seed: opts.seed ?? 0, limits: { ...DEFAULT_LIMITS, ...opts.limits } });
      const stageConstraints = [...(opts.reuse ?? []).map((spec) => ({ kind: 'layout.reuse', spec })), ...attached.map((a) => ({ kind: 'relative.attached' as const, ...a }))];
      const attach = await new AttachPlacer().place({ runId: 'attach', snapshot: stageSnapshot, movableComponentIds: movableIds, constraints: stageConstraints, objectives: [], seed: opts.seed ?? 0, limits: stageSnapshot.limits }, { workDir: opts.runDir, boardPath: opts.boardPath, log });
      if (attach.placements.length) {
        text = applyCandidate(text, design, { placement: attach.placements }).text;
        design = importBoard({ boardText: text, boardPath: path.relative(opts.repoRoot, opts.boardPath), ...(projectText ? { projectText, projectPath: path.relative(opts.repoRoot, projectPath!) } : {}), kicadVersion, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) }).design;
      }
      attachedIds = new Set(attach.placements.map((p) => p.id));
      // the parts they were placed against must not move either, or the bulk placer breaks the relation
      const byRef = new Map(design.components.map((c) => [c.reference, c.id]));
      for (const spec of opts.reuse ?? []) if (byRef.has(spec.anchor) && attach.placements.length) attachedIds.add(byRef.get(spec.anchor)!);
      for (const a of attached) {
        const target = byRef.get(a.to.split('.')[0]!);
        if (target && attach.placements.some((p) => p.id === byRef.get(a.ref))) attachedIds.add(target);
      }
      movableIds = movableIds.filter((id) => !attachedIds.has(id));
    }
    // stages 2 and 3 are rule placements that ignore the outline: a block whose members now hang over
    // the edge is shifted as a whole (offsets intact) back inside before the wrapped placer runs
    const groups = groupsFor(opts, design, anchorIds, attachedIds);
    const shifts = fitInside(design, groups);
    if (shifts.length) {
      text = applyCandidate(text, design, { placement: shifts }).text;
      design = importBoard({ boardText: text, boardPath: path.relative(opts.repoRoot, opts.boardPath), ...(projectText ? { projectText, projectPath: path.relative(opts.repoRoot, projectPath!) } : {}), kicadVersion, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) }).design;
      log(`staged plan: ${groups.filter((g) => g.some((id) => shifts.some((p) => p.id === id))).length} block(s) shifted back inside the outline`);
    }
    plan = { stages: [{ name: 'fixed', engineId: 'placer-fixed', componentIds: lockedIds }, { name: 'anchors', engineId: ANCHORS_PLACER_MANIFEST.id, componentIds: [...anchorIds] }, { name: 'attach', engineId: ATTACH_PLACER_MANIFEST.id, componentIds: [...attachedIds] }, { name: 'bulk', engineId: (opts.placers ?? ['*']).join('|'), componentIds: movableIds }], blocks: opts.blocks ?? [] };
    await writeFile(path.join(opts.runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    log(`staged plan: ${anchorIds.size} anchor(s) at their region centroids, ${attachedIds.size} part(s) attached or reused, ${movableIds.length} part(s) left to the placers`);
  }
  const snapshot = makeSnapshot(design, { kind: 'placement', movableComponentIds: movableIds }, { seed: opts.seed ?? 0, limits: { ...DEFAULT_LIMITS, ...opts.limits } });
  const run = await writeRunDir(opts.runDir, snapshot, [opts.boardPath, ...(projectPath ? [projectPath] : [])]);
  const registry = opts.registry ?? defaultPlacerRegistry(opts.repoRoot);
  const wanted = opts.placers ?? registry.list('placer').map((e) => e.manifest.id);
  const engines = wanted.map((id) => registry.get(id)).filter((e): e is NonNullable<typeof e> => !!e);
  const unknown = wanted.filter((id) => !registry.get(id)).map((engineId) => ({ engineId, reasons: [`not registered (known: ${registry.list('placer').map((e) => e.manifest.id).join(', ')})`] }));
  // pre-flight gates before any engine runs; the placement gate is what placement is for, so it does not block here
  const pre = verifyDesign({ design, profile });
  if (!pre.gates.preflight.passed) {
    const failures = pre.gates.preflight.failures;
    const outcome: Outcome<Diagnostic> = { status: 'REFUSE', summary: `pre-flight gate failed before placement: ${[...new Set(failures.map((d) => d.code))].join(', ')}`, detail: failures.map((d) => `${d.code}${d.entityReferences.length ? ` [${d.entityReferences.slice(0, 4).join(', ')}]` : ''}: ${d.message}`), diagnostics: pre.diagnostics.filter((d) => d.severity !== 'info') };
    const ranking = rank([], scoring);
    await writeFile(path.join(run.root, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
    await writeFile(path.join(run.root, 'outcome.json'), JSON.stringify(slim(outcome), null, 2), 'utf8');
    await writeBoardRender(run.root, design, pre.diagnostics, log);
    return { outcome, runDir: run.root, ranking, invocations: [], candidates: [], ineligible: unknown, movableIds, ...(plan ? { plan } : {}) };
  }
  const budget = new Budget(snapshot.limits.engineSeconds, snapshot.limits.wallSeconds);
  const res = await runPlacement({
    run, sourceText: text, design, ...(projectText ? { projectText } : {}), snapshotFileHash: run.fileHash, snapshot, budget, engines, mode: opts.mode ?? 'single', policy: opts.policy ?? DEFAULT_POLICY, ...(opts.maxParallel ? { maxParallel: opts.maxParallel } : {}),
    job: { movableComponentIds: movableIds, constraints: [...(opts.blocks ?? []).map((block) => ({ kind: 'functional.group', block })), ...(opts.layoutPlan ? [{ kind: 'layout.plan', value: opts.layoutPlan }] : [])], objectives: [], seed: opts.seed ?? 0, limits: snapshot.limits },
    log,
  });
  const hasCopper = design.routing.segments.length + design.routing.arcs.length + design.routing.vias.length > 0;
  const candidates: MaterializedCandidate[] = [];
  const scored = [];
  let probed = 0;
  for (const inv of res.invocations) {
    if (!inv.result || inv.snapshotViolation) continue;
    if (inv.result.status === 'failed' || inv.result.status === 'unsupported') continue;
    // rule stages on the engine's result: out of keepouts, into their regions,
    // blocks apart, in from the edge; what moved is recorded on the candidate.
    // Regions run before separation and the edge so those two get the last
    // word: a region is where a part belongs, the outline is where it may be.
    const movableNow = new Set(movableIds);
    const k = legalizeKeepouts(design, constraints, movableNow, inv.result.placements);
    const reg = legalizeRegions(design, constraints, movableNow, k.placements);
    const sep = legalizeSeparation(design, constraints, movableNow, reg.placements);
    const edge = legalizeEdge(design, movableNow, sep.placements);
    const legalizeNotes = [...k.notes, ...reg.notes, ...sep.notes, ...edge.notes];
    if (legalizeNotes.length) {
      inv.result = { ...inv.result, placements: edge.placements };
      for (const n of legalizeNotes) log(`${inv.engineId}: legalized: ${n}`);
      await writeFile(path.join(inv.workDir, 'legalized.json'), JSON.stringify({ notes: legalizeNotes, placements: edge.placements }, null, 2), 'utf8');
    }
    const before = new Map(design.components.map((c) => [c.id, c]));
    const moved = inv.result.placements.some((p) => {
      const c = before.get(p.id);
      return !c || c.at.x !== p.at.x || c.at.y !== p.at.y || c.rotation !== p.rotation || c.attributes.side !== p.side;
    });
    // copper routed to the old positions is invalid once a part moves: rip it up, keep the zones
    const candidate = { placement: inv.result.placements, ...(hasCopper && moved ? { routing: { segments: [], arcs: [], vias: [], preserveIds: new Set<string>() } } : {}) };
    const cand = await materialize(inv, candidate, { sourceText: text, design, ...(projectText ? { projectText } : {}), profile, kicadVersion, ...(opts.noKicad ? { noKicad: true } : {}), ...(Object.keys(constraints).length ? { constraints } : {}) });
    candidates.push(cand);
    const metrics: Record<string, number> = { ...placementMetrics({ design: cand.design, verify: cand.verify, runtimeSeconds: inv.result.runtime.wallSeconds }), unplaced_count: inv.result.unplacedComponentIds.length, refused_count: cand.refused.length, intent_hard_violations: cand.verify.metrics.intent_hard_violations ?? 0, intent_soft_violations: cand.verify.metrics.intent_soft_violations ?? 0, intent_hard_total: cand.verify.metrics.intent_hard_total ?? 0, intent_compliance: cand.verify.metrics.intent_compliance ?? 1, legalized_moves: legalizeNotes.length,
      // what the tiered profiles rank on (RFC 15 Section 11.1); absent when nothing measured them
      ...tierMetrics(cand.verify.diagnostics),
      ...(cand.verify.metrics.rf_clearance_min_mm !== undefined ? { rf_clearance_min_mm: cand.verify.metrics.rf_clearance_min_mm } : {}),
      ...(cand.verify.metrics.loop_area_mm2 !== undefined ? { loop_area_mm2: cand.verify.metrics.loop_area_mm2 } : {}),
      ...(cand.verify.metrics.isolation_min_mm !== undefined ? { isolation_min_mm: cand.verify.metrics.isolation_min_mm } : {}),
      ...(cand.verify.metrics.chain_order_violations !== undefined ? { chain_order_violations: cand.verify.metrics.chain_order_violations } : {}),
      ...(cand.verify.metrics.intrusion_count !== undefined ? { intrusion_count: cand.verify.metrics.intrusion_count } : {}),
      ...(cand.verify.metrics.drc_placement_critical_count !== undefined ? { drc_placement_critical_count: cand.verify.metrics.drc_placement_critical_count } : {}) };
    // the probe is the expensive check: a cap keeps a wide sweep affordable
    const probeCap = opts.probe === false ? 0 : opts.probe?.maxCandidates ?? Infinity;
    if (opts.probe !== false && cand.verify.gates.placement.passed && probed < probeCap) {
      probed++;
      try {
        const p = await routabilityProbe({ repoRoot: opts.repoRoot, pcbPath: cand.pcbPath, workDir: inv.workDir, ...(opts.probe?.routerId ? { routerId: opts.probe.routerId } : {}), ...(opts.probe?.budgetSeconds ? { budgetSeconds: opts.probe.budgetSeconds } : {}), registry: opts.probe?.registry ?? defaultRouterRegistry(opts.repoRoot), policy: opts.policy ?? DEFAULT_POLICY, ...(opts.noKicad ? { noKicad: true } : {}), log: (l) => log(`  probe: ${l}`) });
        metrics.routability_completion = p.routability_completion;
        metrics.routability_drc_errors = p.routability_drc_errors;
      } catch (err) {
        log(`probe failed on ${inv.engineId}: ${(err as Error).message}`);
      }
    }
    await writeFile(path.join(inv.workDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
    const gates = cand.verify.gates;
    scored.push({ id: inv.engineId, metrics, gatesPassed: gates.preflight.passed && gates.placement.passed && cand.refused.length === 0 && inv.result.unplacedComponentIds.length === 0, gateFailures: [...gates.preflight.failures, ...gates.placement.failures].map((d) => d.code).concat(cand.refused.length ? ['export.refused'] : [], inv.result.unplacedComponentIds.length ? ['placement.unplaced'] : []) });
  }
  const ranking = rank(scored, scoring);
  await writeFile(path.join(run.root, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
  const outcome = outcomeOf(res.invocations, candidates, ranking, [...unknown, ...res.ineligible]);
  await writeFile(path.join(run.root, 'outcome.json'), JSON.stringify(slim(outcome), null, 2), 'utf8');
  // the run's render, whatever the outcome: the selected candidate, else the first candidate (it explains the failure), else the board as given
  const drawn = (ranking.selected ? candidates.find((c) => c.engineId === ranking.selected) : undefined) ?? candidates[0];
  await writeBoardRender(run.root, drawn ? drawn.design : design, drawn ? drawn.verify.diagnostics : outcome.diagnostics, log);
  return { outcome, runDir: run.root, ranking, invocations: res.invocations, candidates, ineligible: [...unknown, ...res.ineligible], movableIds, ...(plan ? { plan } : {}) };
}

export function slim(o: Outcome<Diagnostic>): unknown {
  return { ...o, diagnostics: o.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, entityReferences: d.entityReferences })) };
}

export function outcomeOf(invocations: Invocation<PlacementResult>[], candidates: MaterializedCandidate[], ranking: Ranking, ineligible: { engineId: string; reasons: string[] }[]): Outcome<Diagnostic> {
  const detail: string[] = [];
  for (const i of ineligible) detail.push(`${i.engineId}: ineligible (${i.reasons.join('; ')})`);
  for (const inv of invocations) {
    if (inv.snapshotViolation) detail.push(`${inv.engineId}: INVALID_OUTPUT, ${inv.snapshotViolation}`);
    else if (inv.error) detail.push(`${inv.engineId}: ${inv.error.kind}: ${inv.error.message}${inv.error.fix ? ` (fix: ${inv.error.fix})` : ''}`);
    else if (inv.result && (inv.result.status === 'failed' || inv.result.status === 'unsupported')) detail.push(`${inv.engineId}: ${inv.result.status}${inv.result.diagnostics[0] ? `: ${inv.result.diagnostics[0].message}` : ' (no placement, no explanation from the engine)'}`);
  }
  const selected = ranking.selected ? candidates.find((c) => c.engineId === ranking.selected) : undefined;
  if (selected) {
    const inv = invocations.find((i) => i.engineId === ranking.selected);
    const unplaced = inv?.result?.unplacedComponentIds.length ?? 0;
    const status: LayoutStatus = unplaced === 0 ? 'PASS' : 'PARTIAL';
    if (unplaced) detail.unshift(`${unplaced} component(s) left unplaced by the selected candidate`);
    for (const c of ranking.candidates) detail.push(`${c.id}: rank ${c.rank}, ${c.reason}`);
    return { status, summary: `${ranking.selected} selected: ${ranking.reason}`, detail, diagnostics: selected.verify.diagnostics.filter((d) => d.severity !== 'info') };
  }
  if (!invocations.length) return { status: 'UNSUPPORTED', summary: 'no eligible placement engine', detail, diagnostics: [] };
  if (invocations.some((i) => i.snapshotViolation)) return { status: 'INVALID_OUTPUT', summary: 'an engine modified its input snapshot', detail, diagnostics: [] };
  const failedKind = (i: Invocation<PlacementResult>): string | null => (i.error ? i.error.kind : i.result && (i.result.status === 'failed' || i.result.status === 'unsupported') ? i.result.status : null);
  if (!candidates.length) {
    if (invocations.every((i) => failedKind(i) === 'timeout')) return { status: 'TIMEOUT', summary: 'every engine ran out of budget', detail, diagnostics: [] };
    if (invocations.every((i) => ['no-binary', 'no-runtime', 'runtime-too-old'].includes(failedKind(i) ?? ''))) {
      return { status: 'UNSUPPORTED', summary: `no placement engine is installed (${invocations.map((i) => `${i.engineId}: ${failedKind(i)}`).join(', ')})`, detail, diagnostics: [] };
    }
    if (invocations.every((i) => failedKind(i))) return { status: 'ENGINE_ERROR', summary: `no engine produced a candidate (${invocations.map((i) => `${i.engineId}: ${failedKind(i)}`).join(', ')})`, detail, diagnostics: [] };
  }
  const worst = candidates[0];
  for (const c of ranking.candidates) detail.push(`${c.id}: ${c.reason}`);
  return { status: 'PARTIAL', summary: 'every candidate failed a hard gate; the board is unchanged', detail, diagnostics: worst ? worst.verify.diagnostics.filter((d) => d.severity === 'error') : [] };
}

/** The rigid groups the rule stages produced: each block's anchor with its members placed by stage 3; reuse specs' anchors with their members. */
function groupsFor(opts: PlaceOptions, design: PcbDesign, anchorIds: Set<string>, attachedIds: Set<string>): string[][] {
  const byRef = new Map(design.components.map((c) => [c.reference, c.id]));
  const groups: string[][] = [];
  for (const b of opts.blocks ?? []) {
    if (!b.anchor || !anchorIds.has(b.anchor)) continue;
    groups.push([b.anchor, ...b.members.filter((m) => m !== b.anchor && attachedIds.has(m))]);
  }
  for (const spec of opts.reuse ?? []) {
    const a = byRef.get(spec.anchor);
    if (!a || groups.some((g) => g.includes(a))) continue;
    groups.push([a, ...spec.members.map((m) => byRef.get(m.ref)).filter((id): id is string => !!id && attachedIds.has(id))]);
  }
  return groups;
}

function extentOf(c: ComponentInstance): Polygon | null {
  if (c.footprint.courtyard) return c.footprint.courtyard;
  if (!c.pads.length) return null;
  const b = bboxOf(c.pads.map((p) => p.copper));
  return { outer: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], holes: [] };
}

/** Translate each group by the least vector that brings its extent inside the outline (inset by the edge clearance); groups that fit already are untouched. */
function fitInside(design: PcbDesign, groups: string[][]): PlacedComponent[] {
  const ob = bbox(design.board.outline);
  const inset = design.board.rules.copperEdgeClearanceNm + 250_000;
  const lim = { minX: ob.minX + inset, minY: ob.minY + inset, maxX: ob.maxX - inset, maxY: ob.maxY - inset };
  const out: PlacedComponent[] = [];
  for (const g of groups) {
    const comps = g.map((id) => design.components.find((c) => c.id === id)).filter((c): c is ComponentInstance => !!c);
    const polys = comps.map(extentOf).filter((p): p is Polygon => !!p);
    if (!polys.length) continue;
    const b = bboxOf(polys);
    let dx = 0, dy = 0;
    if (b.minX < lim.minX) dx = lim.minX - b.minX;
    else if (b.maxX > lim.maxX) dx = lim.maxX - b.maxX;
    if (b.minY < lim.minY) dy = lim.minY - b.minY;
    else if (b.maxY > lim.maxY) dy = lim.maxY - b.maxY;
    if (!dx && !dy) continue;
    for (const c of comps) out.push({ id: c.id, at: { x: c.at.x + dx, y: c.at.y + dy }, rotation: c.rotation, side: c.attributes.side });
  }
  return out;
}
