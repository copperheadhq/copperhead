/**
 * The canonical PCB IR (RFC 11 §6, implementation spec §3.1). Integer
 * nanometres and millidegrees throughout; stable ids are the KiCad UUIDs of
 * the objects they describe, so a refdes rename changes nothing here.
 */
import type { Nm, Mdeg } from './units.js';
import type { Point, Polygon } from './geometry.js';

export type { Nm, Mdeg, Point, Polygon };

export const IR_SCHEMA_VERSION = '1.0' as const;

export interface SourceProvenance {
  /** Repo-relative paths of the files the design was imported from. */
  files: { board: string; project?: string; dru?: string };
  kicadVersion: string;
  boardFileVersion: number;
  /** How the source file names nets: a `(net N "name")` table with codes (KiCad 8/9), or `(net "name")` on every object with no table (KiCad 10.0.4's 20260206 format). Export follows the source. */
  netDialect: 'code' | 'name';
  importedAt: string;
  /** hashDesign() of this design, excluding importedAt. */
  contentHash: string;
}

export type LayerKind = 'copper' | 'silk' | 'mask' | 'paste' | 'courtyard' | 'fab' | 'edge' | 'user' | 'adhesive';

export interface LayerDefinition {
  /** KiCad's canonical name, e.g. "F.Cu"; every item in the file references this. */
  id: string;
  ordinal: number;
  kind: LayerKind;
  side?: 'front' | 'back';
  /** The user's display name when the board renamed the layer (e.g. "top_cu"); KiCad's Specctra exporter emits this one. */
  userName?: string;
}

export interface Keepout {
  id: string;
  polygon: Polygon;
  layers: string[];
  prohibits: ('tracks' | 'vias' | 'pads' | 'footprints' | 'copper')[];
}

export interface DesignRules {
  /** The project's DRC rule severities (`rule_severities` in the .kicad_pro): the designer's own settings, honoured like any ECAD-authored rule (RFC 11 §7.5). */
  severities: Record<string, 'error' | 'warning' | 'ignore' | 'exclusion'>;
  clearanceNm: Nm;
  trackWidthNm: Nm;
  viaDiameterNm: Nm;
  viaDrillNm: Nm;
  copperEdgeClearanceNm: Nm;
  minTrackWidthNm?: Nm;
  minViaDiameterNm?: Nm;
  minViaDrillNm?: Nm;
  /** Per net class overrides from the project file, keyed by class name. */
  netClasses: Record<string, Partial<Pick<DesignRules, 'clearanceNm' | 'trackWidthNm' | 'viaDiameterNm' | 'viaDrillNm'>> & { nets?: string[] }>;
}

export interface BoardDefinition {
  outline: Polygon;
  cutouts: Polygon[];
  layers: LayerDefinition[];
  thicknessNm?: Nm;
  keepouts: Keepout[];
  fabricationProfile: string;
  rules: DesignRules;
}

export type PadShape = 'circle' | 'rect' | 'oval' | 'roundrect' | 'trapezoid' | 'chamfered' | 'custom';
export type PadType = 'smd' | 'thru_hole' | 'np_thru_hole' | 'connect';

export interface PadDefinition {
  id: string;
  number: string;
  netId: string | null;
  type: PadType;
  shape: PadShape;
  /** Absolute board position and absolute rotation (KiCad stores pad rotation absolute). */
  at: Point;
  rotation: Mdeg;
  size: { w: Nm; h: Nm };
  layers: string[];
  drill?: { d: Nm; offset?: Point; slot?: { w: Nm; h: Nm } };
  /** Copper outline in board coordinates, computed at import for every shape. */
  copper: Polygon;
  /** The schematic pin's name (`(pinfunction …)`), when the board carries it (add-reuse-placer). */
  pinFunction?: string;
  /** The schematic pin's electrical type (`(pintype …)`), when the board carries it. */
  pinType?: string;
}

export interface FootprintDefinition {
  libId: string;
  /** Courtyard in board coordinates, or null when the footprint draws none. */
  courtyard: Polygon | null;
  /** Fab-layer body outline in board coordinates, or null. */
  body: Polygon | null;
}

export interface ComponentInstance {
  id: string;
  reference: string;
  value: string;
  footprint: FootprintDefinition;
  pads: PadDefinition[];
  at: Point;
  rotation: Mdeg;
  attributes: { side: 'front' | 'back'; locked: boolean; throughHole: boolean; excludeFromBom: boolean; dnp: boolean };
  semanticRoles: string[];
  /** The schematic symbol path (`(path …)`), stable across revisions when the footprint UUID is not (add-reuse-placer). */
  symbolPath?: string;
  /** The hierarchical sheet the symbol sits on (`(sheetname …)`, `(sheetfile …)`), when the board carries it. */
  sheet?: { name: string; file?: string };
}

export interface NetDefinition {
  id: string;
  code: number;
  name: string;
  padIds: string[];
  netClass: string;
}

export interface ConstraintRef {
  id: string;
  registryPath: string;
}

export interface PlacedComponent {
  id: string;
  at: Point;
  rotation: Mdeg;
  side: 'front' | 'back';
}

export interface PlacementState {
  components: PlacedComponent[];
  lockedComponentIds: string[];
}

export interface TrackSegment {
  id: string;
  netId: string;
  layer: string;
  a: Point;
  b: Point;
  width: Nm;
}

export interface TrackArc {
  id: string;
  netId: string;
  layer: string;
  a: Point;
  mid: Point;
  b: Point;
  width: Nm;
}

export interface Via {
  id: string;
  netId: string;
  at: Point;
  size: Nm;
  drill: Nm;
  layers: [string, string];
}

export interface CopperZone {
  id: string;
  netId: string | null;
  layers: string[];
  outline: Polygon;
  priority: number;
  clearanceNm: Nm;
  thermal: { gapNm: Nm; bridgeNm: Nm } | null;
  isKeepout: boolean;
  /** The zone record verbatim; export re-emits it unchanged (RFC 11 §6.6). */
  definitionText: string;
}

export interface RoutingState {
  segments: TrackSegment[];
  arcs: TrackArc[];
  vias: Via[];
  zones: CopperZone[];
}

/** Derived data: a zone's filled polygons after refill. Never part of PcbDesign. */
export interface ZoneFill {
  zoneId: string;
  layer: string;
  polygons: Polygon[];
}

/** A board-level record the adapter recognised but does not model, kept verbatim for export. */
export interface PreservedBlock {
  head: string; // e.g. "gr_text", "dimension", "group"
  /** Verbatim record text; array order is file order. Offsets are deliberately not stored: they shift when fills are stripped and must not enter the hash. */
  text: string;
}

export interface PcbDesign {
  schemaVersion: typeof IR_SCHEMA_VERSION;
  designId: string;
  source: SourceProvenance;
  board: BoardDefinition;
  components: ComponentInstance[];
  nets: NetDefinition[];
  constraints: ConstraintRef[];
  placement: PlacementState;
  routing: RoutingState;
  preserved: PreservedBlock[];
  /** Fields a lossy import could not recover (RFC 11 §6.1). */
  lossy: string[];
}
