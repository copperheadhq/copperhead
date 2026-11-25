/* eslint-disable */
/**
 * Generated from the RFC 11 layout record schemas in src/pcb-ir/schemas/rfc11/
 * by scripts/gen-pcb-ir-types.ts. Do not edit: change the schemas in the RFC
 * repository, vendor them again, and regenerate.
 */

/**
 * A closed ring of at least three points, without the first point repeated at the end. Always held under the key outline, whose order the canonical form preserves (RFC 11 Section 6.13).
 *
 * @minItems 3
 */
export type Ring = [Point, Point, Point, ...Point[]];
/**
 * One physical record of the kernel graph: the physical key of the RFC 3 root (RFC 11 Section 6.8). These records carry no schema_version of their own; the root's RFC 3 schema version, 1.4 or later, covers them. Geometry is integer nanometres in the board frame; geometry derivable from a footprint definition and a pose is never stored here.
 */
export type PhysicalDesignRecord = Board | Stackup | Layer | Placement | Pad | Region | Zone | Trace | Via;
export type Board = Entity & {
  kind: 'board';
  id?: string;
  /**
   * The declared geometry unit of every physical record of this board.
   */
  unit: 'nm';
  outline: Ring;
  cutouts?: Outline[];
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  stackup: string;
  thickness?: Quantity;
  /**
   * A drawn length greater than zero, in integer nanometres.
   */
  arc_tolerance?: number;
  fabrication_profile?: string;
  preserved?: Preserved;
  lossy?: Lossy;
};
/**
 * Records the adapter recognized but does not model, verbatim, in file order.
 */
export type Preserved = {
  head: string;
  text: string;
}[];
/**
 * The fields a lossy import could not recover (RFC 3 Section 12).
 */
export type Lossy = string[];
export type Stackup = Entity & {
  kind: 'stackup';
  id?: string;
  /**
   * Layer records, top to bottom.
   *
   * @minItems 1
   */
  layers: [string, ...string[]];
};
export type Layer = Entity & {
  kind: 'layer';
  id?: string;
  /**
   * A layer's name, as its layer record names it. A footprint definition names front-side layers.
   */
  name: string;
  layer_kind: 'copper' | 'silk' | 'mask' | 'paste' | 'courtyard' | 'fab' | 'edge' | 'user' | 'adhesive';
  side?: 'front' | 'back';
  /**
   * For a copper layer: what the stackup uses it for.
   */
  function?: 'signal' | 'plane' | 'mixed';
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  plane_net?: string;
  thickness?: Quantity;
  copper_weight?: Quantity;
  dielectric?: {
    material?: string;
    thickness?: Quantity;
    permittivity?: Quantity;
  };
};
export type Placement = Entity & {
  kind: 'placement';
  id?: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  component: string;
  /**
   * The content hash of the footprint definition (RFC 11 Section 6.7).
   */
  footprint: string;
  pose: Pose1;
  side: 'front' | 'back';
  locked: boolean;
};
/**
 * A pad's identity and what it realizes; its geometry is derived from the placement and the footprint definition, never stored.
 */
export type Pad = Entity & {
  kind: 'pad';
  id?: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  pin: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  placement: string;
  pad_number: string;
};
export type Region = Entity & {
  kind: 'region';
  id?: string;
  region_kind: 'keepout' | 'placement';
  /**
   * In stackup order, top to bottom.
   *
   * @minItems 1
   */
  layers: [string, ...string[]];
  outline: Ring;
  applies_to?: string[];
  prohibits?: ('traces' | 'vias' | 'pads' | 'footprints' | 'copper')[];
};
/**
 * A copper zone's definition. Its fill is derived after every change and never stored (RFC 11 Section 6.6).
 */
export type Zone = Entity & {
  kind: 'zone';
  id?: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  net?: string;
  /**
   * In stackup order, top to bottom.
   *
   * @minItems 1
   */
  layers: [string, ...string[]];
  outline: Ring;
  priority: number;
  clearance?: Quantity;
  thermal?: {
    gap?: Quantity;
    bridge?: Quantity;
  };
  /**
   * The source record verbatim, so the CAD file is written back unchanged.
   */
  definition: string;
};
/**
 * One routed segment, or an arc when mid is present.
 */
