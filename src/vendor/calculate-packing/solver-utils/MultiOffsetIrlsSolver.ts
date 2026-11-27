// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/solver-utils/MultiOffsetIrlsSolver.ts
import type { GraphicsObject } from "../local/graphics-debug.js"
import { BaseSolver } from "./BaseSolver.js"
import { getNetworkWeight } from "../utils/getNetworkWeight.js"

export interface Point {
  x: number
  y: number
}

export interface PointWithNetworkId extends Point {
  networkId?: string
}

export interface OffsetPadPoint {
  id: string
  offsetX: number
  offsetY: number
}

export interface MultiOffsetIrlsSolverParams {
  /** Offset pad points relative to the current position */
  offsetPadPoints: OffsetPadPoint[]
  /** Map from offset pad ID to array of target points it should minimize distance to */
  targetPointMap: Map<string, Point[]>
  /** Initial position for the algorithm */
  initialPosition: Point
  /** Optional constraint function that maps a point to the nearest valid position */
  constraintFn?: (point: Point) => Point
  /** Convergence tolerance */
  epsilon?: number
  /** Maximum iterations before giving up */
  maxIterations?: number
  /** Whether to use squared distances (for sum of squared distances optimization) */
  useSquaredDistance?: boolean
  /**
   * copperhead patch P3: weight per network, looked up by each target point's
   * networkId (default 1). It scales that target's IRLS weight.
   */
  networkWeights?: Record<string, number>
}

/**
 * Multi-Offset IRLS (Iteratively Reweighted Least Squares) Solver
 * Extends the Weiszfeld algorithm to optimize a single position that minimizes
 * the total distance from multiple offset pad points to their assigned target points.
 *
 * The offset pad points are positioned relative to the current position, and the
 * algorithm finds the optimal position that minimizes the sum of distances from
 * each offset pad to its assigned target points.
 */
export class MultiOffsetIrlsSolver extends BaseSolver {
  public offsetPadPoints: OffsetPadPoint[]
  public targetPointMap: Map<string, PointWithNetworkId[]>
  public currentPosition: Point
  public constraintFn?: (point: Point) => Point
  public epsilon: number
  public useSquaredDistance: boolean
  public networkWeights?: Record<string, number> // copperhead patch P3
  public optimalPosition?: Point

  private readonly initialPosition: Point

  override getSolverName(): string {
    return "MultiOffsetIrlsSolver"
  }

  constructor(params: MultiOffsetIrlsSolverParams) {
    super()
    this.offsetPadPoints = [...params.offsetPadPoints]
    this.targetPointMap = new Map(params.targetPointMap)
    this.initialPosition = { ...params.initialPosition }
    this.currentPosition = { ...params.initialPosition }
    this.constraintFn = params.constraintFn
    this.epsilon = params.epsilon ?? 1e-6
    this.useSquaredDistance = params.useSquaredDistance ?? false
    this.networkWeights = params.networkWeights // copperhead patch P3
    this.MAX_ITERATIONS = params.maxIterations ?? 100
  }

  override getConstructorParams(): MultiOffsetIrlsSolverParams {
    return {
      offsetPadPoints: this.offsetPadPoints.map((pad) => ({ ...pad })),
      targetPointMap: new Map(this.targetPointMap),
      initialPosition: this.initialPosition,
      constraintFn: this.constraintFn,
      epsilon: this.epsilon,
      useSquaredDistance: this.useSquaredDistance,
      networkWeights: this.networkWeights, // copperhead patch P3
      maxIterations: this.MAX_ITERATIONS,
    }
  }

  override _setup() {
    this.currentPosition = { ...this.initialPosition }
    this.optimalPosition = undefined

    // Check if we have any work to do
    const hasTargets = Array.from(this.targetPointMap.values()).some(
      (targets) => targets.length > 0,
    )
    if (!hasTargets || this.offsetPadPoints.length === 0) {
      this.optimalPosition = { ...this.currentPosition }
      this.solved = true
    }
  }

  override _step() {
    if (this.offsetPadPoints.length === 0) return

    const { x: currentX, y: currentY } = this.currentPosition

    let weightedSumX = 0
    let weightedSumY = 0
    let totalWeight = 0

    // Calculate weights and weighted sum using Weiszfeld method
    // For each offset pad, consider its position relative to currentPosition
    for (const pad of this.offsetPadPoints) {
      const targetPoints = this.targetPointMap.get(pad.id) || []
      if (targetPoints.length === 0) continue

      // Current absolute position of this offset pad
      const padX = currentX + pad.offsetX
      const padY = currentY + pad.offsetY

      for (const targetPoint of targetPoints) {
        const dx = padX - targetPoint.x
        const dy = padY - targetPoint.y
        const distance = Math.sqrt(dx * dx + dy * dy)

        // For squared distance optimization, we use different weighting
        let weight: number
        if (this.useSquaredDistance) {
          // For sum of squared distances, the optimal point is just the centroid
          // But we still use IRLS for consistency with constraints
          weight = 1
        } else {
          // Weight is inverse of distance (IRLS weighting for geometric median)
          // Use large weight for very close points to avoid division by zero
          weight = distance < this.epsilon ? 1e6 : 1 / distance
        }

        // copperhead patch P3: scale by the weight of the target's network
        weight *= getNetworkWeight(this.networkWeights, targetPoint.networkId)

        // The target for the currentPosition is the targetPoint minus the offset
        const targetForCurrentPos = {
          x: targetPoint.x - pad.offsetX,
          y: targetPoint.y - pad.offsetY,
        }

        weightedSumX += weight * targetForCurrentPos.x
        weightedSumY += weight * targetForCurrentPos.y
        totalWeight += weight
      }
    }

    // Calculate new position as weighted average
    const newPosition: Point = {
      x: totalWeight > 0 ? weightedSumX / totalWeight : currentX,
      y: totalWeight > 0 ? weightedSumY / totalWeight : currentY,
    }

    // Apply constraint function if provided
    const constrainedPosition = this.constraintFn
      ? this.constraintFn(newPosition)
      : newPosition

    // Check for convergence
    const dx = constrainedPosition.x - currentX
    const dy = constrainedPosition.y - currentY
    const positionChange = Math.sqrt(dx * dx + dy * dy)

    if (positionChange < this.epsilon) {
      this.optimalPosition = { ...constrainedPosition }
      this.solved = true
      return
    }

    this.currentPosition = constrainedPosition
  }

