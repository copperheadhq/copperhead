/**
 * The closed loop (RFC 11 §12, implementation spec §9 and §11): place, route,
 * verify, repair within a budget, record. `pcb layout` and the pipeline call
 * this; the model appears only through the repair planner's one JSON-validated
 * turn per cycle, and never places or routes anything itself.
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CopperheadConfig } from '../../config.js';
import type { Provider } from '../../agent/types.js';
import { placeBoard, defaultPlacerRegistry, type PlaceRun } from '../engines/place.js';
import { routeBoard, defaultRegistry as defaultRouterRegistry, type RouteRun } from '../engines/route.js';
import { EngineRegistry, type EnginePolicy } from '../engines/registry.js';
import type { Outcome, LayoutStatus } from '../ir/status.js';
import type { Diagnostic } from '../verify/diagnostic.js';
import { importBoard } from '../ir/kicad/import.js';
import { applyCandidate } from '../ir/kicad/export.js';
import { writeBoardRender } from '../engines/render.js';
import { verifyDesign } from '../verify/index.js';
import { extractFills } from '../ir/kicad/zones.js';
import { deriveBlocks } from '../intent/blocks.js';
import { loadConstraints } from '../intent/load.js';
import { readCache, applicable, toStageInputs } from '../intent/references.js';
import { evidenceFromRun, recordEvidence } from '../layout-stage.js';
import type { LayoutEvidence, ContractVerdict } from '../evidence.js';
import { planRepair } from './repair/planner.js';
import type { RepairAction } from './repair/catalog.js';

export interface LayoutOptions {
  repoRoot: string;
  config: CopperheadConfig;
  boardPath: string;
  runDir: string;
  /** Skip placement (route the board as placed). */
  place?: boolean;
  /** Skip routing (place only). */
  route?: boolean;
  budgetSeconds?: number;
  maxRepairCycles?: number;
  seed?: number;
  provider?: Provider | null;
  policy?: EnginePolicy;
  placerRegistry?: EngineRegistry;
  routerRegistry?: EngineRegistry;
  probeRouter?: string;
  /** Write the result over the board file when it ends PASS or PARTIAL. */
  apply?: boolean;
  log?: (line: string) => void;
}

export interface LayoutCycle {
  n: number;
  action: RepairAction | null;
  status: LayoutStatus;
  summary: string;
  errors: number;
  owed: number;
  seconds: number;
}

export interface LayoutResult {
  outcome: Outcome<Diagnostic>;
  runDir: string;
  /** The board text of the selected result (the working board after the last cycle). */
  boardPath: string;
  applied: boolean;
  evidence: LayoutEvidence | null;
  verdict: ContractVerdict | null;
  cycles: LayoutCycle[];
  placement: PlaceRun | null;
  routing: RouteRun | null;
  holds: string[];
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function layoutBoard(opts: LayoutOptions): Promise<LayoutResult> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const pcb = opts.config.pcb ?? {};
  const budget = opts.budgetSeconds ?? pcb.budgetSeconds ?? 600;
  const maxCycles = opts.maxRepairCycles ?? opts.config.maxRepairCycles ?? 3;
  const policy: EnginePolicy = opts.policy ?? { network: pcb.allowRemoteEngines ? 'required' : 'optional', allowHarnessEngines: pcb.allowHarnessEngines ?? false, denyLicenses: [] };
  const placers = opts.placerRegistry ?? defaultPlacerRegistry(opts.repoRoot);
  const routers = opts.routerRegistry ?? defaultRouterRegistry(opts.repoRoot);
  const routerIds = pcb.routers ?? routers.list('router').map((e) => e.manifest.id);
  await mkdir(opts.runDir, { recursive: true });
  // the working board: a copy the cycles write to; the user's file changes only on apply
  const work = path.join(opts.runDir, 'board.kicad_pcb');
  await copyFile(opts.boardPath, work);
  const proSrc = opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
  if (existsSync(proSrc)) await copyFile(proSrc, work.replace(/\.kicad_pcb$/, '.kicad_pro'));
  const docsDir = path.join(opts.repoRoot, opts.config.docs);
  const holds: string[] = [];
  const cycles: LayoutCycle[] = [];
  const history: RepairAction[] = [];
  let placement: PlaceRun | null = null;
  let routing: RouteRun | null = null;
  let lastRoutingSeconds = 0, lastPlacementSeconds = 0;
  let routeStrategy: Record<string, string | number | boolean> = {};
  let routeOrder: string[] | null = null;
  let routerPick: string[] | null = null;
  let ripUp: string[] | null = null;
  let bestOutcome: Outcome<Diagnostic> | null = null;
  let bestRuns: { routing: RouteRun | null; placement: PlaceRun | null } = { routing: null, placement: null };
  let rolledBack = false;
  /** Owed connections are info-severity and the outcome drops them: count them on the selected candidate of the run that produced the outcome. */
  const owedByOutcome = new WeakMap<Outcome<Diagnostic>, number>();
  const selectedDiagsOf = (r: RouteRun | PlaceRun | null): Diagnostic[] | null => (r && r.ranking.selected ? r.candidates.find((c) => c.engineId === r.ranking.selected)?.verify.diagnostics ?? null : null);
  const owedOf = (o: Outcome<Diagnostic>): number => owedByOutcome.get(o) ?? o.diagnostics.filter((d) => d.code === 'conn.unrouted').length;
  // whole seconds: the limits land in the snapshot, whose canonical form holds integers only
  const remaining = () => ({ engineSeconds: Math.max(0, Math.floor(budget - (Date.now() - t0) / 1000)), wallSeconds: Math.max(0, Math.floor(budget - (Date.now() - t0) / 1000)) });