export type Trace = Entity & {
  kind: 'trace';
  id?: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  net: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  layer: string;
  /**
   * A drawn length greater than zero, in integer nanometres.
   */
  width: number;
  start: Point;
  mid?: Point;
  end: Point;
};
export type Via = Entity & {
  kind: 'via';
  id?: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  net: string;
  at: Point;
  /**
   * A drawn length greater than zero, in integer nanometres.
   */
  diameter: number;
  /**
   * A drawn length greater than zero, in integer nanometres.
   */
  drill: number;
  /**
   * The first and last layer the via joins, in that order.
   *
   * @minItems 2
   * @maxItems 2
   */
  layers: [string, string];
};
/**
 * One routed segment, or an arc when mid is present.
 */
export type Trace1 = Entity & {
  kind: 'trace';
  id?: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  net: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  layer: string;
  /**
   * A drawn length greater than zero, in integer nanometres.
   */
  width: number;
  start: Point;
  mid?: Point;
  end: Point;
};
/**
 * The via record of RFC 11 Section 6.8 the copper becomes.
 */
export type Via1 = Entity & {
  kind: 'via';
  id?: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  net: string;
  at: Point;
  /**
   * A drawn length greater than zero, in integer nanometres.
   */
  diameter: number;
  /**
   * A drawn length greater than zero, in integer nanometres.
   */
  drill: number;
  /**
   * The first and last layer the via joins, in that order.
   *
   * @minItems 2
   * @maxItems 2
   */
  layers: [string, string];
};

export interface PcbIrRecords {
  footprint?: FootprintDefinition;
  physical?: PhysicalDesignRecord;
  'layout-input'?: LayoutInput;
  snapshot?: BoardSnapshot;
  'block-layout'?: BlockLayout;
  candidate?: Candidate;
  'placement-diff'?: PlacementDiff;
  'layout-ops'?: LayoutOperations;
  intent?: IntentFile;
}
/**
 * The geometry of one footprint in its own frame, as the front-side view, identified by the content hash of its canonical form (RFC 11 Section 6.7). It carries no net, no reference designator, and no board position.
 */
export interface FootprintDefinition {
  /**
   * The version of the RFC 11 layout records this schema set defines (RFC 11 Section 6.13).
   */
  schema_version: '2.0';
  /**
   * The library identifier the definition came from: a source reference, not an identity.
   */
  lib_id: string;
  mount: 'smd' | 'through_hole' | 'other';
  /**
   * An unordered collection: the canonical form sorts it, so equal footprints hash equal.
   */
  pads: PadDefinition[];
  courtyard?: Polygon1;
  body?: Polygon2;
}
export interface PadDefinition {
  /**
   * The pad number; empty for an unnumbered mechanical pad.
   */
  number: string;
  type: 'smd' | 'thru_hole' | 'np_thru_hole' | 'connect';
  shape: 'circle' | 'rect' | 'oval' | 'roundrect' | 'trapezoid' | 'chamfered' | 'custom';
  size: {
    /**
     * A drawn length greater than zero, in integer nanometres.
     */
    w: number;
    /**
     * A drawn length greater than zero, in integer nanometres.
     */
    h: number;
  };
  pose: Pose;
  /**
   * In stackup order, front to back.
   *
   * @minItems 1
   */
  layers: [string, ...string[]];
  drill?: {
    /**
     * A drawn length greater than zero, in integer nanometres.
     */
    d: number;
    offset?: Point;
    slot?: {
      /**
       * A drawn length greater than zero, in integer nanometres.
       */
      w: number;
      /**
       * A drawn length greater than zero, in integer nanometres.
       */
      h: number;
    };
  };
  copper: Polygon;
}
/**
 * Relative to the footprint origin.
 */
export interface Pose {
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  x: number;
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  y: number;
  /**
   * Counter-clockwise as seen from the front of the board: a whole number of quarter turns, or integer millidegrees for any other angle. A multiple of 90 degrees is always written in quarter turns, so every angle has one form.
   */
  rot:
    | {
        q: 0 | 1 | 2 | 3;
      }
    | {
        mdeg: number;
      };
}
/**
 * A point in integer nanometres, in the frame of the record that holds it.
 */
export interface Point {
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  x: number;
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  y: number;
}
/**
 * The pad's copper outline in the footprint frame, for every shape.
 */
