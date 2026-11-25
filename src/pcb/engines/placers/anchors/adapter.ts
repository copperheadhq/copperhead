/**
 * placer-anchors: the deterministic rule stage of the staged placement plan
 * (RFC 11 §8.5, implementation spec §6.5 step 2). Puts each block's anchor at
 * its region's centroid and touches nothing else. Not an optimiser, so exempt
 * from §3.8; a library engine.
 */
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import type { PlacedComponent } from '../../../ir/types.js';
import { centroid } from '../../../ir/geometry.js';
import type { Block } from '../../../intent/blocks.js';
import { resultShape } from '../shared.js';

export const ANCHORS_PLACER_MANIFEST: EngineManifest = {
  id: 'placer-anchors',
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
  capabilities: { bottomSide: false, rotation: false, arbitraryOutline: true, relativeConstraints: ['region'], fixedComponents: true, congestionAwareness: false, layoutReuse: false },
  supportedConstraints: ['functional.group'],
};

/** Blocks travel in the job's constraints as `{ kind: 'functional.group', block }`. */
export function blocksOf(job: PlacementJob): Block[] {
  return job.constraints.filter((c): c is { kind: string; block: Block } => typeof c === 'object' && c !== null && (c as { kind?: string }).kind === 'functional.group').map((c) => c.block);
}

export class AnchorsPlacer implements PlacerPlugin {
  async manifest(): Promise<EngineManifest> {
    return ANCHORS_PLACER_MANIFEST;
  }
  async place(job: PlacementJob, _ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const design = job.snapshot.design;
    const movable = new Set(job.movableComponentIds);
    const placements: PlacedComponent[] = [];
    for (const b of blocksOf(job)) {
      if (!b.anchor || !b.region || !movable.has(b.anchor)) continue;
      const c = design.components.find((x) => x.id === b.anchor);
      if (!c || c.attributes.locked) continue;
      const at = centroid(b.region);
      placements.push({ id: c.id, at: { x: Math.round(at.x), y: Math.round(at.y) }, rotation: c.rotation, side: c.attributes.side });
    }
    return resultShape('complete', placements, [], (Date.now() - t0) / 1000, { engineId: ANCHORS_PLACER_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() });
  }
}
