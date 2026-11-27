/**
 * Typed facade over the vendored tscircuit calculate-packing solver
 * (upstream `a2d60ae`, patches P1-P5; see VENDORED.md). This is the only
 * entry point the rest of copperhead uses.
 *
 * Semantics, established by reading the vendored solver:
 *
 * - **Units** are millimetres throughout, and the frame is **y up, x right**
 *   (KiCad's y axis points down, so a caller converts). Angles are degrees.
 * - **Origin.** A component's position is its origin: upstream's `center`.
 *   Pad centres (`FacadePad.x/y`) and the courtyard box centre
 *   (`FacadeBox.x/y`) are offsets from that origin at rotation 0, so a
 *   footprint whose courtyard is not centred on its origin is expressed with
 *   a non-zero `box.x/box.y`.
 * - **Rotation** is counter-clockwise in that y-up frame: an offset (x, y) at
 *   rotation r lands at (x·cos r - y·sin r, x·sin r + y·cos r), and pad and
 *   box width/height are swapped at 90 and 270 degrees. Rotations are
 *   normalised into [0, 360); the rotation reported for a placement is the
 *   normalised value from the component's `rotations` list.
 * - **Rotations must be multiples of 90** for a component the packer may
 *   move: the engine rotates offsets exactly but keeps box and pad
 *   dimensions unrotated at other angles, which would understate the extent.
 *   A `fixed` component may sit at any angle; the facade bakes such an angle
 *   into pre-rotated offsets and an axis-aligned box before handing it over.
 * - **The cost** is, per pad, the distance to the nearest pad on the same
 *   network on an already-placed component, squared under the `*_squared_*`
 *   strategies, scaled by `networkWeights[network]` (default 1, patch P3).
 *   A pad on a network weighted 0 contributes nothing. Components are packed
 *   greedily in `order` first, then by descending pad count, and a placed
 *   component never moves again.
 * - **Legality.** A placement keeps `minGap` from every other component's box
 *   and from every obstacle, lies inside the boundary polygon exactly (patch
 *   P2: box corners inside and no boundary segment crossing a box), and
 *   inside the boundary's bounding box. A component with no legal position is
 *   reported in `unplaced` and the others are still packed (patches P4, P5).
 *   `closestRejection` names the check that rejected the lowest-cost
 *   candidate position, or reports that the component is larger than the
 *   board in every rotation tried; `none` means no candidate was generated.
 * - **Determinism.** The same input gives byte-identical output: the packer
 *   has no randomness or clock dependence, the facade preserves input order,
 *   and `placements`/`unplaced` are returned in input order.
 *
 * Input quirks the facade smooths over (the vendored engine would otherwise
 * drop the component silently):
 * - a pad with a zero-size side is given a 1e-6 mm side;
 * - a component with no pads is given one virtual pad at its box centre on a
 *   private network, so that it still packs and still collides;
 * - a pad with an empty `network` is put on a private network of its own, so
 *   that unconnected pads do not attract each other.
 */
import { PackSolver2 } from './PackSolver2/PackSolver2.js';
import type {
  InputComponent,
  InputObstacle,
  InputPad,
  PackInput,
  PlacementRejectionReason,
  UnplacedComponent,
} from './types.js';

export type PackStrategy =
  | 'minimum_sum_squared_distance_to_network'
  | 'minimum_sum_distance_to_network'
  | 'minimum_closest_sum_squared_distance'
  | 'shortest_connection_along_outline';