export interface Polygon {
  outline: Ring;
  holes?: Outline[];
}
/**
 * A ring held under the key outline.
 */
export interface Outline {
  outline: Ring;
}
/**
 * Absent when the footprint draws none; never derived silently.
 */
export interface Polygon1 {
  outline: Ring;
  holes?: Outline[];
}
/**
 * An outer ring, counter-clockwise, and any holes, each clockwise. The holes are an unordered collection.
 */
export interface Polygon2 {
  outline: Ring;
  holes?: Outline[];
}
/**
 * The fields every RFC 3 entity record carries.
 */
export interface Entity {
  kind: string;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  id: string;
  /**
   * RFC 3 Section 4: a derived identity records its canonical semantic path and its full UUIDv5, whose first twelve hexadecimal digits, or more after a collision, follow the prefix of its id.
   */
  identity: {
    /**
     * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
     */
    id: string;
    origin: 'authored' | 'derived' | 'imported';
    path?: string;
    uuid?: string;
    key?: string;
    external_id?: string;
    display_name?: string;
  };
  parameters?: {};
  provenance?: {}[];
  source_location?: {};
  extensions?: {};
}
/**
 * A physical quantity of RFC 3 Section 15.1: a value a document or a person stated, kept as stated.
 */
export interface Quantity {
  kind: 'scalar' | 'range' | 'tolerance';
  unit: string;
  /**
   * A magnitude as a decimal string, never binary floating point (RFC 3 Section 15.1).
   */
  value?: string;
  /**
   * A magnitude as a decimal string, never binary floating point (RFC 3 Section 15.1).
   */
  min?: string;
  /**
   * A magnitude as a decimal string, never binary floating point (RFC 3 Section 15.1).
   */
  max?: string;
  /**
   * A magnitude as a decimal string, never binary floating point (RFC 3 Section 15.1).
   */
  typical?: string;
  /**
   * A magnitude as a decimal string, never binary floating point (RFC 3 Section 15.1).
   */
  nominal?: string;
  tolerance?: {
    kind: 'relative' | 'absolute';
    /**
     * A magnitude as a decimal string, never binary floating point (RFC 3 Section 15.1).
     */
    value: string;
  };
  conditions?: {};
}
/**
 * A position and a rotation in the frame of the record that holds it (RFC 11 Section 6.1).
 */
export interface Pose1 {
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  x: number;
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  y: number;
  /**
   * Counter-clockwise as seen from the front of the board: a whole number of quarter turns, or integer millidegrees for any other angle. A multiple of 90 degrees is always written in quarter turns, so every angle has one form.
   */
  rot:
    | {
        q: 0 | 1 | 2 | 3;
      }
    | {
        mdeg: number;
      };
}
/**
 * The document every layout engine reads, compiled from a snapshot of the design layer (RFC 11 Section 6.9). Rebuilt, never edited; addressed by the content hash of its canonical form. Collections of entities are objects keyed by stable identifier.
 */
