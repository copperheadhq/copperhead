/**
 * placer-heuristic: the engineer's basic placement rules behind the placer
 * contract. It takes an intent — `layout.plan`, the same shape a model writes
 * through `planPlacement` — and applies the rules in `rules.ts` to it:
 * connectors to the edges facing out, subsystems given territory, the main IC
 * at the centre, each subsystem's passives ringed around its anchor.
 *
 * The division of labour is the point: a model may decide what belongs with
 * what and which edge a connector faces, and never a coordinate. Every number
 * on the board comes out of this engine, which searches nothing and gives the
 * same board twice — so it is exempt from the optimiser rules and safe to run
 * with no model at all, where the rules write the plan instead.
 */
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import { movable, resultShape, constraintOf } from '../shared.js';
import { classifyCritical } from '../../../intent/critical.js';
import { partitions } from '../../../intent/subsystems.js';
import { defaultPlan, validatePlan, type PlacementPlan } from '../../reuse/plan.js';
import { placeByRules } from './rules.js';

export const HEURISTIC_PLACER_MANIFEST: EngineManifest = {
  id: 'placer-heuristic',
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
  capabilities: { bottomSide: true, rotation: true, arbitraryOutline: true, relativeConstraints: ['layout.plan', 'grouped', 'region', 'near'], fixedComponents: true, congestionAwareness: false, layoutReuse: false },
  supportedConstraints: ['mechanical', 'functional', 'relative', 'emc'],
};

export interface HeuristicSettings {
  /** Positions snap to this grid; 0.5 mm by default. */
  gridNm?: number;
  /** Area a subsystem gets over the sum of its parts' extents. */
  slack?: number;
}

export class HeuristicPlacer implements PlacerPlugin {
  constructor(private readonly settings: HeuristicSettings = {}) {}
  async manifest(): Promise<EngineManifest> {
    return HEURISTIC_PLACER_MANIFEST;
  }
  async place(job: PlacementJob, ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const started = new Date(t0).toISOString();
    const finish = (): PlacementResult['provenance'] => ({ engineId: HEURISTIC_PLACER_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: started, finishedAt: new Date().toISOString() });
    const design = job.snapshot.design;
    const moving = movable(job);
    if (!moving.length) return resultShape('complete', [], [], (Date.now() - t0) / 1000, finish());
    const movableRefs = moving.map((c) => c.reference);
    const classification = classifyCritical(design);

    // the intent: a model's plan when the run has one, the rules' plan otherwise
    let plan = constraintOf<PlacementPlan>(job, 'layout.plan');
    if (plan) ctx.log(`placer-heuristic: plan given (${plan.subsystems.length} subsystem(s), ${plan.critical.length} critical relationship(s))`);
    else {
      const chosen = partitions(design)[0];
      if (!chosen) {
        ctx.log('placer-heuristic: the board has no subsystem partition and no intent; nothing to place from');
        return resultShape('unsupported', [], moving.map((c) => c.id), (Date.now() - t0) / 1000, finish());
      }
      plan = defaultPlan({ design, movableRefs, partition: chosen, classification });
      ctx.log(`placer-heuristic: no plan given; subsystems from the ${chosen.key} partition`);
    }
    const check = validatePlan(plan, design, movableRefs);
    for (const w of check.warnings) ctx.log(`placer-heuristic: ${w}`);
    if (check.errors.length) {
      for (const e of check.errors) ctx.log(`placer-heuristic: plan invalid: ${e}`);
      return resultShape('failed', [], moving.map((c) => c.id), (Date.now() - t0) / 1000, finish());
    }

    const res = placeByRules({
      design,
      plan,
      classification,
      movableRefs,
      ...(this.settings.gridNm !== undefined ? { gridNm: this.settings.gridNm } : {}),
      ...(this.settings.slack !== undefined ? { slack: this.settings.slack } : {}),
      log: ctx.log,
    });
    const status = res.placements.length === 0 ? 'failed' : res.unplacedIds.length ? 'partial' : 'complete';
    return resultShape(status, res.placements, res.unplacedIds, (Date.now() - t0) / 1000, finish());
  }
}
