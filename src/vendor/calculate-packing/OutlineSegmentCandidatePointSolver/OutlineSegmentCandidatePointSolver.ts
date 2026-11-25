// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/OutlineSegmentCandidatePointSolver/OutlineSegmentCandidatePointSolver.ts
import { clamp, type Bounds, type Point } from "../local/math-utils.js"
import type { GraphicsObject } from "../local/graphics-debug.js"
import { BaseSolver } from "../solver-utils/BaseSolver.js"
import {
  MultiOffsetIrlsSolver,
  type OffsetPadPoint,
  type PointWithNetworkId,
} from "../solver-utils/MultiOffsetIrlsSolver.js"
import { TwoPhaseIrlsSolver } from "../solver-utils/TwoPhaseIrlsSolver.js"
import type {
  InputComponent,
  PackedComponent,
  PackPlacementStrategy,
  InputObstacle,
  PackInput,
} from "../types.js"
import { isStrongConnection } from "../utils/isStrongConnection.js"
import { getNetworkWeight } from "../utils/getNetworkWeight.js"
import { rotatePoint } from "../math/rotatePoint.js"
import { getComponentBounds } from "../geometry/getComponentBounds.js"
import { getColorForString } from "../local/debug-graphics.js"
import { getOutwardNormal } from "./getOutwardNormal.js"
import { LargestRectOutsideOutlineFromPointSolver } from "../LargestRectOutsideOutlineFromPointSolver.js"
import { getInputComponentBounds } from "../geometry/getInputComponentBounds.js"
import { expandSegment } from "../math/expandSegment.js"
import { isPointInPolygon } from "../math/isPointInPolygon.js"

export interface NetworkTargetPointMappings {
  offsetPadPoints: OffsetPadPoint[]
  targetPointMap: Map<string, Point[]>
}

/**
 * Given a single segment on the outline, the component's rotation, compute the
 * optimal position for the rotated component (the position that minimizes the
 * packStrategy, generally minimizing the sum of the distances to other pads in
 * the network)
 *
 * To do this, we use the IRLS/Weiszfeld Weighted Least Squares algorithm, look
 * at the site/algorithm-visualizations/irls-weiszfeld-algorithm.page.tsx for
 * an interactive visualization of how it works.
 */
export class OutlineSegmentCandidatePointSolver extends BaseSolver {
  outlineSegment: [Point, Point]
  viableOutlineSegment: [Point, Point] | null = null
  ccwFullOutline: [Point, Point][] // The entire outline containing the segment
  componentRotationDegrees: number
  packStrategy: PackPlacementStrategy
  minGap: number
  obstacles: InputObstacle[]
  packedComponents: PackedComponent[]
  componentToPack: InputComponent
  viableBounds?: Bounds
  globalBounds?: Bounds
  boundaryOutline?: Array<{ x: number; y: number }>
  weightedConnections?: PackInput["weightedConnections"]
  networkWeights?: PackInput["networkWeights"] // copperhead patch P3
  networkTargetPointMappingsCache?: Map<number, NetworkTargetPointMappings>
  optimalPosition?: Point
  irlsSolver?: MultiOffsetIrlsSolver
  twoPhaseIrlsSolver?: TwoPhaseIrlsSolver

  override getSolverName(): string {
    return "OutlineSegmentCandidatePointSolver"
  }

  largestRectBounds?: Bounds
  largestRectMidPoint?: Point
  largestRectOrigin?: Point