export interface LayoutInput {
  /**
   * The version of the RFC 11 layout records this schema set defines (RFC 11 Section 6.13).
   */
  schema_version: '2.0';
  /**
   * What the input was compiled from: a kernel graph snapshot, or, for an import that did not pass through the kernel, the hashes of the files it read (RFC 11 Section 5.1).
   */
  parent:
    | {
        /**
         * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
         */
        graph: string;
      }
    | {
        /**
         * @minItems 1
         */
        imported: [
          {
            path: string;
            /**
             * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
             */
            hash: string;
          },
          ...{
            path: string;
            /**
             * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
             */
            hash: string;
          }[]
        ];
      };
  /**
   * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
   */
  config: string;
  /**
   * The content hashes of the part packs the circuits bind.
   */
  packs: string[];
  board: Board1;
  /**
   * Footprint definitions keyed by their content hash (RFC 11 Section 6.7).
   */
  footprints: {
    [k: string]: FootprintDefinition;
  };
  components: {
    [k: string]: Component;
  };
  nets: {
    [k: string]: {
      name: string;
      class?: string;
    };
  };
  /**
   * Block bindings (RFC 3 Section 10), keyed by circuit identifier.
   */
  circuits: {
    [k: string]: Binding;
  };
  /**
   * The registry constraints in scope, as projections of the RFC 3 Section 11.3 record, keyed by identifier.
   */
  constraints: {
    [k: string]: {
      class: string;
      kind: string;
      targets: string[];
      expression: {};
      enforcement: 'hard' | 'soft' | 'advisory';
      source?: string;
    };
  };
  routing: {
    traces: {
      [k: string]: Trace;
    };
    vias: {
      [k: string]: Via;
    };
    zones: {
      [k: string]: Zone;
    };
  };
  /**
   * World geometry computed by the one transform of RFC 11 Section 6.1, for engines that do not compute it. A reader that writes a design record ignores it.
   */
  derived?: {
    pads?: {
      [k: string]: {
        number: string;
        copper: Polygon2;
        layers: string[];
      }[];
    };
    courtyards?: {
      [k: string]: Polygon2;
    };
  };
}
export interface Board1 {
  unit: 'nm';
  outline: Ring;
  cutouts?: Outline[];
  thickness?: Quantity;
  /**
   * A drawn length greater than zero, in integer nanometres.
   */
  arc_tolerance?: number;
  fabrication_profile: string;
  /**
   * Top to bottom.
   *
   * @minItems 1
   */
  layers: [
    {
      /**
       * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
       */
      id: string;
      /**
       * A layer's name, as its layer record names it. A footprint definition names front-side layers.
       */
      name: string;
      layer_kind: 'copper' | 'silk' | 'mask' | 'paste' | 'courtyard' | 'fab' | 'edge' | 'user' | 'adhesive';
      side?: 'front' | 'back';
      function?: 'signal' | 'plane' | 'mixed';
      /**
       * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
       */
      plane_net?: string;
    },
    ...{
      /**
       * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
       */
      id: string;
      /**
       * A layer's name, as its layer record names it. A footprint definition names front-side layers.
       */
      name: string;
      layer_kind: 'copper' | 'silk' | 'mask' | 'paste' | 'courtyard' | 'fab' | 'edge' | 'user' | 'adhesive';
      side?: 'front' | 'back';
      function?: 'signal' | 'plane' | 'mixed';
      /**
       * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
       */
      plane_net?: string;
    }[]
  ];
  regions?: {
    [k: string]: Region;
  };
  preserved?: Preserved;
  lossy?: Lossy;
}
export interface Component {
  refdes: string;
  value?: string;
  /**
   * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
   */
  footprint: string;
  pose?: Pose2;
  side: 'front' | 'back';
  locked: boolean;
  /**
   * Who owns the placement, projected from its provenance (RFC 12 Section 9.5): a person, a layout engine, or an import adapter. An adapter compiling the input directly names itself (RFC 11 Section 6.9). Present exactly when the component is placed.
   */
  owner?: 'person' | 'engine' | 'import';
  /**
   * Explicit pad-to-net connectivity, keyed by pad number: the net each pad is on and the pin it realizes.
   */
  pads: {
    [k: string]: {
      /**
       * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
       */
      net?: string;
      /**
       * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
       */
      pin?: string;
    };
  };
  /**
   * External identifiers, held for matching and export; never identity (RFC 11 Section 6.3).
   */
  source_refs?: {
    kicad_uuid?: string;
    symbol_path?: string;
    sheet?: string;
  };
}
/**
 * A position and a rotation in the frame of the record that holds it (RFC 11 Section 6.1).
 */
export interface Pose2 {
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  x: number;
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  y: number;
  /**
   * Counter-clockwise as seen from the front of the board: a whole number of quarter turns, or integer millidegrees for any other angle. A multiple of 90 degrees is always written in quarter turns, so every angle has one form.
   */
  rot:
    | {
        q: 0 | 1 | 2 | 3;
      }
    | {
        mdeg: number;
      };
}
/**
 * A circuit's binding of the pattern it references (RFC 3 Section 10).
 */
export interface Binding {
  pattern: {
    id: string;
    /**
     * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
     */
    hash: string;
  };
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  anchor: string;
  roles: {
    /**
     * @minItems 1
     */
    [k: string]: [string, ...string[]];
  };
  deviations?: string[];
  type?: 'string';
}
/**
 * The immutable input of one engine run (RFC 11 Section 6.2). It names its layout input by content hash; the layout input is written beside it in the run, read-only.
 */
