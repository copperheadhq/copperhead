/**
 * The reuse run (add-reuse-placer, RFC 14 §8.5, §8.6): match the board against
 * a reference, plan, pack every variant in memory, screen them, and put only
 * the survivors through the ordinary placement path — materialise with KiCad,
 * verify, probe routability, rank.
 *
 * Screening is in memory because it is cheap there: a variant costs a packer
 * solve and a geometry check, milliseconds each, where materialising one costs
 * a KiCad export and a DRC run. The funnel is the point: generate many, judge
 * them on what can be judged offline, and spend the expensive checks on the
 * few that could win.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { importBoard } from '../../ir/kicad/import.js';
import { applyPlacements } from '../../ir/transform.js';
import type { PcbDesign, PlacedComponent, Point } from '../../ir/types.js';
import type { ResourceLimits } from '../../ir/snapshot.js';
import type { Constraint } from '../../../memory/constraints.js';
import { verifyDesign } from '../../verify/index.js';
import { placementMetrics } from '../../verify/metrics.js';
import { checkPlacementIntent } from '../../verify/checkers/placement-intent.js';
import { classifyCritical, relationsToConstraints } from '../../intent/critical.js';
import { partitions, partitionToConstraints } from '../../intent/subsystems.js';
import { EngineRegistry } from '../registry.js';
import { placeBoard, defaultPlacerRegistry, outcomeOf, slim, type PlaceOptions, type PlaceRun } from '../place.js';
import { PrecomputedPlacer, precomputedManifest } from '../placers/precomputed/adapter.js';
import { matchComponents, type MatchReport } from './match.js';
import { transferPlacement, type Transform } from './transfer.js';
import { computeDelta, deltaTable, type Delta } from './delta.js';
import { defaultPlan, validatePlan, type PlacementPlan } from './plan.js';
import { runPhases, type PhaseReport } from './phases.js';
import { enumerateVariants, type VariantSpec } from './variants.js';
import { criticalNetNames, routeCriticalNets, type CriticalRouteResult } from './critical-route.js';
import { rank, type Ranking } from '../../verify/scoring.js';
import { loadScoringProfile } from '../../verify/profiles/scoring/index.js';

export interface ReuseRunOptions {
  repoRoot: string;
  /** The board being placed. */
  boardPath: string;
  /** The board whose placement is being reused. */
  referencePath: string;
  runDir: string;
  projectPath?: string;
  /** A plan from the model; the rules write one when this is absent, and when this one does not validate. */
  plan?: PlacementPlan | null;
  /**
   * Writes the plan when the caller has a model. The engine never imports the
   * agent (RFC 11 §5.2 import direction), so the command passes this in; without
   * it the rules plan and the run stays network-free. A planner that fails or
   * answers badly is the caller's problem to report: whatever comes back is
   * validated here before it is used.
   */
  planner?: (input: ReusePlanInput) => Promise<{ plan: PlacementPlan; fromModel: boolean; reason: string; problems?: string[] }>;
  movableReferences?: string[];
  variants?: VariantSpec[];
  /** How many screened variants are materialised (default 8). */
  keep?: number;
  budget?: 'quick' | 'screen';
  probe?: PlaceOptions['probe'];
  /**
   * Route the critical nets of the materialised candidates and rank on the
   * result (RFC 14 §8.7). This is the check a placement cannot fake: a board
   * whose decoupling or switch node will not close is not a placement, whatever
   * its wirelength. `false` skips it; the copper is thrown away either way.
   */
  criticalRoute?: { budgetSeconds?: number; routerId?: string; maxCandidates?: number } | false;
  profile?: string;
  scoring?: string;
  seed?: number;
  limits?: Partial<ResourceLimits>;
  noKicad?: boolean;
  constraints?: Record<string, Constraint> | null;
  /**
   * Called once the plan is final and before any variant is produced, so the
   * caller can write placement.md at plan time (RFC 11 Section 12.6).
   */
  onPlan?: (plan: PlacementPlan, source: 'model' | 'rules') => Promise<void>;
  log?: (line: string) => void;
}

