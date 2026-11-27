/**
 * Engine runner (RFC 11 §9.3, §9.4, §17; implementation spec §6.5): executes
 * a job on eligible engines from one immutable snapshot under single, race,
 * staged, or ensemble mode. Every invocation gets its own directory, a
 * scrubbed environment, a provenance record, a budget charge, and a snapshot
 * integrity check afterwards; an engine that touched its input yields
 * INVALID_OUTPUT rather than a silently corrupted source.
 */
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { copperStack } from '../ir/layers.js';
import path from 'node:path';
import type { BoardSnapshot } from '../ir/snapshot.js';
import { verifySnapshotIntact, makeSnapshot, type RunDir } from '../ir/snapshot.js';
import { EngineError } from '../ir/status.js';
import type { PcbDesign } from '../ir/types.js';
import { applyCandidate } from '../ir/kicad/export.js';
import type { EngineManifest, RoutingJob, RoutingResult, PlacementJob, PlacementResult, RouterPlugin, PlacerPlugin, RunContext, EngineProvenance } from './contracts.js';
import { eligible, type RegisteredEngine, type EnginePolicy, type JobShape, DEFAULT_POLICY } from './registry.js';
import { Budget } from './budget.js';

export type ExecutionMode = 'single' | 'race' | 'staged' | 'ensemble';

export interface Invocation<TResult> {
  engineId: string;
  manifest: EngineManifest;
  /** Directory holding job.json, result.json, provenance.json, logs. */
  workDir: string;
  result: TResult | null;
  error: { kind: string; message: string; fix?: string } | null;
  provenance: EngineProvenance;
  /** Set when the snapshot changed under the engine (INVALID_OUTPUT). */
  snapshotViolation: string | null;
  /** staged mode: which stage produced this invocation; a final branch also carries the copper of the earlier stages. */
  stage?: { index: number; name: string; final: boolean; carried?: { segments: RoutingResult['segments']; arcs: RoutingResult['arcs']; vias: RoutingResult['vias'] } };
}

export interface RunOptions {
  run: RunDir;
  /** Text of the source board the snapshot was imported from (exported per job for engines that read files). */
  sourceText: string;
  design: PcbDesign;
  projectText?: string;
  snapshotFileHash: string;
  policy?: EnginePolicy;
  budget: Budget;
  maxParallel?: number;
  log?: (line: string) => void;
  onEvent?: (event: Record<string, unknown>) => void;
}

async function event(run: RunDir, onEvent: RunOptions['onEvent'], ev: Record<string, unknown>): Promise<void> {
  const line = { at: new Date().toISOString(), ...ev };
  await appendFile(path.join(run.root, 'events.jsonl'), JSON.stringify(line) + '\n', 'utf8');
  onEvent?.(line);
}

async function prepareWorkDir(opts: RunOptions, engineId: string, ordinal: number, boardText: string): Promise<{ workDir: string; boardPath: string; projectPath?: string }> {
  const workDir = path.join(opts.run.candidatesDir, `${engineId}-${ordinal}`);
  await mkdir(workDir, { recursive: true });
  const boardPath = path.join(workDir, 'board.kicad_pcb');
  await writeFile(boardPath, boardText, 'utf8');
  let projectPath: string | undefined;
  if (opts.projectText) {
    projectPath = path.join(workDir, 'board.kicad_pro');
    await writeFile(projectPath, opts.projectText, 'utf8');
  }
  return { workDir, boardPath, ...(projectPath ? { projectPath } : {}) };
}