  constructor(params: {
    outlineSegment: [Point, Point]
    ccwFullOutline: [Point, Point][] // The entire outline containing the segment
    componentRotationDegrees: number
    packStrategy: PackPlacementStrategy
    minGap: number
    packedComponents: PackedComponent[]
    componentToPack: InputComponent
    obstacles?: InputObstacle[]
    globalBounds?: Bounds
    boundaryOutline?: Array<{ x: number; y: number }>
    weightedConnections?: PackInput["weightedConnections"]
    networkWeights?: PackInput["networkWeights"] // copperhead patch P3
    networkTargetPointMappingsCache?: Map<number, NetworkTargetPointMappings>
  }) {
    super()
    this.outlineSegment = params.outlineSegment
    this.ccwFullOutline = params.ccwFullOutline
    this.componentRotationDegrees = params.componentRotationDegrees
    this.packStrategy = params.packStrategy
    this.minGap = params.minGap
    this.packedComponents = params.packedComponents
    this.componentToPack = params.componentToPack
    this.obstacles = params.obstacles ?? []
    this.globalBounds = params.globalBounds
    this.boundaryOutline = params.boundaryOutline
    this.weightedConnections = params.weightedConnections
    this.networkWeights = params.networkWeights // copperhead patch P3
    this.networkTargetPointMappingsCache =
      params.networkTargetPointMappingsCache
  }

  override getConstructorParams(): ConstructorParameters<
    typeof OutlineSegmentCandidatePointSolver
  >[0] {
    return {
      outlineSegment: this.outlineSegment,
      ccwFullOutline: this.ccwFullOutline,
      componentRotationDegrees: this.componentRotationDegrees,
      packStrategy: this.packStrategy,
      minGap: this.minGap,
      packedComponents: this.packedComponents,
      componentToPack: this.componentToPack,
      obstacles: this.obstacles,
      globalBounds: this.globalBounds,
      boundaryOutline: this.boundaryOutline,
      weightedConnections: this.weightedConnections,
      networkWeights: this.networkWeights, // copperhead patch P3
      networkTargetPointMappingsCache: this.networkTargetPointMappingsCache,
    }
  }

  _getOutlineBoundsWithMargin(params: { margin?: number } = {}): Bounds {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const [p1, p2] of this.ccwFullOutline) {
      minX = Math.min(minX, p1.x, p2.x)
      minY = Math.min(minY, p1.y, p2.y)
      maxX = Math.max(maxX, p1.x, p2.x)
      maxY = Math.max(maxY, p1.y, p2.y)
    }

    const margin = params.margin ?? 0