export interface BoardSnapshot {
  /**
   * The version of the RFC 11 layout records this schema set defines (RFC 11 Section 6.13).
   */
  schema_version: '2.0';
  /**
   * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
   */
  input: string;
  scope:
    | {
        kind: 'placement';
        movable: string[];
      }
    | {
        kind: 'routing';
        /**
         * The nets to route; absent means every unrouted net.
         */
        nets?: string[];
        region?: Outline;
        preserve_existing: boolean;
      }
    | {
        kind: 'verify';
      };
  /**
   * Identifiers of the layout input's constraints that are in scope for this run.
   */
  constraints: string[];
  /**
   * The ranking profile, by name (RFC 11 Section 11.3). Objective weights live in the profile, not here.
   */
  profile: string;
  seed: number;
  limits: {
    engine_seconds: number;
    wall_seconds: number;
    memory_mb: number;
  };
  preserved: {
    components: string[];
    nets: string[];
  };
  /**
   * Reference designator to stable identifier (RFC 11 Section 6.3).
   */
  reference_map: {
    /**
     * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
     */
    [k: string]: string;
  };
}
/**
 * The arrangement of one block's members in the block frame (RFC 11 Sections 6.1 and 6.10). Immutable: a changed member pose is a new block layout. Every member sits on the side the block is placed on.
 */
export interface BlockLayout {
  /**
   * The version of the RFC 11 layout records this schema set defines (RFC 11 Section 6.13).
   */
  schema_version: '2.0';
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  circuit: string;
  /**
   * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
   */
  pack: string;
  /**
   * How the pack's geometry applies to this board. A block that does not fit is held and has no layout.
   */
  fit: 'exact' | 'adaptable' | 'rules-only';
  /**
   * The anchor is a member.
   *
   * @minItems 1
   */
  members: [
    {
      /**
       * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
       */
      component: string;
      pose: Pose3;
      /**
       * Where a pose came from (RFC 11 Section 6.10).
       */
      basis: 'golden-exact' | 'golden-adapted' | 'rule' | 'packed' | 'model' | 'manual';
      /**
       * The pack rule or geometry, constraint, or run that produced the pose.
       */
      source: string;
    },
    ...{
      /**
       * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
       */
      component: string;
      pose: Pose3;
      /**
       * Where a pose came from (RFC 11 Section 6.10).
       */
      basis: 'golden-exact' | 'golden-adapted' | 'rule' | 'packed' | 'model' | 'manual';
      /**
       * The pack rule or geometry, constraint, or run that produced the pose.
       */
      source: string;
    }[]
  ];
  envelope: Outline1;
  /**
   * Where each external net leaves the block.
   */
  ports: {
    /**
     * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
     */
    net: string;
    at: Point;
    /**
     * Counter-clockwise as seen from the front of the board: a whole number of quarter turns, or integer millidegrees for any other angle. A multiple of 90 degrees is always written in quarter turns, so every angle has one form.
     */
    facing:
      | {
          q: 0 | 1 | 2 | 3;
        }
      | {
          mdeg: number;
        };
  }[];
  /**
   * The result of each constraint the binding instantiates.
   */
  results: {
    /**
     * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
     */
    constraint: string;
    /**
     * A check result state of RFC 6 Section 5.4.
     */
    state: 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'BLOCKED';
  }[];
}
/**
 * A position and a rotation in the frame of the record that holds it (RFC 11 Section 6.1).
 */
export interface Pose3 {
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  x: number;
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  y: number;
  /**
   * Counter-clockwise as seen from the front of the board: a whole number of quarter turns, or integer millidegrees for any other angle. A multiple of 90 degrees is always written in quarter turns, so every angle has one form.
   */
  rot:
    | {
        q: 0 | 1 | 2 | 3;
      }
    | {
        mdeg: number;
      };
}
/**
 * A ring held under the key outline.
 */
export interface Outline1 {
  outline: Ring;
}
/**
 * One complete placement or routing an engine returns against a layout input (RFC 11 Section 6.10). A component appears in exactly one of blocks, loose, and unplaced; a block moves as one unit, and no field moves a single member of a block.
 */
