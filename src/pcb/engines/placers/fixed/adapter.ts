/**
 * placer-fixed: returns the input placement unchanged. The control every other
 * placer is measured against (RFC 11 §8.2, ADR 0008).
 */
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import { identityPlacements, resultShape } from '../shared.js';

export const FIXED_PLACER_MANIFEST: EngineManifest = {
  id: 'placer-fixed',
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
  capabilities: { bottomSide: true, rotation: true, arbitraryOutline: true, relativeConstraints: [], fixedComponents: true, congestionAwareness: false, layoutReuse: false },
  supportedConstraints: [],
};

export class FixedPlacer implements PlacerPlugin {
  async manifest(): Promise<EngineManifest> {
    return FIXED_PLACER_MANIFEST;
  }
  async place(job: PlacementJob, _ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const started = new Date(t0).toISOString();
    return resultShape('complete', identityPlacements(job), [], (Date.now() - t0) / 1000, { engineId: FIXED_PLACER_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: started, finishedAt: new Date().toISOString() });
  }
}
