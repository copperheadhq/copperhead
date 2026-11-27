/**
 * placer-reuse-pack (add-reuse-placer, RFC 14 §8): the plan, compiled into the
 * vendored tscircuit packer, phase by phase. The model — when there is one —
 * only ever wrote the plan; every coordinate here came out of the packer.
 *
 * One invocation is one variant: a partition, an attraction strength, an
 * inflation, and a rotation set. The sweep and the screening that picks the
 * variants worth materialising live in `engines/reuse/run.ts`; this adapter
 * stays a plain placer so `pcb place --placers placer-reuse-pack` works too.
 */
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import type { PcbDesign, Point } from '../../../ir/types.js';
import { movable, resultShape, constraintOf } from '../shared.js';
import { classifyCritical } from '../../../intent/critical.js';
import { partitions } from '../../../intent/subsystems.js';
import { matchComponents } from '../../reuse/match.js';
import { transferPlacement } from '../../reuse/transfer.js';
import { defaultPlan, validatePlan, type PlacementPlan } from '../../reuse/plan.js';
import { runPhases } from '../../reuse/phases.js';

export const REUSE_PACK_MANIFEST: EngineManifest = {
  id: 'placer-reuse-pack',
  kind: 'placer',
  version: '1',
  adapterVersion: '1',
  license: 'Apache-2.0',
  inputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  outputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  determinism: 'deterministic',
  executionMode: 'library',
  networkRequirement: 'none',
  harnessOnly: false,
  requires: {},
  capabilities: { bottomSide: true, rotation: true, arbitraryOutline: true, relativeConstraints: ['layout.plan', 'layout.reference'], fixedComponents: true, congestionAwareness: false, layoutReuse: true },
  supportedConstraints: ['mechanical', 'relative', 'functional', 'emc', 'thermal'],
};

/** One point in the variant space (RFC 14 §8.5). */
export interface PackVariant {
  id: string;
  /** Partition key, e.g. `sheet:support`; the first partition when absent. */
  partition?: string;
  /** Keep the reference's position wherever it is still legal (default true); false repacks everything. */
  planFirst?: boolean;
  /** Network weight of the pull toward the planned position. */
  attraction: number;
  /** Extra gap around every part, nanometres. */
  inflationNm?: number;
  rotations?: number[];
}

export const DEFAULT_VARIANT: PackVariant = { id: 'v0', attraction: 3 };

export class ReusePackPlacer implements PlacerPlugin {
  async manifest(): Promise<EngineManifest> {
    return REUSE_PACK_MANIFEST;
  }
  async place(job: PlacementJob, ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const started = new Date(t0).toISOString();
    const finish = (): PlacementResult['provenance'] => ({ engineId: REUSE_PACK_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: started, finishedAt: new Date().toISOString() });
    const design = job.snapshot.design;
    const moving = movable(job);
    const movableRefs = moving.map((c) => c.reference);
    const variant = constraintOf<PackVariant>(job, 'layout.variant') ?? DEFAULT_VARIANT;
    const reference = constraintOf<PcbDesign>(job, 'layout.reference');
    const classification = classifyCritical(design);

    // where the plan wants each part: the reference's positions, moved into this board's frame
    const targets = new Map<string, Point>();
    let coverage = 0;
    let transferred: ReturnType<typeof transferPlacement>['placements'] = [];
    if (reference) {
      const report = matchComponents(design, reference);
      coverage = report.coverage;
      const transfer = transferPlacement(design, reference, report.matches, { movableIds: new Set(moving.map((c) => c.id)) });
      transferred = transfer.placements;
      const refOf = new Map(design.components.map((c) => [c.id, c.reference]));
      for (const p of transfer.placements) {
        const r = refOf.get(p.id);
        if (r) targets.set(r, p.at);
      }
      ctx.log(`placer-reuse-pack: ${variant.id} on ${(coverage * 100).toFixed(0)} % reference coverage, fitted on ${transfer.fittedOn}`);
    }

    let plan = constraintOf<PlacementPlan>(job, 'layout.plan');
    if (!plan) {
      const all = partitions(design);
      const chosen = (variant.partition ? all.find((p) => p.key === variant.partition) : undefined) ?? all[0];
      if (!chosen) {
        ctx.log('placer-reuse-pack: the board has no subsystem partition; nothing to plan');
        return resultShape('unsupported', [], moving.map((c) => c.id), (Date.now() - t0) / 1000, finish());
      }
      plan = defaultPlan({
        design,
        movableRefs,
        partition: chosen,
        classification,
        ...(transferred.length ? { transferred } : {}),
        ...(reference ? { reference: { board: 'reference', coverage } } : {}),
      });
    }
    const check = validatePlan(plan, design, movableRefs);
    for (const w of check.warnings) ctx.log(`placer-reuse-pack: ${w}`);
    if (check.errors.length) {
      for (const e of check.errors) ctx.log(`placer-reuse-pack: plan invalid: ${e}`);
      return resultShape('failed', [], moving.map((c) => c.id), (Date.now() - t0) / 1000, finish());
    }

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
      log: ctx.log,
    });
    const status = res.placements.length === 0 ? 'failed' : res.unplacedIds.length ? 'partial' : 'complete';
    return resultShape(status, res.placements, res.unplacedIds, (Date.now() - t0) / 1000, finish());
  }
}
