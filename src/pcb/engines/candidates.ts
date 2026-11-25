/**
 * Candidate materialization (implementation spec §3.5, §5): apply an
 * engine's result to the source text, write candidate.kicad_pcb, refill zones
 * and run KiCad DRC through kicad-cli, re-import, verify, and collect metrics.
 * The DRC report returned always describes the file on disk.
 */
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PcbDesign, ZoneFill } from '../ir/types.js';
import { importBoard } from '../ir/kicad/import.js';
import { applyCandidate, type Candidate } from '../ir/kicad/export.js';
import { renderSvg } from '../ir/svg.js';
import type { Constraint } from '../../memory/constraints.js';
import { refillZones, extractFills } from '../ir/kicad/zones.js';
import { verifyDesign, type VerifyResult } from '../verify/index.js';
import type { FabricationProfile } from '../verify/profiles/index.js';
import type { CheckReport } from '../../kicad/report.js';
import type { Invocation } from './runner.js';
import type { RoutingResult, PlacementResult } from './contracts.js';

export interface MaterializedCandidate {
  engineId: string;
  workDir: string;
  pcbPath: string;
  design: PcbDesign;
  fills: ZoneFill[];
  drc: CheckReport | null;
  verify: VerifyResult;
  /** Placement or routing changes the exporter refused (side flips). */
  refused: { id: string; reason: string }[];
}

export interface MaterializeOptions {
  /** Layout constraints for the intent checker (intent + ECAD); optional. */
  constraints?: Record<string, Constraint>;
  sourceText: string;
  design: PcbDesign;
  projectText?: string;
  profile: FabricationProfile;
  kicadVersion?: string;
  /** Skip kicad-cli (tests without KiCad); DRC is then null and fills empty. */
  noKicad?: boolean;
}

export function candidateFromRouting(result: RoutingResult, preserveExisting: boolean, design: PcbDesign): Candidate {
  const preserveIds = preserveExisting ? new Set([...design.routing.segments.map((s) => s.id), ...design.routing.arcs.map((a) => a.id), ...design.routing.vias.map((v) => v.id)]) : new Set<string>();
  return { routing: { segments: result.segments, arcs: result.arcs, vias: result.vias, preserveIds } };
}

export function candidateFromPlacement(result: PlacementResult): Candidate {
  return { placement: result.placements };
}

export async function materialize(inv: Invocation<RoutingResult | PlacementResult>, candidate: Candidate, opts: MaterializeOptions): Promise<MaterializedCandidate> {
  const out = applyCandidate(opts.sourceText, opts.design, candidate);
  const pcbPath = path.join(inv.workDir, 'candidate.kicad_pcb');
  await writeFile(pcbPath, out.text, 'utf8');
  if (opts.projectText) await writeFile(path.join(inv.workDir, 'candidate.kicad_pro'), opts.projectText, 'utf8');
  let drc: CheckReport | null = null;
  let text = out.text;
  if (!opts.noKicad) {
    drc = await refillZones(pcbPath);
    text = await readFile(pcbPath, 'utf8');
  }
  const design = importBoard({ boardText: text, boardPath: pcbPath, ...(opts.projectText ? { projectText: opts.projectText } : {}), now: opts.design.source.importedAt }).design;
  const fills = extractFills(text);
  const verify = verifyDesign({ design, fills, ...(drc ? { drc } : {}), profile: opts.profile, ...(opts.kicadVersion ? { kicadVersion: opts.kicadVersion } : {}), ...(opts.constraints ? { constraints: opts.constraints } : {}) });
  await writeFile(path.join(inv.workDir, 'candidate.json'), JSON.stringify(design), 'utf8');
  await writeFile(path.join(inv.workDir, 'diagnostics.json'), JSON.stringify(verify.diagnostics, null, 2), 'utf8');
  // a picture beside every candidate: the board with the harness's findings marked, no legend (the diagnostics file is the legend)
  await writeFile(path.join(inv.workDir, 'candidate.svg'), renderSvg(design, { diagnostics: verify.diagnostics, legend: false, scale: 12 }), 'utf8');
  return { engineId: inv.engineId, workDir: inv.workDir, pcbPath, design, fills, drc, verify, refused: out.refused };
}