export interface Candidate {
  /**
   * The version of the RFC 11 layout records this schema set defines (RFC 11 Section 6.13).
   */
  schema_version: '2.0';
  id: string;
  /**
   * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
   */
  input: string;
  variant?: string;
  status: 'candidate' | 'verified' | 'rejected';
  blocks: {
    /**
     * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
     */
    layout: string;
    transform: Pose4;
    side: 'front' | 'back';
  }[];
  /**
   * Components placed individually.
   */
  loose: {
    /**
     * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
     */
    component: string;
    pose: Pose1;
    side: 'front' | 'back';
    /**
     * Where a pose came from (RFC 11 Section 6.10).
     */
    basis: 'golden-exact' | 'golden-adapted' | 'rule' | 'packed' | 'model' | 'manual';
    /**
     * The pack rule or geometry, the constraint, or the run that produced the pose (RFC 11 Section 6.10).
     */
    source: string;
  }[];
  /**
   * Components no engine placed.
   */
  unplaced: string[];
  /**
   * Routed copper, for a routing candidate.
   */
  routing?: {
    traces?: Trace[];
    vias?: Via[];
  };
  /**
   * Normalized diagnostics (RFC 11 Section 10.3).
   */
  findings: {}[];
  /**
   * Raw metrics (RFC 11 Section 11).
   */
  metrics: {};
}
/**
 * A position and a rotation in the frame of the record that holds it (RFC 11 Section 6.1).
 */
export interface Pose4 {
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  x: number;
  /**
   * A coordinate or a drawn length, in integer nanometres.
   */
  y: number;
  /**
   * Counter-clockwise as seen from the front of the board: a whole number of quarter turns, or integer millidegrees for any other angle. A multiple of 90 degrees is always written in quarter turns, so every angle has one form.
   */
  rot:
    | {
        q: 0 | 1 | 2 | 3;
      }
    | {
        mdeg: number;
      };
}
/**
 * What one board changes relative to another (RFC 11 Section 6.11): a layout input against a candidate produced from it, or against a later layout input. Derived, never edited, and identified by its content hash. Components are matched by stable identifier.
 */
export interface PlacementDiff {
  /**
   * The version of the RFC 11 layout records this schema set defines (RFC 11 Section 6.13).
   */
  schema_version: '2.0';
  /**
   * The layout input on the before side.
   */
  before: {
    /**
     * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
     */
    input: string;
  };
  /**
   * A candidate produced against the before side's layout input, or a later layout input.
   */
  after:
    | {
        /**
         * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
         */
        candidate: string;
      }
    | {
        /**
         * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
         */
        input: string;
      };
  /**
   * One row per component whose placement differs.
   */
  components: ComponentChange[];
  /**
   * Constraints whose result state or measured value differs. Absent when a side was not checked.
   */
  constraints?: ConstraintChange[];
  /**
   * Normalized diagnostics present on one side only. Absent when a side was not checked.
   */
  drc?: {
    added: Finding[];
    resolved: Finding[];
  };
  /**
   * Traces, vias, and zones present on one side only, by identifier.
   */
  copper?: {
    added: string[];
    removed: string[];
  };
}
export interface ComponentChange {
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  component: string;
  /**
   * The reference designator on the after side, or on the before side for a removed component.
   */
  refdes: string;
  /**
   * @minItems 1
   */
  changes: [
    'placed' | 'unplaced' | 'moved' | 'rotated' | 'flipped' | 'footprint' | 'locked' | 'unlocked' | 'added' | 'removed',
    ...(
      | 'placed'
      | 'unplaced'
      | 'moved'
      | 'rotated'
      | 'flipped'
      | 'footprint'
      | 'locked'
      | 'unlocked'
      | 'added'
      | 'removed'
    )[]
  ];
  before?: Placed;
  after?: Placed;
  /**
   * The straight-line distance between the two positions, in nanometres, rounded half away from zero. Present when both sides place the component.
   */
  distance?: number;
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  block?: string;
  /**
   * Where a pose came from (RFC 11 Section 6.10).
   */
  basis?: 'golden-exact' | 'golden-adapted' | 'rule' | 'packed' | 'model' | 'manual';
  source?: string;
  /**
   * The owner of the placement before the change (RFC 12 Section 9.5), or none when there was no placement.
   */
  owner: 'person' | 'engine' | 'import' | 'none';
  /**
   * What the commit gate's policy will require, when the after side is a candidate. A prediction, not a decision.
   */
  approval?: 'automatic' | 'required' | 'refused';
}
/**
 * Where a component sits on one side: its pose in the board frame and its side. A block member's pose is its block's transform composed with its pose in the block frame (RFC 11 Section 6.1).
 */