  // intent: the board's own rules plus the intent file; blocks from the docs; approved reference blocks
  const first = importBoard({ boardText: await readFile(work, 'utf8'), boardPath: work });
  const loaded = await loadConstraints(first.design, opts.boardPath, { intentPath: pcb.intentPath ?? null, docsDir, repoRoot: opts.repoRoot });
  holds.push(...loaded.holds);
  const subsystems = path.join(docsDir, 'SUBSYSTEMS.md');
  const schematicIntentPath = opts.config.schematic ? path.join(path.dirname(path.join(opts.repoRoot, opts.config.schematic)), 'schematic.intent.json') : null;
  const blocks = deriveBlocks({ design: first.design, subsystemsMd: existsSync(subsystems) ? await readFile(subsystems, 'utf8') : null, schematicIntent: schematicIntentPath && existsSync(schematicIntentPath) ? JSON.parse(await readFile(schematicIntentPath, 'utf8')) : null });
  const refs = applicable((await readCache(opts.repoRoot)).filter((b) => blocks.some((k) => k.anchor === b.target.anchorId)));
  const reuse = refs.map((b) => toStageInputs(b).reuse);
  const refAttached = refs.flatMap((b) => toStageInputs(b).attached);
  if (holds.length) {
    const outcome: Outcome<Diagnostic> = { status: 'HOLD', summary: `intent holds: ${holds[0]}${holds.length > 1 ? ` (+${holds.length - 1})` : ''}`, detail: holds, diagnostics: [] };
    await writeFile(path.join(opts.runDir, 'outcome.json'), JSON.stringify(outcome, null, 2), 'utf8');
    await writeBoardRender(opts.runDir, first.design, [], log);
    return { outcome, runDir: opts.runDir, boardPath: work, applied: false, evidence: null, verdict: null, cycles, placement: null, routing: null, holds };
  }

  const runPlacement = async (n: number, moveGroup?: { refs: string[]; dx: number; dy: number }): Promise<Outcome<Diagnostic>> => {
    const t = Date.now();
    if (moveGroup) {
      // a planner move: apply it to the working board first, then let the plan re-place the rest with those parts held
      const d = importBoard({ boardText: await readFile(work, 'utf8'), boardPath: work }).design;
      const moved = d.components.filter((c) => moveGroup.refs.includes(c.reference)).map((c) => ({ id: c.id, at: { x: c.at.x + moveGroup.dx, y: c.at.y + moveGroup.dy }, rotation: c.rotation, side: c.attributes.side }));
      await writeFile(work, applyCandidate(await readFile(work, 'utf8'), d, { placement: moved }).text, 'utf8');
    }
    placement = await placeBoard({
      repoRoot: opts.repoRoot, boardPath: work, runDir: path.join(opts.runDir, `cycle-${n}`, 'placement'), ...(pcb.placers ? { placers: pcb.placers } : {}), mode: pcb.mode === 'staged' || !pcb.mode ? 'ensemble' : pcb.mode, seed: opts.seed ?? 0,
      limits: { engineSeconds: Math.max(10, Math.floor(remaining().engineSeconds / 2)), wallSeconds: Math.max(10, Math.floor(remaining().wallSeconds / 2)) }, policy, registry: placers, probe: { ...(opts.probeRouter ? { routerId: opts.probeRouter } : {}), registry: routers, budgetSeconds: Math.min(120, Math.max(10, Math.floor(remaining().engineSeconds / 4))) },
      blocks, ...(reuse.length ? { reuse } : {}), ...(refAttached.length ? { attached: [...refAttached] } : {}), docsDir, intentPath: pcb.intentPath ?? null,
      ...(moveGroup ? { movableReferences: importBoard({ boardText: await readFile(work, 'utf8'), boardPath: work }).design.components.filter((c) => !moveGroup.refs.includes(c.reference)).map((c) => c.reference) } : {}),
      log: (l) => log(`  place: ${l}`),
    });
    lastPlacementSeconds = (Date.now() - t) / 1000;
    const sel = placement.ranking.selected ? placement.candidates.find((c) => c.engineId === placement!.ranking.selected) : undefined;
    if (sel && (placement.outcome.status === 'PASS' || placement.outcome.status === 'PARTIAL')) await copyFile(sel.pcbPath, work);
    return placement.outcome;
  };

