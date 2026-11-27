/**
 * Fabrication profiles (ADR 0006). The JSON beside this file is the vendored
 * source data (kicad-tools, MIT, pinned commit); this module is the typed copy
 * the runtime ships, and a test holds the two equal.
 */
import type { Nm } from '../../ir/units.js';
import { defaultProfileIdFor } from '../../ir/layers.js';

export interface FabricationProfile {
  id: string;
  description: string;
  source: { project: string; license: string; commit: string; paths: string[]; vendored: string };
  layers: number;
  copperWeightOz: number;
  boardThicknessNm: Nm;
  minTrackNm: Nm;
  minClearanceNm: Nm;
  minViaDrillNm: Nm;
  minViaDiameterNm: Nm;
  minAnnularNm: Nm;
  minHoleNm: Nm;
  maxHoleNm: Nm;
  copperEdgeClearanceNm: Nm;
  holeEdgeClearanceNm: Nm;
  holeToHoleNm: Nm;
  minSilkWidthNm: Nm;
  minSilkHeightNm: Nm;
  minMaskDamNm: Nm;
  minMaskClearanceNm: Nm;
  minPadNm: Nm;
  viaInPad: 'forbidden' | 'filled' | 'allowed';
  criticalDrc: string[];
  advisoryDrc: string[];
  kicadToolsMfr: string;
  druFile: string;
  rotationsFile: string;
}

export const JLCPCB_2LAYER: FabricationProfile = {
  id: 'jlcpcb-2layer',
  description:
    'JLCPCB 2-layer, 1 oz outer copper. Values vendored from kicad-tools manufacturers/data/jlcpcb.yaml block 2layer_1oz (source: https://jlcpcb.com/capabilities/pcb-capabilities, last verified upstream 2026-01-16).',
  source: {
    project: 'rjwalters/kicad-tools',
    license: 'MIT',
    commit: 'cfc166b0f15943f02cec2236ccdafbcfefc45aa9',
    paths: ['src/kicad_tools/manufacturers/data/jlcpcb.yaml', 'src/kicad_tools/manufacturers/rules/jlcpcb-2layer-1oz.kicad_dru', 'src/kicad_tools/manufacturers/data/jlcpcb_rotations.yaml'],
    vendored: '2026-09-05',
  },
  layers: 2,
  copperWeightOz: 1.0,
  boardThicknessNm: 1600000,
  minTrackNm: 127000,
  minClearanceNm: 127000,
  minViaDrillNm: 300000,
  minViaDiameterNm: 600000,
  minAnnularNm: 150000,
  minHoleNm: 300000,
  maxHoleNm: 6300000,
  copperEdgeClearanceNm: 300000,
  holeEdgeClearanceNm: 500000,
  holeToHoleNm: 500000,
  minSilkWidthNm: 150000,
  minSilkHeightNm: 1000000,
  minMaskDamNm: 100000,
  minMaskClearanceNm: 50000,
  minPadNm: 250000,
  viaInPad: 'forbidden',
  criticalDrc: [
    'clearance', 'shorting_items', 'track_width', 'via_diameter', 'hole_clearance', 'hole_to_hole',
    'annular_width', 'copper_edge_clearance', 'courtyards_overlap', 'pth_inside_courtyard',
    'items_not_allowed', 'invalid_outline', 'isolated_copper', 'zones_intersect', 'starved_thermal',
  ],
  advisoryDrc: [
    'solder_mask_bridge', 'silk_over_copper', 'silk_overlap', 'text_height', 'text_thickness',
    'lib_footprint_mismatch', 'footprint_type_mismatch', 'malformed_courtyard', 'missing_courtyard',
    'track_dangling', 'via_dangling',
  ],
  kicadToolsMfr: 'jlcpcb',
  druFile: 'jlcpcb-2layer-1oz.kicad_dru',
  rotationsFile: 'jlcpcb-rotations.yaml',
};

/** JLCPCB four-layer, 1 oz outer / 0.5 oz inner copper: the `4layer_1oz` block of the same vendored table (add-multilayer-layout, design D3). */
export const JLCPCB_4LAYER: FabricationProfile = {
  ...JLCPCB_2LAYER,
  id: 'jlcpcb-4layer',
  description:
    'JLCPCB 4-layer, 1 oz outer and 0.5 oz inner copper. Values vendored from kicad-tools manufacturers/data/jlcpcb.yaml block 4layer_1oz (source: https://jlcpcb.com/capabilities/pcb-capabilities, last verified upstream 2026-01-16).',
  layers: 4,
  minTrackNm: 101600,
  minClearanceNm: 101600,
  minViaDrillNm: 200000,
  minViaDiameterNm: 450000,
  minAnnularNm: 100000,
  minHoleNm: 200000,
  holeEdgeClearanceNm: 400000,
  druFile: 'jlcpcb-4layer-1oz.kicad_dru',
};

/** JLCPCB six-layer, 1 oz outer / 0.5 oz inner copper: the `6layer_1oz` block of the same vendored table. */
export const JLCPCB_6LAYER: FabricationProfile = {
  ...JLCPCB_4LAYER,
  id: 'jlcpcb-6layer',
  description:
    'JLCPCB 6-layer, 1 oz outer and 0.5 oz inner copper. Values vendored from kicad-tools manufacturers/data/jlcpcb.yaml block 6layer_1oz (source: https://jlcpcb.com/capabilities/pcb-capabilities, last verified upstream 2026-01-16).',
  layers: 6,
  minTrackNm: 88900,
  minClearanceNm: 88900,
  minAnnularNm: 150000,
  druFile: 'jlcpcb-6layer-1oz.kicad_dru',
};

const PROFILES: Record<string, FabricationProfile> = { [JLCPCB_2LAYER.id]: JLCPCB_2LAYER, [JLCPCB_4LAYER.id]: JLCPCB_4LAYER, [JLCPCB_6LAYER.id]: JLCPCB_6LAYER };

/** The default profile for a copper count: the IR's naming convention, which must name a registered profile. */
export function defaultProfileFor(copperLayers: number): string {
  const id = defaultProfileIdFor(copperLayers);
  if (!PROFILES[id]) throw new Error(`no fabrication profile registered for ${copperLayers} copper layers ("${id}")`);
  return id;
}

export function loadProfile(id: string): FabricationProfile {
  const p = PROFILES[id];
  if (!p) throw new Error(`unknown fabrication profile "${id}" (known: ${Object.keys(PROFILES).join(', ')})`);
  return p;
}

export function isCriticalDrc(profile: FabricationProfile, type: string): boolean {
  return profile.criticalDrc.includes(type);
}
