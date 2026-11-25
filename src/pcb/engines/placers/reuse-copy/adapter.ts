/**
 * placer-reuse-copy (add-reuse-placer, RFC 14 §7.3): the reference board's
 * placement, matched part by part and moved into this board's frame by one
 * rigid transform. It is the first candidate of every reuse run and the
 * control the packed candidates are measured against: on a board that only
 * changed its outline slightly, copying is the right answer and nothing
 * should beat it.
 *
 * It places only the parts it matched. Parts with no counterpart are left for
 * the packer, which is why the status is `partial` whenever the reference does
 * not cover the board.
 */
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import type { PcbDesign } from '../../../ir/types.js';
import { movable, resultShape, constraintOf } from '../shared.js';
import { matchComponents } from '../../reuse/match.js';
import { transferPlacement } from '../../reuse/transfer.js';

export const REUSE_COPY_MANIFEST: EngineManifest = {
  id: 'placer-reuse-copy',
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
  capabilities: { bottomSide: true, rotation: true, arbitraryOutline: true, relativeConstraints: ['layout.reference'], fixedComponents: true, congestionAwareness: false, layoutReuse: true },
  supportedConstraints: ['mechanical', 'relative'],
};

/** The reference board travels in the job's constraints as `{ kind: 'layout.reference', value: design }`. */
export class ReuseCopyPlacer implements PlacerPlugin {
  async manifest(): Promise<EngineManifest> {
    return REUSE_COPY_MANIFEST;
  }
  async place(job: PlacementJob, ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const started = new Date(t0).toISOString();
    const provenance = { engineId: REUSE_COPY_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: started, finishedAt: new Date().toISOString() };
    const reference = constraintOf<PcbDesign>(job, 'layout.reference');
    const moving = movable(job);
    if (!reference) {
      ctx.log('placer-reuse-copy: no reference board in the job; nothing to copy');
      return resultShape('unsupported', [], moving.map((c) => c.id), (Date.now() - t0) / 1000, { ...provenance, finishedAt: new Date().toISOString() });
    }
    const design = job.snapshot.design;
    const report = matchComponents(design, reference);
    const movableIds = new Set(moving.map((c) => c.id));
    const transfer = transferPlacement(design, reference, report.matches, { movableIds });
    for (const s of transfer.skipped) ctx.log(`placer-reuse-copy: ${s.ref} ${s.why}`);
    ctx.log(`placer-reuse-copy: matched ${(report.coverage * 100).toFixed(0)} % of the parts, fitted on ${transfer.fittedOn} (${transfer.anchorRefs.length} anchors, residual ${(transfer.residualNm / 1e6).toFixed(2)} mm)`);
    if (transfer.outsideOutline.length) ctx.log(`placer-reuse-copy: ${transfer.outsideOutline.length} part(s) land outside the outline: ${transfer.outsideOutline.slice(0, 8).join(', ')}`);
    const placedIds = new Set(transfer.placements.map((p) => p.id));
    const unplaced = moving.filter((c) => !placedIds.has(c.id)).map((c) => c.id);
    const status = transfer.placements.length === 0 ? 'failed' : unplaced.length ? 'partial' : 'complete';
    return resultShape(status, transfer.placements, unplaced, (Date.now() - t0) / 1000, { ...provenance, finishedAt: new Date().toISOString() });
  }
}