  const runRouting = async (n: number): Promise<Outcome<Diagnostic>> => {
    const t = Date.now();
    // the first pass takes the whole budget: B4 measured that saving half for repair cost two real boards their clean pass and repaired none; repairs run on what remains
    const share = 1;
    routing = await routeBoard({
      repoRoot: opts.repoRoot, boardPath: work, runDir: path.join(opts.runDir, `cycle-${n}`, 'routing'), routers: routerPick ?? routerIds, mode: 'staged', seed: opts.seed ?? 0,
      limits: { engineSeconds: Math.max(10, Math.floor(remaining().engineSeconds * share)), wallSeconds: Math.max(10, Math.floor(remaining().wallSeconds * share)) }, policy, registry: routers, strategy: routeStrategy,
      ...(routeOrder ? { criticalNetNames: routeOrder } : {}), ...(ripUp ? { netNames: ripUp, preserveExistingRoutes: true } : {}), ...(pcb.maxParallelEngines ? { maxParallel: pcb.maxParallelEngines } : {}),
      log: (l) => log(`  route: ${l}`),
    });
    lastRoutingSeconds = (Date.now() - t) / 1000;
    const sel = routing.ranking.selected ? routing.candidates.find((c) => c.engineId === routing!.ranking.selected) : undefined;
    if (sel && (routing.outcome.status === 'PASS' || routing.outcome.status === 'PARTIAL')) await copyFile(sel.pcbPath, work);
    return routing.outcome;
  };

  // cycle 0: place, route
  let outcome: Outcome<Diagnostic> = { status: 'PARTIAL', summary: 'nothing ran', detail: [], diagnostics: [] };
  const RANK: Record<string, number> = { PASS: 0, PARTIAL: 1, HOLD: 2, UNSUPPORTED: 3, TIMEOUT: 4, ENGINE_ERROR: 5, INVALID_OUTPUT: 6, REFUSE: 7 };
  const score = (o: Outcome<Diagnostic>) => [RANK[o.status] ?? 9, o.diagnostics.filter((d) => d.severity === 'error').length, owedOf(o)];
  const worse = (a: Outcome<Diagnostic>, b: Outcome<Diagnostic>) => { const x = score(a), y = score(b); return x[0]! > y[0]! || (x[0] === y[0] && (x[1]! > y[1]! || (x[1] === y[1] && x[2]! > y[2]!))); };
  const best = path.join(opts.runDir, 'best.kicad_pcb');
  const record = (n: number, action: RepairAction | null, o: Outcome<Diagnostic>, t: number) => {
    const owed = (selectedDiagsOf(routing) ?? o.diagnostics).filter((d) => d.code === 'conn.unrouted').length;
    owedByOutcome.set(o, owed);
    cycles.push({ n, action, status: o.status, summary: o.summary, errors: o.diagnostics.filter((d) => d.severity === 'error').length, owed, seconds: (Date.now() - t) / 1000 });
    log(`cycle ${n}${action ? ` (${action.type})` : ''}: ${o.status}: ${o.summary}`);
  };
  const tc = Date.now();
  if (opts.place !== false) {
    outcome = await runPlacement(0);
    if (outcome.status === 'REFUSE' || outcome.status === 'HOLD' || outcome.status === 'UNSUPPORTED' || outcome.status === 'INVALID_OUTPUT') {
      record(0, null, outcome, tc);
      return finish(outcome);
    }
  }
  if (opts.route !== false) outcome = await runRouting(0);
  record(0, null, outcome, tc);
  await copyFile(work, best);
  bestOutcome = outcome;
  bestRuns = { routing, placement };

