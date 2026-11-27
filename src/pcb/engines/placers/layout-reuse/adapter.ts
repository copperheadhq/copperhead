/**
 * placer-layout-reuse (RFC 11 §8.6, implementation spec §6.7): copies a
 * reference block's relative placement around its anchor into the target with
 * a rigid transform. Copperhead-authored but not an optimiser: it copies, so
 * it is exempt from §3.8. Library engine; works from `LayoutBlockSpec`s that
 * `pcb.layoutBlocks` (a source board, an anchor, members) or the reference
 * retrieval (relative offsets) provide.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import type { PcbDesign, PlacedComponent, Mdeg, Nm } from '../../../ir/types.js';
import { importBoard } from '../../../ir/kicad/import.js';
import { rotatePoint } from '../../../ir/geometry.js';
import { normMdeg } from '../../../ir/units.js';
import { resultShape, specsOf, applySpec, type LayoutBlockSpec } from '../shared.js';
export { specsOf, applySpec, type LayoutBlockSpec };

export const LAYOUT_REUSE_MANIFEST: EngineManifest = {
  id: 'placer-layout-reuse',
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
  capabilities: { bottomSide: true, rotation: true, arbitraryOutline: true, relativeConstraints: ['grouped'], fixedComponents: true, congestionAwareness: false, layoutReuse: true },
  supportedConstraints: ['relative.attached', 'functional.group'],
};


/** `pcb.layoutBlocks` entry: a source board and the refdes to copy from it. */
export interface LayoutBlockConfig {
  id: string;
  source: string;
  anchor: string;
  members: string[];
  /** Target refdes per source refdes when they differ (default: same refdes). */
  map?: Record<string, string>;
}

/** Read a `pcb.layoutBlocks` entry: member positions relative to the anchor in the source board, in the anchor's frame. */
export async function specFromBoard(cfg: LayoutBlockConfig, repoRootOrAbs: string): Promise<LayoutBlockSpec> {
  const p = cfg.source.startsWith('/') ? cfg.source : `${repoRootOrAbs}/${cfg.source}`;
  if (!existsSync(p)) throw new Error(`layout block ${cfg.id}: source board not found at ${p}`);
  const design = importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, now: 'reuse' }).design;
  return specFromDesign(cfg, design);
}

export function specFromDesign(cfg: LayoutBlockConfig, design: PcbDesign): LayoutBlockSpec {
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const anchor = byRef.get(cfg.anchor);
  if (!anchor) throw new Error(`layout block ${cfg.id}: anchor ${cfg.anchor} not in ${cfg.source}`);
  const members: LayoutBlockSpec['members'] = [];
  for (const ref of cfg.members) {
    const m = byRef.get(ref);
    if (!m || ref === cfg.anchor) continue;
    // into the anchor's frame: translate to the anchor, undo the anchor's rotation
    const d = rotatePoint({ x: m.at.x - anchor.at.x, y: m.at.y - anchor.at.y }, -anchor.rotation);
    members.push({ ref: cfg.map?.[ref] ?? ref, rel: { x: Math.round(d.x), y: Math.round(d.y), rotation: normMdeg(m.rotation - anchor.rotation) }, side: m.attributes.side });
  }
  return { id: cfg.id, anchor: cfg.map?.[cfg.anchor] ?? cfg.anchor, members, source: cfg.source };
}



export class LayoutReusePlacer implements PlacerPlugin {
  async manifest(): Promise<EngineManifest> {
    return LAYOUT_REUSE_MANIFEST;
  }
  async place(job: PlacementJob, ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const design = job.snapshot.design;
    const movable = new Set(job.movableComponentIds);
    const placements: PlacedComponent[] = [];
    const seen = new Set<string>();
    for (const spec of specsOf(job)) {
      const { placements: ps, skipped } = applySpec(spec, design, movable);
      for (const s of skipped) ctx.log(`layout block ${spec.id}: skipped ${s}`);
      for (const p of ps) if (!seen.has(p.id)) {
        seen.add(p.id);
        placements.push(p);
      }
    }
    return resultShape('complete', placements, [], (Date.now() - t0) / 1000, { engineId: LAYOUT_REUSE_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() });
  }
}