export interface Placed {
  pose: Pose1;
  side: 'front' | 'back';
}
export interface ConstraintChange {
  /**
   * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
   */
  constraint: string;
  /**
   * A check result state of RFC 6 Section 5.4.
   */
  before: 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'BLOCKED';
  /**
   * A check result state of RFC 6 Section 5.4.
   */
  after: 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'BLOCKED';
  measured_before?: Quantity;
  measured_after?: Quantity;
}
/**
 * A normalized diagnostic (RFC 11 Section 10.3), matched across sides by its code and its entities.
 */
export interface Finding {
  code: string;
  entities: string[];
  message?: string;
}
/**
 * The operations that return one accepted candidate to the design layer as one transaction (RFC 11 Section 6.12, RFC 12 Section 9.1): placements, deviations, and a routing candidate's copper. The operations are an unordered collection; each changes a distinct record.
 */
export interface LayoutOperations {
  /**
   * The version of the RFC 11 layout records this schema set defines (RFC 11 Section 6.13).
   */
  schema_version: '2.0';
  /**
   * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
   */
  input: string;
  /**
   * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
   */
  candidate: string;
  /**
   * @minItems 1
   */
  operations: [
    (
      | {
          op: 'place_component';
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          component: string;
          pose: Pose1;
          side: 'front' | 'back';
          /**
           * Where a pose came from (RFC 11 Section 6.10).
           */
          basis: 'golden-exact' | 'golden-adapted' | 'rule' | 'packed' | 'model' | 'manual';
          source: string;
          /**
           * Present when the operation changes a placement, or removes copper, that a person or an import adapter owns (RFC 12 Section 9.5): the owner it overrides, so the commit gate's policy can require approval.
           */
          overrides?: 'person' | 'import';
        }
      | {
          op: 'place_block';
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          circuit: string;
          /**
           * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
           */
          layout: string;
          transform: Pose1;
          side: 'front' | 'back';
          /**
           * Present when the operation changes a placement, or removes copper, that a person or an import adapter owns (RFC 12 Section 9.5): the owner it overrides, so the commit gate's policy can require approval.
           */
          overrides?: 'person' | 'import';
        }
      | {
          op: 'record_deviation';
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          circuit: string;
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          constraint?: string;
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          component?: string;
          reason: string;
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          waiver: string;
        }
      | {
          op: 'add_trace';
          trace: Trace1;
          /**
           * The run evidence that produced it.
           */
          source: string;
        }
      | {
          op: 'add_via';
          via: Via1;
          /**
           * The run evidence that produced it.
           */
          source: string;
        }
      | {
          op: 'remove_copper';
          /**
           * The trace or via the candidate's routing replaces.
           */
          entity: string;
          /**
           * The run evidence that produced it.
           */
          source: string;
          /**
           * Present when the operation changes a placement, or removes copper, that a person or an import adapter owns (RFC 12 Section 9.5): the owner it overrides, so the commit gate's policy can require approval.
           */
          overrides?: 'person' | 'import';
        }
    ),
    ...(
      | {
          op: 'place_component';
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          component: string;
          pose: Pose1;
          side: 'front' | 'back';
          /**
           * Where a pose came from (RFC 11 Section 6.10).
           */
          basis: 'golden-exact' | 'golden-adapted' | 'rule' | 'packed' | 'model' | 'manual';
          source: string;
          /**
           * Present when the operation changes a placement, or removes copper, that a person or an import adapter owns (RFC 12 Section 9.5): the owner it overrides, so the commit gate's policy can require approval.
           */
          overrides?: 'person' | 'import';
        }
      | {
          op: 'place_block';
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          circuit: string;
          /**
           * A content hash: the algorithm, a colon, and the lowercase hexadecimal digest of the canonical bytes of RFC 3 Section 17.1, trailing newline included (RFC 11 Section 6.1).
           */
          layout: string;
          transform: Pose1;
          side: 'front' | 'back';
          /**
           * Present when the operation changes a placement, or removes copper, that a person or an import adapter owns (RFC 12 Section 9.5): the owner it overrides, so the commit gate's policy can require approval.
           */
          overrides?: 'person' | 'import';
        }
      | {
          op: 'record_deviation';
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          circuit: string;
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          constraint?: string;
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          component?: string;
          reason: string;
          /**
           * A stable identifier of RFC 3 Section 4: an upper-case prefix, a hyphen, and the rest, such as CMP-3f9a2c41d07e or REQ-PWR-001. Never a KiCad UUID (RFC 11 Section 6.1).
           */
          waiver: string;
        }
      | {
          op: 'add_trace';
          trace: Trace1;
          /**
           * The run evidence that produced it.
           */
          source: string;
        }
      | {
          op: 'add_via';
          via: Via1;
          /**
           * The run evidence that produced it.
           */
          source: string;
        }
      | {
          op: 'remove_copper';
          /**
           * The trace or via the candidate's routing replaces.
           */
          entity: string;
          /**
           * The run evidence that produced it.
           */
          source: string;
          /**
           * Present when the operation changes a placement, or removes copper, that a person or an import adapter owns (RFC 12 Section 9.5): the owner it overrides, so the commit gate's policy can require approval.
           */
          overrides?: 'person' | 'import';
        }
    )[]
  ];
}
/**
 * The layout intent a person writes for one board (RFC 11 Section 7.3). A source, not a record: identified by the hash of its bytes, never canonicalized, and carrying no version. Components are named by refdes. A number is in the unit its key names. Standards extending the language add keys; a key no standard defines holds the run, which this schema leaves to the intent compiler.
 */