  // repair cycles
  for (let n = 1; n <= maxCycles && outcome.status !== 'PASS'; n++) {
    if (outcome.status === 'HOLD' || outcome.status === 'REFUSE' || outcome.status === 'UNSUPPORTED' || outcome.status === 'INVALID_OUTPUT') break;
    const left = remaining();
    if (left.engineSeconds < 10) {
      log(`budget exhausted after cycle ${n - 1}`);
      break;
    }
    // plan over the selected candidate's full diagnostics: owed connections are info-severity and the outcome drops them
    const selectedDiags = selectedDiagsOf(routing) ?? selectedDiagsOf(placement) ?? outcome.diagnostics;
    const plan = await planRepair({ diagnostics: selectedDiags, ranking: (routing as RouteRun | null)?.ranking ?? (placement as PlaceRun | null)?.ranking ?? null, budgetRemaining: left, last: { routingSeconds: lastRoutingSeconds, placementSeconds: lastPlacementSeconds }, history, routers: routerIds, provider: opts.provider ?? null });
    if (!plan.action) {
      log(`no repair action: ${plan.reason}`);
      break;
    }
    const a = plan.action;
    history.push(a);
    log(`repair ${n}: ${a.type} (${plan.fromModel ? 'model' : 'policy'}): ${a.reason}`);
    if (a.type === 'request-user-action') {
      outcome = { status: 'HOLD', summary: `a hard constraint cannot be met here: ${a.reason}`, detail: [String(a.parameters.question ?? a.reason), ...outcome.detail], diagnostics: outcome.diagnostics };
      record(n, a, outcome, Date.now());
      break;
    }
    const tn = Date.now();
    routeOrder = null; ripUp = null;
    switch (a.type) {
      case 'tune-router': routeStrategy = { ...routeStrategy, ...(typeof a.parameters.passes === 'number' ? { passes: a.parameters.passes } : {}), ...(typeof a.parameters.strategy === 'string' ? { strategy: a.parameters.strategy } : {}) }; break;
      case 'select-router': routerPick = [String(a.parameters.routerId)]; break;
      case 'change-net-priority': routeOrder = Array.isArray(a.parameters.nets) ? (a.parameters.nets as string[]) : null; break;
      case 'rip-up-nets': ripUp = Array.isArray(a.parameters.nets) ? (a.parameters.nets as string[]) : null; break;
      // the owed nets are routed the way ripped-up ones are: scoped to those nets, every other piece of copper kept
      case 'continue-routing': ripUp = Array.isArray(a.parameters.nets) ? (a.parameters.nets as string[]) : null; break;
      case 'use-ranked-candidate': {
        const r: RouteRun | PlaceRun | null = (routing as RouteRun | null) ?? (placement as PlaceRun | null);
        const next = r?.ranking.candidates.filter((c) => c.eligible)[Number(a.parameters.rank ?? 2) - 1];
        const cand = next ? r!.candidates.find((c) => c.engineId === next.id) : undefined;
        if (cand) {
          await copyFile(cand.pcbPath, work);
          outcome = { ...outcome, status: (cand.verify.metrics.unrouted_count ?? 0) > 0 ? 'PARTIAL' : 'PASS', summary: `${next!.id} taken from the ranking`, diagnostics: cand.verify.diagnostics.filter((d) => d.severity !== 'info') };
        }
        record(n, a, outcome, tn);
        continue;
      }
      case 'move-group': case 'rotate-component': case 'resize-region': {
        const refs = Array.isArray(a.parameters.refs) ? (a.parameters.refs as string[]) : typeof a.parameters.ref === 'string' ? [a.parameters.ref] : [];
        const dx = Math.round(Number(a.parameters.dx_mm ?? 0) * 1e6), dy = Math.round(Number(a.parameters.dy_mm ?? 0) * 1e6);
        outcome = await runPlacement(n, refs.length ? { refs, dx, dy } : undefined);
        if (outcome.status === 'PASS' || outcome.status === 'PARTIAL') outcome = await runRouting(n);
        record(n, a, outcome, tn);
        outcome = await keepBest(n, outcome);
        continue;
      }
    }
    outcome = await runRouting(n);
    record(n, a, outcome, tn);
    outcome = await keepBest(n, outcome);
    // a router that made the cycle worse (declined the board, crashed) is not kept for the next action either
    if (a.type === 'select-router' && rolledBack) routerPick = null;
  }
  return finish(outcome);

