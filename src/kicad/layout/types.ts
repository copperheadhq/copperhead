/**
 * PCB layout engine boundary (issue #252): the placement/routing data model and
 * the two adapter interfaces. All coordinates are millimeters, absolute board
 * space, origin at the board top-left — the same convention the schematic draft
 * engine uses, and the one the DSN/SES bridge pins before emitting.
 *
 * This is a *boundary*, not an implementation: no engine writes KiCad copper
 * directly, and no engine runs inside `check` unless it is local and offline.
 */

/** A pad on a footprint, in footprint-local coordinates (mm, origin = footprint
 * origin). The footprint's own `x`/`y` is the absolute placement, so a pad's
 * absolute position is `footprint.x + pad.x`. */
export interface Pad {
  /** Pad number (e.g. `"1"`, `"A1"`). */
  number: string;
  /** Net the pad is assigned to (empty string for unconnected). */
  net: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Copper layers the pad lands on (e.g. `["F.Cu"]`). */
  layers: string[];
}

/** A footprint placed on the board (absolute origin + rotation). */
export interface PlacedFootprint {
  /** Reference designator, e.g. `"U1"`. */
  ref: string;
  /** Library footprint id, e.g. `"Package_SO:SOIC-8_3.9x4.9mm_P1.27mm"`. */
  footprint: string;
  /** Absolute footprint-origin position (mm). */
  x: number;
  y: number;
  /** Rotation in degrees, counter-clockwise. */
  rotation: number;
  side: 'front' | 'back';
  pads: Pad[];
  /** Footprint courtyard, for packing/clearance (mm). */
  courtyard?: { width: number; height: number };
}

/** One electrical net: a name plus the refdes/pad pairs it connects. */
export interface Net {
  name: string;
  pins: { ref: string; pad: string }[];
}

/** Connectivity extracted from the schematic (what needs routing). */
export interface Netlist {
  nets: Net[];
}

/** A rectangular keepout region (mm, absolute). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The board as a placement engine sees it: outline + parts + nets. */
export interface BoardModel {
  /** Board outline (Edge.Cuts rectangle), mm. */
  width: number;
  height: number;
  footprints: PlacedFootprint[];
  nets: Net[];
}

/** Placement guidance the model cannot infer from connectivity alone. */
export interface PlacementConstraints {
  /** Refdes that must sit on a board edge (connectors). */
  edgeConnectors?: string[];
  /** Refdes grouped into a placement region (from SUBSYSTEMS.md). */
  groups?: Record<string, string[]>;
  /** Rectangular keepouts a footprint may not overlap. */
  keepouts?: Rect[];
}

/** A placement result: footprints with absolute positions assigned. */
export interface Placement {
  footprints: PlacedFootprint[];
}

/** Routing rules (mm): clearance, widths, via geometry. */
export interface DesignRules {
  clearance: number;
  trackWidth: number;
  viaDiameter: number;
  viaDrill: number;
}

/** A routed copper segment (a polyline on one layer). */
export interface Track {
  net: string;
  layer: 'F.Cu' | 'B.Cu' | string;
  width: number;
  points: { x: number; y: number }[];
}

/** A plated via connecting two copper layers. */
export interface Via {
  net: string;
  x: number;
  y: number;
  diameter: number;
  drill: number;
}

/** A routing result: tracks and vias ready to lower into the board. */
export interface RoutedBoard {
  tracks: Track[];
  vias: Via[];
}

/** Places footprints from a netlist onto a board. Deterministic, in-repo. */
export interface PlacementEngine {
  place(board: BoardModel, netlist: Netlist, constraints: PlacementConstraints): Promise<Placement>;
}

/** Routes the board's nets. Local engines may run in a gate; cloud ones may not. */
export interface RoutingEngine {
  route(board: BoardModel, rules: DesignRules): Promise<RoutedBoard>;
}