/** Pad centre offset from the component origin at rotation 0, millimetres, y up. */
export interface FacadePad {
  id: string;
  network: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Courtyard box centre offset from the component origin at rotation 0, mm. */
export interface FacadeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FacadeComponent {
  id: string;
  pads: FacadePad[];
  box: FacadeBox;
  /** Allowed rotations in degrees CCW, tried in this order. */
  rotations: number[];
  /** A static component at this origin and rotation; it is not moved. */
  fixed?: { x: number; y: number; rotation: number };
}

/** Obstacle centre and size, mm. */
export interface FacadeObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FacadeInput {
  components: FacadeComponent[];
  obstacles: FacadeObstacle[];
  /** Boundary polygon, mm, y up. */
  boundary: { x: number; y: number }[];
  /** Clearance kept between boxes and from obstacles, mm. */
  minGap: number;
  networkWeights?: Record<string, number>;
  /** Component ids packed first, in order. */
  order?: string[];
  /** Default: minimum_sum_squared_distance_to_network. */
  strategy?: PackStrategy;
  /** Safety cap on solver steps. Default 300000. */
  maxIterations?: number;
}

export interface FacadePlacement {
  id: string;
  x: number;
  y: number;
  rotation: number;
}

export interface FacadeUnplaced {
  id: string;
  rotationsTried: number[];
  closestRejection: 'overlap' | 'obstacle' | 'bounds' | 'boundary' | 'none';
  message: string;
}

export interface FacadeResult {
  placements: FacadePlacement[];
  unplaced: FacadeUnplaced[];
  iterations: number;
}

const DEFAULT_MAX_ITERATIONS = 300_000;
/** Smallest pad side the engine accepts: it drops a component with a zero-size pad. */
const MIN_PAD_SIDE = 1e-6;

function fail(message: string): never {
  throw new Error(`packComponents: ${message}`);
}

function checkFinite(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${what} must be a finite number`);
  return value;
}

/** Degrees into [0, 360). */
function normaliseRotation(rotation: number): number {
  const normalised = ((rotation % 360) + 360) % 360;
  return normalised === 0 ? 0 : normalised; // turns -0 into 0
}

function isRightAngle(rotation: number): boolean {
  return Math.abs(rotation / 90 - Math.round(rotation / 90)) < 1e-9;
}

function rotatePoint(x: number, y: number, degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** Width and height of a w x h rectangle rotated by `degrees`, as an axis-aligned box. */
function rotatedExtent(w: number, h: number, degrees: number): { w: number; h: number } {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return { w: w * cos + h * sin, h: w * sin + h * cos };
}

function signedArea(points: readonly { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/**
 * The boundary as a clockwise ring without a repeated closing point or
 * duplicate vertices.
 *
 * Clockwise matters: the engine treats a clockwise ring as a pocket of free
 * space and searches inside it, which is what a board outline is. Given a
 * counter-clockwise ring it searches outside the board instead, and every
 * candidate along the boundary is then rejected.
 */
function normaliseBoundary(boundary: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (const point of boundary) {
    const x = checkFinite(point?.x, 'boundary point x');
    const y = checkFinite(point?.y, 'boundary point y');
    const previous = points[points.length - 1];
    if (previous && Math.abs(previous.x - x) < 1e-12 && Math.abs(previous.y - y) < 1e-12) continue;
    points.push({ x, y });
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && first && last && Math.abs(first.x - last.x) < 1e-12 && Math.abs(first.y - last.y) < 1e-12) {
    points.pop();
  }
  if (points.length < 3) fail('boundary needs at least 3 distinct points');
  if (signedArea(points) > 0) points.reverse();
  return points;
}

function normaliseRotations(component: FacadeComponent): number[] {
  if (!Array.isArray(component.rotations) || component.rotations.length === 0) {
    fail(`component "${component.id}" needs at least one allowed rotation`);
  }
  const rotations: number[] = [];
  for (const rotation of component.rotations) {
    const normalised = normaliseRotation(checkFinite(rotation, `component "${component.id}" rotation`));
    if (!component.fixed && !isRightAngle(normalised)) {
      fail(
        `component "${component.id}" has rotation ${rotation}: a component the packer may move must use multiples of 90 degrees, because the engine keeps box and pad dimensions unrotated at other angles`,
      );
    }
    if (!rotations.includes(normalised)) rotations.push(normalised);
  }
  return rotations;
}

function toInputPads(component: FacadeComponent): InputPad[] {
  const pads: InputPad[] = [];
  const seen = new Set<string>();
  for (const pad of component.pads ?? []) {
    if (typeof pad?.id !== 'string' || pad.id.length === 0) fail(`component "${component.id}" has a pad without an id`);
    if (seen.has(pad.id)) fail(`component "${component.id}" has two pads with id "${pad.id}"`);
    seen.add(pad.id);
    pads.push({
      padId: `${component.id}/${pad.id}`,
      // An empty network would otherwise attract every other empty-network pad.
      networkId: pad.network === '' ? ` unconnected/${component.id}/${pad.id}` : pad.network,
      type: 'rect',
      offset: {
        x: checkFinite(pad.x, `pad "${pad.id}" x`),
        y: checkFinite(pad.y, `pad "${pad.id}" y`),
      },
      size: {
        x: Math.max(checkFinite(pad.w, `pad "${pad.id}" w`), MIN_PAD_SIDE),
        y: Math.max(checkFinite(pad.h, `pad "${pad.id}" h`), MIN_PAD_SIDE),
      },
    });
  }
  if (pads.length === 0) {
    // The engine drops a component with no pads, so it would neither be
    // placed nor collide. One virtual pad at the box centre keeps it real.
    pads.push({
      padId: `${component.id}/ origin`,
      networkId: ` origin/${component.id}`,
      type: 'rect',
      offset: { x: component.box?.x ?? 0, y: component.box?.y ?? 0 },
      size: { x: MIN_PAD_SIDE, y: MIN_PAD_SIDE },
    });
  }
  return pads;
}

function toInputComponent(component: FacadeComponent): InputComponent {
  if (typeof component?.id !== 'string' || component.id.length === 0) fail('every component needs an id');
  const box = component.box;
  if (!box) fail(`component "${component.id}" needs a box`);
  const rotations = normaliseRotations(component);
  let pads = toInputPads(component);
  let courtyard = {
    offsetFromCenter: {
      x: checkFinite(box.x, `component "${component.id}" box x`),
      y: checkFinite(box.y, `component "${component.id}" box y`),
    },
    width: Math.max(checkFinite(box.w, `component "${component.id}" box w`), 0),
    height: Math.max(checkFinite(box.h, `component "${component.id}" box h`), 0),
  };

  if (!component.fixed) {
    return { componentId: component.id, pads, courtyard, availableRotationDegrees: rotations };
  }

  const x = checkFinite(component.fixed.x, `component "${component.id}" fixed x`);
  const y = checkFinite(component.fixed.y, `component "${component.id}" fixed y`);
  const rotation = normaliseRotation(checkFinite(component.fixed.rotation, `component "${component.id}" fixed rotation`));

  if (!isRightAngle(rotation)) {
    // Bake the angle in: the engine would rotate offsets but not extents.
    const rotatedOffset = rotatePoint(courtyard.offsetFromCenter.x, courtyard.offsetFromCenter.y, rotation);
    const extent = rotatedExtent(courtyard.width, courtyard.height, rotation);
    courtyard = { offsetFromCenter: rotatedOffset, width: extent.w, height: extent.h };
    pads = pads.map((pad) => {
      const offset = rotatePoint(pad.offset.x, pad.offset.y, rotation);
      const size = rotatedExtent(pad.size.x, pad.size.y, rotation);
      return { ...pad, offset, size: { x: size.w, y: size.h } };
    });
    return {
      componentId: component.id,
      pads,
      courtyard,
      isStatic: true,
      center: { x, y },
      ccwRotationOffset: 0,
      availableRotationDegrees: [0],
    };
  }

  return {
    componentId: component.id,
    pads,
    courtyard,
    isStatic: true,
    center: { x, y },
    ccwRotationOffset: rotation,
    availableRotationDegrees: [rotation],
  };
}

function toInputObstacles(obstacles: readonly FacadeObstacle[]): InputObstacle[] {
  return (obstacles ?? []).map((obstacle, index) => ({
    obstacleId: `obstacle/${index}`,
    absoluteCenter: {
      x: checkFinite(obstacle?.x, `obstacle ${index} x`),
      y: checkFinite(obstacle?.y, `obstacle ${index} y`),
    },
    width: Math.max(checkFinite(obstacle?.w, `obstacle ${index} w`), 0),
    height: Math.max(checkFinite(obstacle?.h, `obstacle ${index} h`), 0),
  }));
}

function checkNetworkWeights(networkWeights: Record<string, number> | undefined): void {
  if (!networkWeights) return;
  for (const [network, weight] of Object.entries(networkWeights)) {
    if (!Number.isFinite(weight) || weight < 0) {
      fail(`network weight for "${network}" must be a finite number >= 0`);
    }
  }
}

/** Packs `input.components` and returns their placements. Deterministic. */
export function packComponents(input: FacadeInput): FacadeResult {
  if (!input || !Array.isArray(input.components)) fail('input.components must be an array');
  const ids = new Set<string>();
  for (const component of input.components) {
    if (ids.has(component?.id)) fail(`two components share the id "${component.id}"`);
    ids.add(component?.id);
  }
  checkNetworkWeights(input.networkWeights);

  const minGap = checkFinite(input.minGap, 'minGap');
  if (minGap < 0) fail('minGap must be >= 0');
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations <= 0) fail('maxIterations must be a positive integer');

  const boundary = normaliseBoundary(input.boundary ?? []);
  const bounds = {
    minX: Math.min(...boundary.map((p) => p.x)),
    minY: Math.min(...boundary.map((p) => p.y)),
    maxX: Math.max(...boundary.map((p) => p.x)),
    maxY: Math.max(...boundary.map((p) => p.y)),
  };

  const packFirst: string[] = [];
  for (const id of input.order ?? []) {
    if (!ids.has(id)) fail(`order names "${id}", which is not one of the components`);
    packFirst.push(id);
  }

  const packInput: PackInput = {
    components: input.components.map(toInputComponent),
    obstacles: toInputObstacles(input.obstacles ?? []),
    bounds,
    boundaryOutline: boundary,
    minGap,
    packOrderStrategy: 'largest_to_smallest',
    packPlacementStrategy: input.strategy ?? 'minimum_sum_squared_distance_to_network',
    packFirst,
    ...(input.networkWeights ? { networkWeights: input.networkWeights } : {}),
  };

  const solver = new PackSolver2(packInput);
  solver.MAX_ITERATIONS = maxIterations;
  try {
    solver.solve();
  } catch {
    // BaseSolver.step has recorded the error on solver.error; whatever was
    // not placed is reported below.
  }

  const placedById = new Map<string, FacadePlacement>();
  for (const packed of solver.packedComponents as { componentId: string; isStatic?: boolean; center: { x: number; y: number }; ccwRotationOffset: number }[]) {
    if (packed.isStatic) continue;
    placedById.set(packed.componentId, {
      id: packed.componentId,
      x: packed.center.x,
      y: packed.center.y,
      rotation: normaliseRotation(packed.ccwRotationOffset),
    });
  }

  const unplacedById = new Map<string, UnplacedComponent>();
  for (const detail of solver.getUnplacedComponents() as UnplacedComponent[]) {
    if (!unplacedById.has(detail.componentId)) unplacedById.set(detail.componentId, detail);
  }

  const placements: FacadePlacement[] = [];
  const unplaced: FacadeUnplaced[] = [];
  for (const component of input.components) {
    if (component.fixed) continue;
    const placement = placedById.get(component.id);
    if (placement) {
      placements.push(placement);
      continue;
    }
    const detail = unplacedById.get(component.id);
    unplaced.push({
      id: component.id,
      rotationsTried: detail ? [...detail.rotationsTried] : [],
      closestRejection: (detail?.closestRejection ?? 'none') as FacadeUnplaced['closestRejection'],
      message:
        detail?.message ??
        `${component.id} could not be placed: the packer returned no position for it${solver.error ? ` (${solver.error})` : ''}`,
    });
  }

  return { placements, unplaced, iterations: solver.iterations };
}

export type { PlacementRejectionReason };
