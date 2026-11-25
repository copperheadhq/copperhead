// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/solver-utils/IrlsSolver.ts
import type { GraphicsObject } from "../local/graphics-debug.js"
import { BaseSolver } from "./BaseSolver.js"

export interface Point {
  x: number
  y: number
}

export interface IrlsSolverParams {
  /** Target points to minimize distance to */
  targetPoints: Point[]
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
}

/**
 * IRLS (Iteratively Reweighted Least Squares) Solver using the Weiszfeld algorithm
 * to find the geometric median (point that minimizes sum of distances to target points).
 *
 * This solver can be used as a subsolver in other optimization problems where
 * you need to find the optimal position that minimizes total distance to a set of points.
 */
export class IrlsSolver extends BaseSolver {
  public targetPoints: Point[]
  public currentPosition: Point
  public constraintFn?: (point: Point) => Point
  public epsilon: number
  public useSquaredDistance: boolean
  public optimalPosition?: Point

  private readonly initialPosition: Point

  override getSolverName(): string {
    return "IrlsSolver"
  }

  constructor(params: IrlsSolverParams) {
    super()
    this.targetPoints = params.targetPoints
    this.initialPosition = { ...params.initialPosition }
    this.currentPosition = { ...params.initialPosition }
    this.constraintFn = params.constraintFn
    this.epsilon = params.epsilon ?? 1e-6
    this.useSquaredDistance = params.useSquaredDistance ?? false
    this.MAX_ITERATIONS = params.maxIterations ?? 100
  }

  override getConstructorParams(): IrlsSolverParams {
    return {
      targetPoints: this.targetPoints,
      initialPosition: this.initialPosition,
      constraintFn: this.constraintFn,
      epsilon: this.epsilon,
      useSquaredDistance: this.useSquaredDistance,
      maxIterations: this.MAX_ITERATIONS,
    }
  }

  override _setup() {
    this.currentPosition = { ...this.initialPosition }
    this.optimalPosition = undefined

    // If no target points, we're already solved at initial position
    if (this.targetPoints.length === 0) {
      this.optimalPosition = { ...this.currentPosition }
      this.solved = true
    }
  }

  override _step() {
    if (this.targetPoints.length === 0) return

    const { x: currentX, y: currentY } = this.currentPosition

    let weightedSumX = 0
    let weightedSumY = 0
    let totalWeight = 0

    // Calculate weights and weighted sum using Weiszfeld method
    for (const targetPoint of this.targetPoints) {
      const dx = currentX - targetPoint.x
      const dy = currentY - targetPoint.y
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

      weightedSumX += weight * targetPoint.x
      weightedSumY += weight * targetPoint.y
      totalWeight += weight
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
   * Calculate total distance from current position to all target points
   */
  getTotalDistance(position?: Point): number {
    const pos = position || this.currentPosition
    return this.targetPoints.reduce((sum, target) => {
      const dx = pos.x - target.x
      const dy = pos.y - target.y
      if (this.useSquaredDistance) {
        return sum + (dx * dx + dy * dy)
      } else {
        return sum + Math.sqrt(dx * dx + dy * dy)
      }
    }, 0)
  }

  computeProgress(): number {
    if (this.targetPoints.length === 0) return 1

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

    // Draw target points
    for (const point of this.targetPoints) {
      graphics.points!.push({
        ...point,
        color: "#4CAF50",
      })
    }

    // Draw current position
    graphics.points!.push({
      ...this.currentPosition,
      color: "#f44336",
    })

    // Draw lines from current position to target points
    for (const point of this.targetPoints) {
      graphics.lines!.push({
        points: [this.currentPosition, point],
        strokeColor: "#666",
      })
    }

    // Draw optimal position if found
    if (this.optimalPosition) {
      graphics.points!.push({
        ...this.optimalPosition,
        color: "rgba(76, 175, 80, 0.3)",
      })
    }

    return graphics
  }

  override getOutput() {
    return this.optimalPosition ?? this.currentPosition
  }
}