export interface IntentFile {
  placement?: {
    fixed?: {
      /**
       * A reference designator, resolved to a stable identifier through the reference map (RFC 11 Section 6.3).
       */
      component: string;
      edge?: 'north' | 'south' | 'east' | 'west';
      /**
       * Which way the mating face points, such as outward.
       */
      orientation?: string;
      /**
       * The position, [x, y] in millimetres, in the board frame.
       *
       * @minItems 2
       */
      at?: [number, number];
      rotation_deg?: number;
    }[];
    attachments?: {
      /**
       * A reference designator, resolved to a stable identifier through the reference map (RFC 11 Section 6.3).
       */
      component: string;
      target: {
        /**
         * A reference designator, resolved to a stable identifier through the reference map (RFC 11 Section 6.3).
         */
        component: string;
        pins?: string[];
      };
      /**
       * A length in millimetres, greater than zero. The compiler keeps it as the shortest decimal that reads back as the same number.
       */
      max_distance_mm: number;
      /**
       * critical makes the attachment hard; any other priority leaves it soft.
       */
      priority?: string;
    }[];
    groups?: {
      id: string;
      /**
       * @minItems 1
       */
      components: [string, ...string[]];
      topology?: string;
      /**
       * A length in millimetres, greater than zero. The compiler keeps it as the shortest decimal that reads back as the same number.
       */
      max_spread_mm?: number;
      /**
       * A rectangle, [x, y, width, height] in millimetres, in the board frame.
       *
       * @minItems 4
       */
      region?: [number, number, number, number];
    }[];
    separation?: {
      /**
       * @minItems 2
       * @maxItems 2
       */
      groups: [string, string];
      /**
       * A length in millimetres, greater than zero. The compiler keeps it as the shortest decimal that reads back as the same number.
       */
      minimum_mm: number;
    }[];
    keepouts?: {
      region: string;
      /**
       * What the keepout prohibits: components compiles to the region's footprints; the rest are the region's own terms (RFC 11 Section 6.8).
       */
      prohibit?: ('components' | 'copper' | 'traces' | 'vias' | 'pads')[];
      /**
       * A length in millimetres, greater than zero. The compiler keeps it as the shortest decimal that reads back as the same number.
       */
      radius_mm?: number;
    }[];
  };
  routing?: {
    /**
     * Tiers of nets in routing order; the name remaining stands for every net no tier names.
     */
    priorities?: [string, ...string[]][];
    widths?: {
      net: string;
      /**
       * A length in millimetres, greater than zero. The compiler keeps it as the shortest decimal that reads back as the same number.
       */
      min_width_mm: number;
    }[];
    currents?: {
      net: string;
      amps: number;
      /**
       * The permitted temperature rise, in degrees Celsius.
       */
      rise_c?: number;
    }[];
  };
}