  /** A cycle that ends worse than the best so far is rolled back: the working board and the outcome return to the best, the action stays tried. */
  async function keepBest(n: number, o: Outcome<Diagnostic>): Promise<Outcome<Diagnostic>> {
    rolledBack = false;
    if (bestOutcome && worse(o, bestOutcome)) {
      rolledBack = true;
      await copyFile(best, work);
      // the planner reads the selected candidate of the run behind the outcome: that is the best run again, not the one rolled back
      routing = bestRuns.routing;
      placement = bestRuns.placement;
      log(`cycle ${n} ended worse (${o.status}); kept the previous board (${bestOutcome.status})`);
      return bestOutcome;
    }
    bestOutcome = o;
    bestRuns = { routing, placement };
    await copyFile(work, best);
    return o;
  }

  async function finish(o: Outcome<Diagnostic>): Promise<LayoutResult> {
    let applied = false;
    let evidence: LayoutEvidence | null = null;
    let verdict: ContractVerdict | null = null;
    const finalRouting = routing as RouteRun | null;
    if (finalRouting) {
      // the evidence describes the routing run that produced the working board; the board hash is the working board's (or the user's, after apply)
      const target = opts.apply && (o.status === 'PASS' || o.status === 'PARTIAL') ? opts.boardPath : work;
      if (target === opts.boardPath) {
        await copyFile(work, opts.boardPath);
        applied = true;
      }
      const routingWithOutcome: RouteRun = { ...finalRouting, outcome: o };
      evidence = await evidenceFromRun(opts.repoRoot, target, routingWithOutcome);
      evidence.runDir = path.relative(opts.repoRoot, opts.runDir);
      evidence.cycles = cycles.map((c) => ({ n: c.n, action: c.action?.type ?? null, status: c.status, errors: c.errors, owed: c.owed }));
      // per-subsystem table from the blocks and the selected candidate's findings
      const sel = finalRouting.ranking.selected ? finalRouting.candidates.find((c) => c.engineId === finalRouting.ranking.selected) : undefined;
      if (sel && blocks.length) {
        const d = sel.design;
        const refOf = (id: string) => d.components.find((c) => c.id === id)?.reference ?? id;
        const padOwner = new Map<string, string>();
        for (const c of d.components) for (const pd of c.pads) padOwner.set(pd.id, c.id);
        evidence.blocks = blocks.filter((b) => b.id !== 'unassigned' || b.members.length).map((b) => {
          const members = new Set(b.members);
          const memberRefs = b.members.map(refOf);
          const anchor = b.anchor ? d.components.find((c) => c.id === b.anchor) : undefined;
          const spread = anchor ? Math.max(0, ...b.members.map((id) => { const c = d.components.find((x) => x.id === id); return c ? Math.hypot(c.at.x - anchor.at.x, c.at.y - anchor.at.y) : 0; })) : null;
          const unsatisfied = [...new Set(sel.verify.diagnostics.filter((x) => x.severity === 'error' && x.code.startsWith('intent.') && x.entityReferences.some((r) => memberRefs.includes(r))).map((x) => x.code))];
          const owed = sel.verify.diagnostics.filter((x) => x.code === 'conn.unrouted' && x.entityIds.some((id) => members.has(padOwner.get(id) ?? ''))).length;
          return { id: b.id, anchor: b.anchor ? refOf(b.anchor) : null, members: memberRefs, spreadMm: spread === null ? null : spread / 1e6, budgetMm: b.spreadBudgetNm ? b.spreadBudgetNm / 1e6 : null, unsatisfied, owed };
        });
      }
      if (applied) verdict = await recordEvidence(opts.repoRoot, opts.config.docs, target, evidence);
      else await writeFile(path.join(opts.runDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    }
    // the result, drawn: board.svg beside the working board, findings marked; a render failure never fails the run
    try {
      const text = await readFile(work, 'utf8');
      const d = importBoard({ boardText: text, boardPath: work }).design;
      const v = verifyDesign({ design: d, fills: extractFills(text), constraints: loaded.registry });
      await writeBoardRender(opts.runDir, d, v.diagnostics, log);
    } catch (err) {
      log(`render failed: ${(err as Error).message}`);
    }
    const detail = [...o.detail, ...cycles.map((c) => `cycle ${c.n}${c.action ? ` ${c.action.type}` : ''}: ${c.status}, ${c.errors} error(s), ${c.owed} owed, ${c.seconds.toFixed(1)} s`)];
    const outcome: Outcome<Diagnostic> = { ...o, detail };
    await writeFile(path.join(opts.runDir, 'outcome.json'), JSON.stringify({ ...outcome, diagnostics: outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, entityReferences: d.entityReferences })), cycles }, null, 2), 'utf8');
    return { outcome, runDir: opts.runDir, boardPath: work, applied, evidence, verdict, cycles, placement: placement as PlaceRun | null, routing: finalRouting, holds };
  }
}

export { nowStamp };