  /**
   * Get the current best position
   */
  getBestPosition(): Point {
    return this.optimalPosition || this.currentPosition
  }

  /**
   * Get the current absolute positions for all offset pad points
   */
  getOffsetPadPositions(): Map<string, Point> {
    const currentPos = this.getBestPosition()
    const padPositions = new Map<string, Point>()

    for (const pad of this.offsetPadPoints) {
      padPositions.set(pad.id, {
        x: currentPos.x + pad.offsetX,
        y: currentPos.y + pad.offsetY,
      })
    }

    return padPositions
  }

  /**
   * Get the absolute position for a specific offset pad point
   */
  getOffsetPadPosition(padId: string): Point | undefined {
    const positions = this.getOffsetPadPositions()
    return positions.get(padId)
  }

  /**
   * Calculate total distance from current position to all assigned target points
   */
  getTotalDistance(position?: Point): number {
    const pos = position || this.getBestPosition()
    let totalDistance = 0

    for (const pad of this.offsetPadPoints) {
      const padPosition = {
        x: pos.x + pad.offsetX,
        y: pos.y + pad.offsetY,
      }

      const targetPoints = this.targetPointMap.get(pad.id) || []
      for (const target of targetPoints) {
        const dx = padPosition.x - target.x
        const dy = padPosition.y - target.y
        if (this.useSquaredDistance) {
          totalDistance += dx * dx + dy * dy
        } else {
          totalDistance += Math.sqrt(dx * dx + dy * dy)
        }
      }
    }

    return totalDistance
  }

  /**
   * Calculate total distance for a specific offset pad point
   */
  getDistanceForPad(padId: string, position?: Point): number {
    const pos = position || this.getBestPosition()
    const pad = this.offsetPadPoints.find((p) => p.id === padId)
    if (!pad) return 0

    const padPosition = {
      x: pos.x + pad.offsetX,
      y: pos.y + pad.offsetY,
    }

    const targetPoints = this.targetPointMap.get(padId) || []
    return targetPoints.reduce((sum, target) => {
      const dx = padPosition.x - target.x
      const dy = padPosition.y - target.y
      if (this.useSquaredDistance) {
        return sum + (dx * dx + dy * dy)
      } else {
        return sum + Math.sqrt(dx * dx + dy * dy)
      }
    }, 0)
  }

  computeProgress(): number {
    if (this.offsetPadPoints.length === 0) return 1

    // Progress based on convergence - as we get closer to optimal, progress increases
    const initialDistance = this.getTotalDistance(this.initialPosition)
    const currentDistance = this.getTotalDistance()

    if (initialDistance === 0) return 1

    // Simple progress metric - could be improved
    const improvement = Math.max(0, initialDistance - currentDistance)
    return Math.min(1, improvement / initialDistance)
  }

  override visualize(): GraphicsObject {
    const graphics: GraphicsObject = {
      lines: [],
      points: [],
      rects: [],
      circles: [],
    }

    // Draw target points for each offset pad (different colors for each pad)
    const colors = [
      "#4CAF50",
      "#2196F3",
      "#FF9800",
      "#9C27B0",
      "#F44336",
      "#607D8B",
    ]
    const currentPos = this.getBestPosition()

    for (let i = 0; i < this.offsetPadPoints.length; i++) {
      const pad = this.offsetPadPoints[i]
      if (!pad) continue

      const color = colors[i % colors.length]
      const targetPoints = this.targetPointMap.get(pad.id) || []

      // Current absolute position of this offset pad
      const padPosition = {
        x: currentPos.x + pad.offsetX,
        y: currentPos.y + pad.offsetY,
      }

      // Draw target points for this pad
      for (const point of targetPoints) {
        graphics.points!.push({
          ...point,
          color: color,
        })
      }

      // Draw lines from pad to its target points
      for (const point of targetPoints) {
        graphics.lines!.push({
          points: [padPosition, point],
          strokeColor: color,
        })
      }

      // Draw offset pad point (with different styling to distinguish from targets)
      graphics.points!.push({
        x: padPosition.x,
        y: padPosition.y,
        color: color,
      })
    }

    // Draw current position (center point that all offset pads are relative to)
    graphics.points!.push({
      ...this.currentPosition,
      color: "#f44336", // Red like in IrlsSolver
    })

    // Draw optimal position if found
    if (this.optimalPosition) {
      graphics.points!.push({
        ...this.optimalPosition,
        color: "rgba(76, 175, 80, 0.3)", // Semi-transparent green like in IrlsSolver
      })
    }

    return graphics
  }

  override getOutput() {
    return this.optimalPosition ?? this.currentPosition
  }
}