/** What a planner is given: the board, what may move, and what the analysis found. */
export interface ReusePlanInput {
  design: PcbDesign;
  movableRefs: string[];
  partitions: ReturnType<typeof partitions>;
  classification: ReturnType<typeof classifyCritical>;
  delta: Delta;
  referenceName: string;
  targets: Map<string, Point>;
  /** The plan the rules would write, which a planner may return unchanged. */
  fallback: PlacementPlan;
  recordDir: string;
}

export interface ScreenMetrics {
  legal: boolean;
  unplaced: number;
  overlap: number;
  outside: number;
  hpwlNm: number;
  intentHard: number;
  /** Mean distance from where the plan wanted each part, millimetres. */
  displacementMm: number;
  loopAreaMm2: number;
  intrusions: number;
  chainViolations: number;
  seconds: number;
}

export interface ScreenedVariant {
  id: string;
  option: string;
  note: string;
  placements: PlacedComponent[];
  unplacedIds: string[];
  phases: PhaseReport[];
  metrics: ScreenMetrics;
  /** Lower is better; the sort key after legality. */
  score: number;
  kept: boolean;
  /** The variant this one turned out to be identical to, when it did. */
  sameAs?: string;
}

export interface ReuseRun {
  runDir: string;
  /** Per materialised candidate engine id: what its critical nets did. */
  criticalRoutes: Map<string, CriticalRouteResult>;
  /** The ranking after critical routing, when it ran; `place.ranking` otherwise. */
  ranking: Ranking | null;
  match: MatchReport;
  delta: Delta;
  transform: Transform;
  plan: PlacementPlan;
  planSource: 'model' | 'rules';
  screened: ScreenedVariant[];
  place: PlaceRun | null;
}

const key = (ps: PlacedComponent[]) => ps.map((p) => `${p.id}:${p.at.x},${p.at.y},${p.rotation}`).sort().join('|');

/**
 * What a variant is worth before anything has been routed. Legality decides
 * first and nothing outranks it; then the intent the board declared, because a
 * violated hot loop is a real defect where a longer net is a cost; then
 * length, which is the proxy for routability we can compute offline.
 */
function scoreOf(m: ScreenMetrics, referenceHpwlNm: number): number {
  const relative = referenceHpwlNm > 0 ? m.hpwlNm / referenceHpwlNm : 1;
  // the last term is why this is reuse: where two placements are otherwise equal,
  // the one that stayed closer to the reference is the one a reviewer can read
  return (m.legal ? 0 : 1000) + m.unplaced * 100 + m.overlap * 50 + m.outside * 50 + m.intentHard * 20 + m.chainViolations * 5 + m.intrusions * 2 + relative * 10 + m.loopAreaMm2 * 0.1 + m.displacementMm * 0.05;
}

