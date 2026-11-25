// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/types.ts
export type ComponentId = string
export type PadId = string
export type NetworkId = string

export interface InputPad {
  padId: string
  networkId: string
  type: "rect"
  offset: { x: number; y: number }
  size: { x: number; y: number }
  absoluteCenter?: { x: number; y: number }
}

export interface OutputPad extends InputPad {
  absoluteCenter: { x: number; y: number }
}

export interface ComponentCourtyard {
  offsetFromCenter: { x: number; y: number }
  width: number
  height: number
}

export interface InputComponent {
  componentId: string
  /** Components marked as static are not moved by the packer */
  isStatic?: boolean
  /**
   * If not provided, the component can be rotated by 0, 90, 180, or 270 degrees.
   */
  availableRotationDegrees?: number[]
  /** Preconfigured center for static components */
  center?: { x: number; y: number }
  /** Preconfigured rotation (degrees CCW) for static components */
  ccwRotationOffset?: number
  pads: InputPad[]
  /** Optional courtyard defining the component's physical boundary */
  courtyard?: ComponentCourtyard
}

export interface PackedComponent extends InputComponent {
  center: { x: number; y: number }
  /** @deprecated Rotation in degrees (counterclockwise) */
  ccwRotationOffset: number
  /** Rotation in degrees (counterclockwise) - output field */
  ccwRotationDegrees?: number
  pads: OutputPad[]
}

export interface InputObstacle {
  obstacleId: string
  absoluteCenter: { x: number; y: number }
  width: number
  height: number
}

export type PackPlacementStrategy =
  | "shortest_connection_along_outline"
  | "minimum_sum_distance_to_network"
  | "minimum_sum_squared_distance_to_network"
  | "minimum_closest_sum_squared_distance"

export interface PackInput {
  components: InputComponent[]

  obstacles?: InputObstacle[]

  bounds?: { minX: number; minY: number; maxX: number; maxY: number }

  boundaryOutline?: Array<{ x: number; y: number }>

  minGap: number

  packOrderStrategy: "largest_to_smallest"
  packPlacementStrategy: PackPlacementStrategy

  weightedConnections?: Array<{
    padIds: string[]
    weight: number
    ignoreWeakConnections?: boolean
  }>

  disconnectedPackDirection?:
    | "left"
    | "right"
    | "up"
    | "down"
    | "nearest_to_center"
  packFirst?: ComponentId[]

  /**
   * copperhead patch P3: weight per network in the distance cost. Each pad's
   * term is multiplied by the weight of its network (default 1); a weight of
   * 0 removes the network from the cost.
   */
  networkWeights?: Record<NetworkId, number>
}

/** copperhead patch P5: the check that rejected a candidate position. */
export type PlacementRejectionReason =
  | "overlap"
  | "obstacle"
  | "bounds"
  | "boundary"
  | "none"

/** copperhead patch P5: a component the packer could not place, and why. */
export interface UnplacedComponent {
  componentId: ComponentId
  rotationsTried: number[]
  closestRejection: PlacementRejectionReason
  message: string
}

export interface PackOutput extends PackInput {
  components: PackedComponent[]
  /** copperhead patch P5: components that could not be placed */
  unplacedComponents?: UnplacedComponent[]
}