    return {
      minX: minX - margin,
      minY: minY - margin,
      maxX: maxX + margin,
      maxY: maxY + margin,
    }
  }

  override _setup() {
    const [p1, p2] = this.outlineSegment

    // Create constraint function to keep position on outline segment and avoid collision
    const constraintFn = (point: Point): Point => {
      const projectedPoint = this.projectPointOntoSegment(
        point,
        this.viableOutlineSegment!,
      )
      return this.adjustPositionForOutlineCollision(projectedPoint)
    }

    const outwardNormal = getOutwardNormal(
      this.outlineSegment,
      this.ccwFullOutline,
    )
    const componentBounds = getInputComponentBounds(this.componentToPack, {
      rotationDegrees: this.componentRotationDegrees,
    })

    const packedComponentBoundsWithMargin = this._getOutlineBoundsWithMargin({
      margin:
        Math.max(
          componentBounds.maxX - componentBounds.minX,
          componentBounds.maxY - componentBounds.minY,
        ) *
          2 +
        this.minGap * 2,
    })

    this.largestRectMidPoint = {
      x: (p1.x + p2.x) / 2,
      y: (p1.y + p2.y) / 2,
    }
    this.largestRectOrigin = {
      x: this.largestRectMidPoint.x + outwardNormal.x * 0.0001,
      y: this.largestRectMidPoint.y + outwardNormal.y * 0.0001,
    }

    // Calculate signed area to determine outline winding
    // CCW (positive): use "outside" mode - free space is outside the obstacle boundary
    // CW (negative): use "inside" mode - free space is inside the hole
    const outlinePoints = this.ccwFullOutline.flatMap(([p]) => p)
    let signedArea = 0
    for (let i = 0; i < outlinePoints.length; i++) {
      const p1 = outlinePoints[i]!
      const p2 = outlinePoints[(i + 1) % outlinePoints.length]!
      signedArea += p1.x * p2.y - p2.x * p1.y
    }
    signedArea /= 2
    const isCW = signedArea < 0
    const rectSearchMode = isCW ? "inside" : "outside"

    const largestRectSolverParams: ConstructorParameters<
      typeof LargestRectOutsideOutlineFromPointSolver
    >[0] = {
      ccwFullOutline: outlinePoints,
      globalBounds: packedComponentBoundsWithMargin,
      origin: this.largestRectOrigin,
      mode: rectSearchMode,
    }
    const largestRectSolver = new LargestRectOutsideOutlineFromPointSolver(
      largestRectSolverParams,
    )
    largestRectSolver.solve()

    const largestRectBounds = largestRectSolver.getLargestRectBounds()
    this.largestRectBounds = largestRectBounds

    // The viable bounds is the largest rect bounds minus padding for the
    // component
    const segmentNormAbs = {
      x: Math.abs(
        Math.sign(this.outlineSegment[1].x - this.outlineSegment[0].x),
      ),
      y: Math.abs(
        Math.sign(this.outlineSegment[1].y - this.outlineSegment[0].y),
      ),
    }
    let viableBounds = {
      minX: largestRectBounds.minX - componentBounds.minX * segmentNormAbs.x,
      minY: largestRectBounds.minY - componentBounds.minY * segmentNormAbs.y,
      maxX: largestRectBounds.maxX - componentBounds.maxX * segmentNormAbs.x,
      maxY: largestRectBounds.maxY - componentBounds.maxY * segmentNormAbs.y,
    }

    // Further constrain viable bounds by boundary outline if present
    if (this.boundaryOutline && this.boundaryOutline.length >= 3) {
      let boundaryMinX = Infinity
      let boundaryMinY = Infinity
      let boundaryMaxX = -Infinity
      let boundaryMaxY = -Infinity

      for (const point of this.boundaryOutline) {
        boundaryMinX = Math.min(boundaryMinX, point.x)
        boundaryMinY = Math.min(boundaryMinY, point.y)
        boundaryMaxX = Math.max(boundaryMaxX, point.x)
        boundaryMaxY = Math.max(boundaryMaxY, point.y)
      }

      // Constrain viable bounds to fit within the boundary outline bounds,
      // accounting for component size
      viableBounds = {
        minX: Math.max(viableBounds.minX, boundaryMinX - componentBounds.minX),
        minY: Math.max(viableBounds.minY, boundaryMinY - componentBounds.minY),
        maxX: Math.min(viableBounds.maxX, boundaryMaxX - componentBounds.maxX),
        maxY: Math.min(viableBounds.maxY, boundaryMaxY - componentBounds.maxY),
      }
    }

    this.viableBounds = viableBounds

    const viableBoundsWidth = viableBounds.maxX - viableBounds.minX
    const viableBoundsHeight = viableBounds.maxY - viableBounds.minY
    const componentBoundsWidth = componentBounds.maxX - componentBounds.minX
    const componentBoundsHeight = componentBounds.maxY - componentBounds.minY

    if (
      viableBoundsWidth < componentBoundsWidth ||
      viableBoundsHeight < componentBoundsHeight
    ) {
      this.failed = true
      this.error =
        "There is nowhere for the component to fit along this outline section"
      return
    }

    // The viable segment is the segment adjusted to fit inside the viable bounds
    const segmentLength = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const expandedOutlineSegment = expandSegment(
      this.outlineSegment,
      segmentLength,
    )
    const [s1, s2] = expandedOutlineSegment
    this.viableOutlineSegment = [
      {
        x: clamp(s1.x, viableBounds.minX, viableBounds.maxX),
        y: clamp(s1.y, viableBounds.minY, viableBounds.maxY),
      },
      {
        x: clamp(s2.x, viableBounds.minX, viableBounds.maxX),
        y: clamp(s2.y, viableBounds.minY, viableBounds.maxY),
      },
    ]

    // Use segment midpoint as initial position
    const [vp1, vp2] = this.viableOutlineSegment
    const initialPosition = this.adjustPositionForOutlineCollision({
      x: (vp1.x + vp2.x) / 2,
      y: (vp1.y + vp2.y) / 2,
    })

    // Network targets do not affect whether the component can fit along this
    // outline segment, so defer their construction until after fit rejection.
    const { offsetPadPoints, targetPointMap } =
      this.getNetworkTargetPointMappings()

    if (this.packStrategy === "minimum_closest_sum_squared_distance") {
      this.twoPhaseIrlsSolver = new TwoPhaseIrlsSolver({
        offsetPadPoints,
        targetPointMap,
        initialPosition,
        constraintFn,
        epsilon: 1e-6,
        maxIterations: 50,
        networkWeights: this.networkWeights, // copperhead patch P3
      })
    } else {
      this.irlsSolver = new MultiOffsetIrlsSolver({
        offsetPadPoints,
        targetPointMap,
        initialPosition,
        constraintFn,
        epsilon: 1e-6,
        maxIterations: 50,
        useSquaredDistance:
          this.packStrategy === "minimum_sum_squared_distance_to_network",
        networkWeights: this.networkWeights, // copperhead patch P3
      })
    }
  }

  override _step() {
    const activeSolver = this.irlsSolver || this.twoPhaseIrlsSolver
    if (!activeSolver) {
      this.solved = true
      return
    }

    activeSolver.step()

    if (activeSolver.solved) {
      const rawPosition = activeSolver.getBestPosition()
      this.optimalPosition = rawPosition
      this.solved = true
    } else if (activeSolver.failed) {
      this.failed = true
      this.error = activeSolver.error
    }
  }

  /**
   * Get pad offset points and target point mappings for network connections
   */
  private getNetworkTargetPointMappings(): NetworkTargetPointMappings {
    const cachedMappings = this.networkTargetPointMappingsCache?.get(
      this.componentRotationDegrees,
    )
    if (cachedMappings) return cachedMappings

    // Get rotated pads for the component being placed
    const rotatedPads = this.getRotatedComponentPads()

    // Create offset pad points from the component's rotated pads
    const offsetPadPoints: OffsetPadPoint[] = rotatedPads.map((pad) => ({
      id: pad.padId,
      offsetX: pad.offset.x,
      offsetY: pad.offset.y,
    }))

    // Create target point mappings: each pad maps to other pads with same networkId
    const targetPointMap = new Map<string, Point[]>()

    for (const pad of rotatedPads) {
      const targetPoints: PointWithNetworkId[] = []

      // Find all packed pads that share the same network with this pad
      for (const packedComponent of this.packedComponents) {
        for (const packedPad of packedComponent.pads) {
          if (packedPad.networkId === pad.networkId) {
            // Only include strong connections (skip weak connections when weightedConnections is provided)
            if (
              !isStrongConnection(
                pad.padId,
                packedPad.padId,
                this.weightedConnections,
              )
            ) {
              continue
            }
            // copperhead patch P3: a network weighted 0 contributes nothing
            if (
              getNetworkWeight(this.networkWeights, packedPad.networkId) <= 0
            ) {
              continue
            }
            targetPoints.push({
              ...packedPad.absoluteCenter,
              networkId: packedPad.networkId,
            })
          }
        }
      }

      targetPointMap.set(pad.padId, targetPoints)
    }

    const mappings = { offsetPadPoints, targetPointMap }
    this.networkTargetPointMappingsCache?.set(
      this.componentRotationDegrees,
      mappings,
    )
    return mappings
  }

  /**
   * Project a point onto the outline segment
   */
  private projectPointOntoSegment(
    point: Point,
    segment: [Point, Point],
  ): Point {
    const [p1, p2] = segment

    // Vector from p1 to p2
    const segmentX = p2.x - p1.x
    const segmentY = p2.y - p1.y

    // Vector from p1 to point
    const pointX = point.x - p1.x
    const pointY = point.y - p1.y

    // Project point onto segment line
    const segmentLengthSq = segmentX * segmentX + segmentY * segmentY

    if (segmentLengthSq === 0) {
      // Degenerate segment, return p1
      return { x: p1.x, y: p1.y }
    }

    // Parameter t represents position along segment (0 = p1, 1 = p2)
    const t = Math.max(
      0,
      Math.min(1, (pointX * segmentX + pointY * segmentY) / segmentLengthSq),
    )

    return {
      x: p1.x + t * segmentX,
      y: p1.y + t * segmentY,
    }
  }

  /**
   * Get rotated pads for the component being placed
   */
  private getRotatedComponentPads() {
    const rotationRadians = (this.componentRotationDegrees * Math.PI) / 180
    return this.componentToPack.pads.map((pad) => ({
      ...pad,
      size:
        (this.componentRotationDegrees + 90) % 180 === 0
          ? {
              x: pad.size.y,
              y: pad.size.x,
            }
          : pad.size,
      offset: rotatePoint(pad.offset, rotationRadians),
    }))
  }

  /**
   * Create a temporary PackedComponent with the given center position and applied rotation
   */
  private createTemporaryPackedComponent(center: Point): PackedComponent {
    const rotationRadians = (this.componentRotationDegrees * Math.PI) / 180

    const flipWidthHeight = (this.componentRotationDegrees + 90) % 180 === 0

    return {
      componentId: this.componentToPack.componentId,
      center,
      ccwRotationOffset: this.componentRotationDegrees,
      pads: this.componentToPack.pads.map((pad) => {
        const rotatedOffset = rotatePoint(pad.offset, rotationRadians)
        return {
          ...pad,
          size: {
            x: flipWidthHeight ? pad.size.y : pad.size.x,
            y: flipWidthHeight ? pad.size.x : pad.size.y,
          },
          absoluteCenter: {
            x: center.x + rotatedOffset.x,
            y: center.y + rotatedOffset.y,
          },
        }
      }),
      courtyard: this.componentToPack.courtyard,
    }
  }

  /**
   * Adjust position to avoid component bounds crossing to the inside of the outline
   * and ensure the component stays within the boundary outline
   */
  private adjustPositionForOutlineCollision(center: Point): Point {
    // Create temporary component at this position
    const tempComponent = this.createTemporaryPackedComponent(center)

    // Get bounds of the rotated component
    const bounds = getComponentBounds(tempComponent, 0)

    // Get the outward normal for the current segment to push the component out
    const outwardNormal = getOutwardNormal(
      this.outlineSegment,
      this.ccwFullOutline,
    )

    // To compute push distance, we need to consider the direction of the
    // outward normal and the distance we need to push using the minX/maxX or
    // minY/maxY relative to the center
    const isHorizontalNormal =
      Math.abs(outwardNormal.x) > Math.abs(outwardNormal.y)
    const isVerticalNormal = !isHorizontalNormal

    let adjustedCenter = center

    if (isHorizontalNormal) {
      const isXPlusFacing = outwardNormal.x > 0
      const isXMinusFacing = !isXPlusFacing
      if (isXPlusFacing) {
        adjustedCenter = {
          x: bounds.maxX,
          y: center.y,
        }
      } else if (isXMinusFacing) {
        adjustedCenter = {
          x: bounds.minX,
          y: center.y,
        }
      }
    } else if (isVerticalNormal) {
      const isYPlusFacing = outwardNormal.y > 0
      const isYMinusFacing = !isYPlusFacing
      if (isYPlusFacing) {
        adjustedCenter = {
          x: center.x,
          y: bounds.maxY,
        }
      } else if (isYMinusFacing) {
        adjustedCenter = {
          x: center.x,
          y: bounds.minY,
        }
      }
    }

    // If boundary outline is specified, ensure all component corners are within it
    if (this.boundaryOutline && this.boundaryOutline.length >= 3) {
      const adjustedComponent =
        this.createTemporaryPackedComponent(adjustedCenter)
      const adjustedBounds = getComponentBounds(adjustedComponent, 0)

      // Check if all pads are within the boundary outline
      const allPadsInside = adjustedComponent.pads.every((pad) =>
        isPointInPolygon(pad.absoluteCenter, this.boundaryOutline!),
      )

      // Also check corners of component bounds
      const cornersInside = [
        { x: adjustedBounds.minX, y: adjustedBounds.minY },
        { x: adjustedBounds.minX, y: adjustedBounds.maxY },
        { x: adjustedBounds.maxX, y: adjustedBounds.minY },
        { x: adjustedBounds.maxX, y: adjustedBounds.maxY },
      ].every((corner) => isPointInPolygon(corner, this.boundaryOutline!))

      if (!allPadsInside || !cornersInside) {
        // Clamp center to viable bounds
        if (this.viableBounds) {
          adjustedCenter = {
            x: clamp(
              adjustedCenter.x,
              this.viableBounds.minX,
              this.viableBounds.maxX,
            ),
            y: clamp(
              adjustedCenter.y,
              this.viableBounds.minY,
              this.viableBounds.maxY,
            ),
          }
        }
      }
    }

    return adjustedCenter
  }

  override visualize(): GraphicsObject {
    const graphics: GraphicsObject = {
      lines: [],
      points: [],
      rects: [],
      circles: [],
    }

    // Draw obstacles
    if (this.obstacles && this.obstacles.length > 0) {
      for (const obstacle of this.obstacles) {
        graphics.rects!.push({
          center: obstacle.absoluteCenter,
          width: obstacle.width,
          height: obstacle.height,
          fill: "rgba(0,0,0,0.1)",
          stroke: "#555",
          label: obstacle.obstacleId,
        })
      }
    }

    if (this.globalBounds) {
      graphics.lines!.push({
        points: [
          { x: this.globalBounds.minX, y: this.globalBounds.minY },
          { x: this.globalBounds.minX, y: this.globalBounds.maxY },
          { x: this.globalBounds.maxX, y: this.globalBounds.maxY },
          { x: this.globalBounds.maxX, y: this.globalBounds.minY },
          { x: this.globalBounds.minX, y: this.globalBounds.minY },
        ],
        strokeColor: "rgba(255,0,255,0.5)",
        strokeDash: "2 2",
      })
    }

    if (this.boundaryOutline && this.boundaryOutline.length) {
      const outlinePoints = [...this.boundaryOutline]
      if (
        outlinePoints.length > 0 &&
        (outlinePoints[0]!.x !== outlinePoints[outlinePoints.length - 1]!.x ||
          outlinePoints[0]!.y !== outlinePoints[outlinePoints.length - 1]!.y)
      ) {
        outlinePoints.push({ ...outlinePoints[0]! })
      }

      graphics.lines!.push({
        points: outlinePoints,
        strokeColor: "rgba(0, 0, 255, 0.5)",
        strokeDash: "4 2",
      })
    }

    if (this.viableBounds) {
      graphics.rects!.push({
        center: {
          x: (this.viableBounds.minX + this.viableBounds.maxX) / 2,
          y: (this.viableBounds.minY + this.viableBounds.maxY) / 2,
        },
        width: this.viableBounds.maxX - this.viableBounds.minX,
        height: this.viableBounds.maxY - this.viableBounds.minY,
        fill: "rgba(0,255,0,0.1)",
        label: "Viable Bounds",
      })
    }

    if (this.largestRectBounds) {
      graphics.rects!.push({
        center: {
          x: (this.largestRectBounds.minX + this.largestRectBounds.maxX) / 2,
          y: (this.largestRectBounds.minY + this.largestRectBounds.maxY) / 2,
        },
        width: this.largestRectBounds.maxX - this.largestRectBounds.minX,
        height: this.largestRectBounds.maxY - this.largestRectBounds.minY,
        fill: "rgba(255,0,255,0.4)",
      })
    }

    if (this.largestRectMidPoint) {
      graphics.points!.push({
        ...this.largestRectMidPoint,
        label: "Largest Rect Mid Point",
        color: "rgba(128,0,255,1)",
      })
    }

    if (this.largestRectOrigin) {
      graphics.points!.push({
        ...this.largestRectOrigin,
        label: "Largest Rect Origin",
        color: "rgba(255,0,128,1)",
      })
    }

    // Draw outline segment
    if (this.viableOutlineSegment) {
      const [p1, p2] = this.viableOutlineSegment
      graphics.lines!.push({
        points: [p1, p2],
        strokeColor: "#2196F3",
      })
    }

    const [osp1, osp2] = this.outlineSegment
    graphics.lines!.push({
      points: [osp1, osp2],
      strokeColor: "rgba(255,0,0,1)",
      strokeDash: "3 3",
    })

    // Draw full outline
    for (const [p1, p2] of this.ccwFullOutline) {
      graphics.lines!.push({
        points: [p1, p2],
        strokeColor: "rgba(0,0,0,0.5)",
        strokeDash: "4 4",
      })
    }

    // Draw packed components
    for (const component of this.packedComponents) {
      // Draw pads
      for (const pad of component.pads) {
        graphics.rects!.push({
          center: pad.absoluteCenter,
          width: pad.size.x,
          height: pad.size.y,
          fill: getColorForString(pad.networkId, 0.5),
          stroke: "#333",
          label: `${pad.padId} (${pad.networkId})`,
        })
      }
    }

    const pos = this.optimalPosition ??
      this.irlsSolver?.currentPosition ??
      this.twoPhaseIrlsSolver?.currentPosition ?? {
        x: 0,
        y: 0,
      }

    // Get rotated pads for drawing at optimal position
    const rotatedPads = this.getRotatedComponentPads()

    // Draw pads at optimal position with proper rotation
    for (const pad of rotatedPads) {
      const padPos = {
        x: pos.x + pad.offset.x,
        y: pos.y + pad.offset.y,
      }

      graphics.rects!.push({
        center: padPos,
        width: pad.size.x,
        height: pad.size.y,
        fill: this.failed
          ? "rgba(255,0,0,0.5)"
          : getColorForString(pad.networkId, 0.5),
        label: `${pad.padId} (${pad.networkId})`,
      })

      // Draw connections to existing pads of same network
      for (const packedComponent of this.packedComponents) {
        for (const packedPad of packedComponent.pads) {
          if (packedPad.networkId === pad.networkId) {
            const isStrong = isStrongConnection(
              pad.padId,
              packedPad.padId,
              this.weightedConnections,
            )
            graphics.lines!.push({
              points: [padPos, packedPad.absoluteCenter],
              strokeColor: pad.networkId === "VCC" ? "#FF6B6B" : "#4ECDC4",
              // Solid line for strong connections, dashed for weak
              strokeDash: isStrong ? undefined : "4 2",
              label: `${pad.networkId} ${isStrong ? "strong" : "weak"}`,
            })
          }
        }
      }
    }

    // Include solver visualization if available
    const activeSolver = this.irlsSolver || this.twoPhaseIrlsSolver
    if (activeSolver) {
      // Draw current solver position
      const currentPos = activeSolver.currentPosition
      graphics.points!.push({
        ...currentPos,
        color: "#f44336",
      })

      // Include solver visualization
      const solverViz = activeSolver.visualize()

      // Merge solver graphics
      if (solverViz.lines) {
        graphics.lines!.push(...solverViz.lines)
      }
      if (solverViz.circles) {
        graphics.circles!.push(...solverViz.circles)
      }
      if (solverViz.rects) {
        graphics.rects!.push(...solverViz.rects)
      }
      if (solverViz.points) {
        graphics.points!.push(...solverViz.points)
      }
    }

    // Draw optimal position if found (as a point)
    if (this.optimalPosition) {
      graphics.points!.push({
        ...this.optimalPosition,
        color: "rgba(76, 175, 80, 0.3)",
      })
    }

    return graphics
  }

  override getOutput() {
    return this.optimalPosition ?? null
  }
}