async function invoke<TJob extends { runId: string; seed: number; limits: { wallSeconds: number; engineSeconds: number } }, TResult extends { status: string; runtime: { wallSeconds: number; engineSeconds?: number }; provenance: EngineProvenance }>(
  opts: RunOptions,
  engine: RegisteredEngine,
  ordinal: number,
  job: TJob,
  boardText: string,
  call: (plugin: RouterPlugin & PlacerPlugin, job: TJob, ctx: RunContext) => Promise<TResult>,
): Promise<Invocation<TResult>> {
  const { workDir, boardPath, projectPath } = await prepareWorkDir(opts, engine.manifest.id, ordinal, boardText);
  await writeFile(path.join(workDir, 'job.json'), JSON.stringify({ ...job, snapshot: { hash: (job as unknown as { snapshot: BoardSnapshot }).snapshot.hash } }), 'utf8');
  const stdout: string[] = [];
  const ctx: RunContext = {
    workDir,
    boardPath,
    ...(projectPath ? { projectPath } : {}),
    log: (line) => {
      stdout.push(line);
      opts.log?.(`[${engine.manifest.id}] ${line}`);
    },
    progress: (fraction, note) => void event(opts.run, opts.onEvent, { event: 'progress', engineId: engine.manifest.id, fraction, note }),
  };
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  await event(opts.run, opts.onEvent, { event: 'engine-start', engineId: engine.manifest.id, version: engine.manifest.version, ordinal });
  let result: TResult | null = null;
  let error: Invocation<TResult>['error'] = null;
  try {
    result = await call(engine.plugin as RouterPlugin & PlacerPlugin, job, ctx);
  } catch (e) {
    error = e instanceof EngineError ? { kind: e.kind, message: e.message, fix: e.fix } : { kind: 'process-failed', message: (e as Error).message };
  }
  const wall = (Date.now() - t0) / 1000;
  const finishedAt = new Date().toISOString();
  const provenance: EngineProvenance = result?.provenance ?? { engineId: engine.manifest.id, engineVersion: engine.manifest.version, adapterVersion: engine.manifest.adapterVersion, seed: job.seed, startedAt, finishedAt };
  provenance.startedAt = startedAt;
  provenance.finishedAt = finishedAt;
  opts.budget.charge(engine.manifest.id, result?.runtime.engineSeconds ?? wall, wall, error ? `failed: ${error.kind}` : undefined);
  const intact = await verifySnapshotIntact(opts.run, { fileHash: opts.snapshotFileHash, designHash: opts.design.source.contentHash });
  const snapshotViolation = intact.ok ? null : intact.reason;
  await writeFile(path.join(workDir, 'stdout.log'), stdout.join('\n'), 'utf8');
  await writeFile(path.join(workDir, 'provenance.json'), JSON.stringify(provenance, null, 2), 'utf8');
  if (result) await writeFile(path.join(workDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  if (error) await writeFile(path.join(workDir, 'error.json'), JSON.stringify(error, null, 2), 'utf8');
  await event(opts.run, opts.onEvent, { event: 'engine-end', engineId: engine.manifest.id, ordinal, wallSeconds: wall, status: error ? `error:${error.kind}` : result?.status, snapshotViolation });
  return { engineId: engine.manifest.id, manifest: engine.manifest, workDir, result, error, provenance, snapshotViolation };
}

async function parallel<T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await items[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export interface RoutingRun {
  mode: ExecutionMode;
  invocations: Invocation<RoutingResult>[];
  ineligible: { engineId: string; reasons: string[] }[];
}

export interface RoutingRunOptions extends RunOptions {
  snapshot: BoardSnapshot;
  engines: RegisteredEngine[];
  mode: ExecutionMode;
  job: Omit<RoutingJob, 'runId' | 'snapshot'>;
  /** staged: ordered steps; each routes its net scope, preserving the copper so far. A racing stage fans out one branch per engine. */
  stages?: { name: string; engineIds: string[]; netIds: string[] | null; strategy?: RoutingJob['strategy']; race?: boolean }[];
  shape?: Partial<JobShape>;
}

export async function runRouting(opts: RoutingRunOptions): Promise<RoutingRun> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const copperLayers = copperStack(opts.design).length;
  const shape: JobShape = { kind: 'router', hardConstraintKinds: [], copperLayers, ...opts.shape };
  const ineligible: RoutingRun['ineligible'] = [];
  const usable = opts.engines.filter((e) => {
    const el = eligible(e, shape, policy);
    if (!el.ok) ineligible.push({ engineId: e.manifest.id, reasons: el.reasons });
    return el.ok;
  });
  const mk = (i: number, extra: Partial<RoutingJob> = {}): RoutingJob => ({ runId: `${path.basename(opts.run.root)}-${i}`, snapshot: opts.snapshot, ...opts.job, ...extra });
  const invocations: Invocation<RoutingResult>[] = [];
  /** An engine the run's budget can no longer afford is recorded, not started. */
  const skipped = (engine: RegisteredEngine): Invocation<RoutingResult> => ({ engineId: engine.manifest.id, manifest: engine.manifest, workDir: '', result: null, error: { kind: 'timeout', message: 'budget exhausted before start' }, provenance: { engineId: engine.manifest.id, engineVersion: engine.manifest.version, adapterVersion: engine.manifest.adapterVersion, seed: opts.job.seed, startedAt: '', finishedAt: '' }, snapshotViolation: null });
  /** Each invocation's limits are the job's, clamped to a share of what the run's budget still holds: five engines in a staged run must not each take the whole budget, and a stage before the last takes at most half so the final stage at the rule always runs (B4: Freerouting spends its whole allotment on a board it cannot finish). */
  const clamped = (share = 1): RoutingJob['limits'] => {
    const r = opts.budget.remaining;
    return { ...opts.job.limits, engineSeconds: Math.max(1, Math.min(opts.job.limits.engineSeconds, Math.floor(r.engineSeconds * share))), wallSeconds: Math.max(1, Math.min(opts.job.limits.wallSeconds, Math.floor(r.wallSeconds * share))) };
  };
  if (opts.mode === 'staged') {
    const { importBoard } = await import('../ir/kicad/import.js');
    let design = opts.design;
    let text = opts.sourceText;
    let snapshot = opts.snapshot;
    const carried: NonNullable<NonNullable<Invocation<RoutingResult>['stage']>['carried']> = { segments: [], arcs: [], vias: [] };
    const stages = opts.stages ?? [];
    let ordinal = 0;
    for (const [i, step] of stages.entries()) {
      const engines = step.engineIds.map((id) => usable.find((e) => e.manifest.id === id)).filter((e): e is RegisteredEngine => !!e);
      for (const id of step.engineIds) if (!engines.some((e) => e.manifest.id === id) && !ineligible.some((x) => x.engineId === id)) ineligible.push({ engineId: id, reasons: [`not eligible for stage ${step.name}`] });
      if (!engines.length) {
        opts.log?.(`stage ${step.name}: no eligible engine, skipped`);
        continue;
      }
      const final = i === stages.length - 1;
      const chosen = step.race ? engines : engines.slice(0, 1);
      const stageSnapshot = snapshot;
      // the first stage honours the job's preserve flag (a rip-up run must drop the existing copper); later stages keep what the earlier ones routed
      const job = (extra: Partial<RoutingJob>) => mk(ordinal, { snapshot: stageSnapshot, scope: { netIds: step.netIds, region: null, preserveExistingRoutes: i === 0 ? opts.job.scope.preserveExistingRoutes : true }, ...(step.strategy ? { strategy: step.strategy } : {}), ...extra });
      const snapshotText = text;
      const carriedNow = { segments: [...carried.segments], arcs: [...carried.arcs], vias: [...carried.vias] };
      const tasks = chosen.map((engine) => {
        const n = ordinal++;
        return async () => {
          const inv = opts.budget.affords({ engineSeconds: 1, wallSeconds: 1 })
            ? await invoke(opts, engine, n, job({ runId: `${path.basename(opts.run.root)}-${n}`, limits: clamped(final ? 1 : 0.5) }), snapshotText, (p, j, c) => p.route(j, c))
            : skipped(engine);
          if (!inv.workDir) opts.log?.(`stage ${step.name}: ${engine.manifest.id} not started, the budget is spent`);
          // every stage carries the copper routed before it, so a stage the budget cuts off before the last one can still be judged
          inv.stage = { index: i, name: step.name, final, carried: carriedNow };
          return inv;
        };
      });
      const got = await parallel(tasks, step.race ? (opts.maxParallel ?? 2) : 1);
      invocations.push(...got);
      if (final) break;
      // carry the first successful branch's copper into the next stage
      const ok = got.find((inv) => inv.result && inv.result.status !== 'failed' && inv.result.status !== 'unsupported' && !inv.snapshotViolation);
      if (!ok?.result) {
        opts.log?.(`stage ${step.name}: no engine produced copper; the next stage routes its nets too`);
        continue;
      }
      // a rip-up run drops the board's existing copper at the first stage; later stages build on what the earlier ones routed
      const keepExisting = i > 0 || opts.job.scope.preserveExistingRoutes;
      const base = keepExisting ? design.routing : { segments: [], arcs: [], vias: [] };
      // an engine that was told to preserve the existing copper echoes it back (Freerouting re-emits every wire in the session):
      // the composite keeps one copy of each piece of copper
      const routing = dedupeCopper({ segments: [...base.segments, ...ok.result.segments], arcs: [...base.arcs, ...ok.result.arcs], vias: [...base.vias, ...ok.result.vias] });
      const preserved = new Set<string>(keepExisting ? [...design.routing.segments.map((s) => s.id), ...design.routing.arcs.map((a) => a.id), ...design.routing.vias.map((v) => v.id)] : []);
      text = applyCandidate(text, design, { routing: { ...routing, preserveIds: preserved } }).text;
      design = importBoard({ boardText: text, boardPath: design.source.files.board, ...(opts.projectText ? { projectText: opts.projectText } : {}), now: design.source.importedAt }).design;
      const fresh = dedupeCopper({ segments: [...carried.segments, ...ok.result.segments], arcs: [...carried.arcs, ...ok.result.arcs], vias: [...carried.vias, ...ok.result.vias] });
      carried.segments.splice(0, carried.segments.length, ...fresh.segments);
      carried.arcs.splice(0, carried.arcs.length, ...fresh.arcs);
      carried.vias.splice(0, carried.vias.length, ...fresh.vias);
      snapshot = makeSnapshot(design, { kind: 'routing', netIds: opts.snapshot.scope.kind === 'routing' ? opts.snapshot.scope.netIds : null, region: null, preserveExistingRoutes: true }, { seed: opts.snapshot.seed, limits: opts.snapshot.limits });
    }
    return { mode: opts.mode, invocations, ineligible };
  }
  const chosen = opts.mode === 'single' ? usable.slice(0, 1) : usable;
  const tasks = chosen.map((engine, i) => async () => {
    if (!opts.budget.affords({ engineSeconds: 1, wallSeconds: 1 })) return skipped(engine);
    return invoke(opts, engine, i, mk(i, { limits: clamped() }), opts.sourceText, (p, j, c) => p.route(j, c));
  });
  invocations.push(...(await parallel(tasks, opts.mode === 'race' || opts.mode === 'ensemble' ? (opts.maxParallel ?? 2) : 1)));
  return { mode: opts.mode, invocations, ineligible };
}

export interface PlacementRunOptions extends RunOptions {
  snapshot: BoardSnapshot;
  engines: RegisteredEngine[];
  mode: Exclude<ExecutionMode, 'staged'>;
  job: Omit<PlacementJob, 'runId' | 'snapshot'>;
  shape?: Partial<JobShape>;
}

export async function runPlacement(opts: PlacementRunOptions): Promise<{ mode: ExecutionMode; invocations: Invocation<PlacementResult>[]; ineligible: RoutingRun['ineligible'] }> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const copperLayers = copperStack(opts.design).length;
  const shape: JobShape = { kind: 'placer', hardConstraintKinds: [], copperLayers, ...opts.shape };
  const ineligible: RoutingRun['ineligible'] = [];
  const usable = opts.engines.filter((e) => {
    const el = eligible(e, shape, policy);
    if (!el.ok) ineligible.push({ engineId: e.manifest.id, reasons: el.reasons });
    return el.ok;
  });
  const chosen = opts.mode === 'single' ? usable.slice(0, 1) : usable;
  const tasks = chosen.map((engine, i) => () => invoke(opts, engine, i, { runId: `${path.basename(opts.run.root)}-${i}`, snapshot: opts.snapshot, ...opts.job }, opts.sourceText, (p, j, c) => p.place(j, c)));
  const invocations = await parallel(tasks, opts.mode === 'single' ? 1 : (opts.maxParallel ?? 2));
  return { mode: opts.mode, invocations, ineligible };
}

/** One copy of each piece of copper, by geometry: layer, endpoints (either way round), width, and net. */
export function dedupeCopper<T extends { segments: { netId: string; layer: string; a: { x: number; y: number }; b: { x: number; y: number }; width: number }[]; arcs: { netId: string; layer: string; a: { x: number; y: number }; mid: { x: number; y: number }; b: { x: number; y: number }; width: number }[]; vias: { netId: string; at: { x: number; y: number }; size: number }[] }>(r: T): T {
  const seen = new Set<string>();
  const key = (...parts: (string | number)[]) => parts.join('|');
  const segments = r.segments.filter((s) => {
    const ends = [`${s.a.x},${s.a.y}`, `${s.b.x},${s.b.y}`].sort();
    const k = key('s', s.netId, s.layer, ends[0]!, ends[1]!, s.width);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const arcs = r.arcs.filter((a) => {
    const ends = [`${a.a.x},${a.a.y}`, `${a.b.x},${a.b.y}`].sort();
    const k = key('a', a.netId, a.layer, ends[0]!, ends[1]!, `${a.mid.x},${a.mid.y}`, a.width);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const vias = r.vias.filter((v) => {
    const k = key('v', v.netId, `${v.at.x},${v.at.y}`, v.size);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ...r, segments, arcs, vias };
}