export async function reuseRun(opts: ReuseRunOptions): Promise<ReuseRun> {
  const log = opts.log ?? (() => {});
  const boardText = await readFile(opts.boardPath, 'utf8');
  const projectPath = opts.projectPath ?? (existsSync(opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro')) ? opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro') : undefined);
  const design = importBoard({ boardText, boardPath: opts.boardPath, ...(opts.profile ? { fabricationProfile: opts.profile } : {}) }).design;
  const reference = importBoard({ boardText: await readFile(opts.referencePath, 'utf8'), boardPath: opts.referencePath }).design;

  const wanted = opts.movableReferences ? new Set(opts.movableReferences) : null;
  const movable = design.components.filter((c) => !c.attributes.locked && (!wanted || wanted.has(c.reference)));
  const movableIds = new Set(movable.map((c) => c.id));
  const movableRefs = movable.map((c) => c.reference);

  const match = matchComponents(design, reference);
  const delta = computeDelta(design, reference, match);
  const transfer = transferPlacement(design, reference, match.matches, { movableIds });
  log(`reuse: matched ${(match.coverage * 100).toFixed(0)} % of ${design.components.length} parts, fitted on ${transfer.fittedOn}, residual ${(transfer.residualNm / 1e6).toFixed(2)} mm`);
  const refOf = new Map(design.components.map((c) => [c.id, c.reference]));
  const targets = new Map<string, Point>();
  for (const p of transfer.placements) {
    const r = refOf.get(p.id);
    if (r) targets.set(r, p.at);
  }

  const classification = classifyCritical(design);
  const parts = partitions(design);
  let planSource: ReuseRun['planSource'] = 'rules';
  let plan = opts.plan ?? null;
  if (plan) {
    const check = validatePlan(plan, design, movableRefs);
    for (const w of check.warnings) log(`reuse: plan: ${w}`);
    if (check.errors.length) {
      for (const e of check.errors) log(`reuse: the model's plan is invalid: ${e}`);
      plan = null;
    } else planSource = 'model';
  }
  if (!plan) {
    const partition = parts[0];
    if (!partition) throw new Error('the board has no subsystem partition to plan with');
    const fallback = defaultPlan({
      design,
      movableRefs,
      partition,
      classification,
      transferred: transfer.placements,
      reference: { board: path.basename(opts.referencePath), coverage: match.coverage },
    });
    if (opts.planner) {
      const outcome = await opts.planner({
        design,
        movableRefs,
        partitions: parts,
        classification,
        delta,
        referenceName: path.basename(opts.referencePath),
        targets,
        fallback,
        recordDir: path.join(opts.runDir, 'plan'),
      });
      const check = validatePlan(outcome.plan, design, movableRefs);
      if (check.errors.length) {
        for (const e of check.errors.slice(0, 5)) log(`reuse: the planner's plan is invalid: ${e}`);
        plan = fallback;
      } else {
        plan = outcome.plan;
        planSource = outcome.fromModel ? 'model' : 'rules';
      }
      log(`reuse: ${outcome.reason}`);
      for (const p of (outcome.problems ?? []).slice(0, 5)) log(`reuse: plan problem: ${p}`);
    } else {
      plan = fallback;
    }
  }

  if (opts.onPlan) await opts.onPlan(plan, planSource);

  // the checks a variant is screened against: what the board declares, plus what the rules derived
  const declared = opts.constraints ?? {};
  const constraints: Record<string, Constraint> = { ...relationsToConstraints(classification.relations, declared), ...(parts[0] ? partitionToConstraints(design, parts[0]) : {}), ...declared };

  const variants = opts.variants ?? enumerateVariants({ partitions: parts.map((p) => p.key), hasReference: true, clearanceNm: design.board.rules.clearanceNm, ...(opts.budget ? { budget: opts.budget } : {}) });
  const copied = applyPlacements(design, transfer.placements);
  const referenceHpwl = placementMetrics({ design: copied, verify: verifyDesign({ design: copied, ...(opts.profile ? { profile: opts.profile } : {}) }), runtimeSeconds: 0 }).hpwl_nm ?? 0;

  const screened: ScreenedVariant[] = [];
  const seen = new Map<string, string>();
  const measure = (id: string, option: string, note: string, placements: PlacedComponent[], unplacedIds: string[], phases: PhaseReport[], seconds: number) => {
    const candidate = applyPlacements(design, placements);
    const verify = verifyDesign({ design: candidate, ...(opts.profile ? { profile: opts.profile } : {}), constraints });
    const pm = placementMetrics({ design: candidate, verify, runtimeSeconds: seconds });
    const intent = checkPlacementIntent(candidate, constraints);
    const moved = placements.map((p) => {
      const t = targets.get(refOf.get(p.id) ?? '');
      return t ? Math.hypot(p.at.x - t.x, p.at.y - t.y) : null;
    }).filter((v): v is number => v !== null);
    const metrics: ScreenMetrics = {
      legal: verify.gates.placement.passed && unplacedIds.length === 0,
      unplaced: unplacedIds.length,
      overlap: pm.courtyard_overlap_count ?? 0,
      outside: pm.outside_board_count ?? 0,
      hpwlNm: pm.hpwl_nm ?? 0,
      intentHard: (verify.metrics.intent_hard_violations ?? 0) + (intent.metrics.placement_intent_hard_violations ?? 0),
      displacementMm: moved.length ? moved.reduce((a, b) => a + b, 0) / moved.length / 1e6 : 0,
      loopAreaMm2: intent.metrics.loop_area_mm2 ?? 0,
      intrusions: intent.metrics.intrusion_count ?? 0,
      chainViolations: intent.metrics.chain_order_violations ?? 0,
      seconds,
    };
    const entry: ScreenedVariant = { id, option, note, placements, unplacedIds, phases, metrics, score: scoreOf(metrics, referenceHpwl), kept: false };
    const k = key(placements);
    const same = seen.get(k);
    if (same) entry.sameAs = same;
    else seen.set(k, id);
    screened.push(entry);
    log(`reuse: ${id} ${metrics.legal ? 'legal' : 'ILLEGAL'} placed=${placements.length}/${movableRefs.length} hpwl=${(metrics.hpwlNm / 1e6).toFixed(0)}mm score=${entry.score.toFixed(1)}${entry.sameAs ? ` (same as ${entry.sameAs})` : ''}`);
  };

  measure('copy', 'A', 'the reference placement, moved into this board\'s frame', transfer.placements, movable.filter((c) => !transfer.placements.some((p) => p.id === c.id)).map((c) => c.id), [], 0);
  for (const variant of variants) {
    const t0 = Date.now();
    const res = runPhases({
      design,
      plan,
      classification,
      movableRefs,
      targets,
      ...(variant.planFirst !== undefined ? { planFirst: variant.planFirst } : {}),
      attraction: variant.attraction,
      ...(variant.inflationNm !== undefined ? { inflationNm: variant.inflationNm } : {}),
      ...(variant.rotations ? { rotations: variant.rotations } : {}),
    });
    measure(variant.id, variant.option, variant.note, res.placements, res.unplacedIds, res.phases, (Date.now() - t0) / 1000);
  }

  // rank: legal first, then the score; identical placements are kept once
  const order = [...screened].sort((a, b) => Number(b.metrics.legal) - Number(a.metrics.legal) || a.score - b.score || a.id.localeCompare(b.id));
  const keep = opts.keep ?? 8;
  for (const v of order) {
    if (v.sameAs || screened.filter((x) => x.kept).length >= keep) continue;
    if (!v.placements.length) continue;
    v.kept = true;
  }
  const kept = order.filter((v) => v.kept);
  log(`reuse: screened ${screened.length} variant(s), ${screened.filter((v) => v.metrics.legal).length} legal, materialising ${kept.length}`);

  await mkdir(opts.runDir, { recursive: true });
  await writeFile(path.join(opts.runDir, 'screening.json'), JSON.stringify({
    match: { coverage: match.coverage, byTier: match.byTier, unmatched: match.unmatchedTarget.length },
    transform: transfer.transform,
    planSource,
    variants: screened.map((v) => ({ id: v.id, option: v.option, note: v.note, metrics: v.metrics, score: v.score, kept: v.kept, ...(v.sameAs ? { sameAs: v.sameAs } : {}) })),
  }, null, 2), 'utf8');
  await writeFile(path.join(opts.runDir, 'placement-plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  await writeFile(path.join(opts.runDir, 'delta.md'), `${deltaTable(delta)}\n`, 'utf8');

  if (!kept.length) return { runDir: opts.runDir, match, delta, transform: transfer.transform, plan, planSource, screened, place: null, criticalRoutes: new Map(), ranking: null };

  const registry: EngineRegistry = defaultPlacerRegistry(opts.repoRoot);
  const ids: string[] = [];
  for (const v of kept) {
    const id = `placer-reuse-${v.id}`;
    registry.register(new PrecomputedPlacer(id, v.placements, v.unplacedIds, v.metrics.seconds), precomputedManifest(id));
    ids.push(id);
  }
  const place = await placeBoard({
    repoRoot: opts.repoRoot,
    boardPath: opts.boardPath,
    ...(projectPath ? { projectPath } : {}),
    runDir: opts.runDir,
    registry,
    placers: ids,
    mode: 'race',
    // the variants are complete placements: `placeBoard`'s own staged pre-placement
    // would move parts before they ran and leave the board a mixture of the two
    attached: [],
    ...(opts.movableReferences ? { movableReferences: opts.movableReferences } : {}),
    ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.scoring ? { scoring: opts.scoring } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.noKicad ? { noKicad: true } : {}),
    constraints,
    maxParallel: 1,
    log,
  });
  // the critical nets, on the boards that survived materialising
  const criticalRoutes = new Map<string, CriticalRouteResult>();
  let ranking: Ranking | null = place.ranking;
  if (opts.criticalRoute !== false) {
    const nets = criticalNetNames(design, classification, constraints);
    // RFC 15 Section 5.1: the critical nets of the top five are routed.
    const cap = opts.criticalRoute?.maxCandidates ?? 5;
    const eligible = place.ranking.candidates.filter((c) => c.eligible).slice(0, cap);
    if (nets.length && eligible.length) {
      log(`reuse: routing ${nets.length} critical net(s) on ${eligible.length} candidate(s): ${nets.join(', ')}`);
      for (const c of eligible) {
        const cand = place.candidates.find((x) => x.engineId === c.id);
        if (!cand) continue;
        const res = await routeCriticalNets({
          repoRoot: opts.repoRoot,
          boardPath: cand.pcbPath,
          workDir: path.join(opts.runDir, 'critical', c.id),
          nets,
          ...(opts.criticalRoute?.routerId ? { routerId: opts.criticalRoute.routerId } : {}),
          ...(opts.criticalRoute?.budgetSeconds ? { budgetSeconds: opts.criticalRoute.budgetSeconds } : {}),
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
          ...(opts.profile ? { profile: opts.profile } : {}),
          ...(opts.noKicad ? { noKicad: true } : {}),
          log,
        });
        criticalRoutes.set(c.id, res);
      }
      // rank again, now that the boards have been asked the question that matters
      const scored = place.ranking.candidates.map((c) => {
        const cr = criticalRoutes.get(c.id);
        return {
          id: c.id,
          metrics: {
            ...c.metrics,
            ...(cr && !cr.unavailable
              ? { critical_completion: cr.completion, critical_drc: cr.drcCritical, critical_length_nm: Object.values(cr.lengthNm).reduce((a, b) => a + b, 0) }
              : {}),
          },
          gatesPassed: c.gatesPassed,
          gateFailures: c.gateFailures,
          ...(c.hardIntentViolations !== undefined ? { hardIntentViolations: c.hardIntentViolations } : {}),
          ...(c.softIntentViolations !== undefined ? { softIntentViolations: c.softIntentViolations } : {}),
        };
      });
      ranking = rank(scored, loadScoringProfile(opts.scoring ?? 'engineering-placement-2-layer'));
      await writeFile(path.join(opts.runDir, 'critical-routing.json'), JSON.stringify(Object.fromEntries(criticalRoutes), null, 2), 'utf8');
      log(`reuse: after critical routing, ${ranking.selected ?? 'no candidate'} leads`);
    }
  }
  // The final ranking is the one the run stands by: its outcome says what was
  // selected, and what --apply writes. The ranking it replaced is kept.
  let finalPlace = place;
  if (ranking && ranking !== place.ranking) {
    await writeFile(path.join(place.runDir, 'ranking-before-critical.json'), JSON.stringify(place.ranking, null, 2), 'utf8');
    await writeFile(path.join(place.runDir, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
    const outcome = outcomeOf(place.invocations, place.candidates, ranking, place.ineligible);
    await writeFile(path.join(place.runDir, 'outcome.json'), JSON.stringify(slim(outcome), null, 2), 'utf8');
    finalPlace = { ...place, outcome, ranking };
  }
  return { runDir: opts.runDir, match, delta, transform: transfer.transform, plan, planSource, screened, place: finalPlace, criticalRoutes, ranking };
}
