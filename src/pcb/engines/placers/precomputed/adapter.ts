/**
 * placer-precomputed (add-reuse-placer, RFC 14 §8.6): a placer that returns a
 * placement somebody else already computed. The reuse run screens its variants
 * in memory and then wants the few survivors put through the ordinary
 * materialise, verify, probe and rank path, which is addressed by engine id;
 * registering each survivor as its own engine is how they get there without a
 * second code path that could disagree with the first.
 */
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import type { PlacedComponent } from '../../../ir/types.js';
import { movable, resultShape } from '../shared.js';

export function precomputedManifest(id: string): EngineManifest {
  return {
    id,
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
    capabilities: { bottomSide: true, rotation: true, arbitraryOutline: true, relativeConstraints: [], fixedComponents: true, congestionAwareness: false, layoutReuse: true },
    supportedConstraints: [],
  };
}

export class PrecomputedPlacer implements PlacerPlugin {
  constructor(
    private readonly id: string,
    private readonly placements: PlacedComponent[],
    private readonly unplacedIds: string[] = [],
    private readonly seconds = 0,
  ) {}
  async manifest(): Promise<EngineManifest> {
    return precomputedManifest(this.id);
  }
  async place(job: PlacementJob, _ctx: RunContext): Promise<PlacementResult> {
    const started = new Date().toISOString();
    const allowed = new Set(movable(job).map((c) => c.id));
    const placements = this.placements.filter((p) => allowed.has(p.id));
    const placedIds = new Set(placements.map((p) => p.id));
    const unplaced = [...new Set([...this.unplacedIds, ...[...allowed].filter((id) => !placedIds.has(id))])];
    const status = placements.length === 0 ? 'failed' : unplaced.length ? 'partial' : 'complete';
    return resultShape(status, placements, unplaced, this.seconds, { engineId: this.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: started, finishedAt: new Date().toISOString() });
  }
}
