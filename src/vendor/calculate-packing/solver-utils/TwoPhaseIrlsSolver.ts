// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/solver-utils/TwoPhaseIrlsSolver.ts
import type { GraphicsObject } from "../local/graphics-debug.js"
import { BaseSolver } from "./BaseSolver.js"
import { getNetworkWeight } from "../utils/getNetworkWeight.js"
import {
  MultiOffsetIrlsSolver,
  type MultiOffsetIrlsSolverParams,
} from "./MultiOffsetIrlsSolver.js"

export interface TwoPhaseIrlsSolverParams
  extends Omit<MultiOffsetIrlsSolverParams, "useSquaredDistance"> {
  /** Phase 1 convergence tolerance */
  phase1Epsilon?: number
  /** Phase 2 convergence tolerance */
  phase2Epsilon?: number
}

/**
 * Two-Phase IRLS Solver that implements the "minimum_closest_sum_squared_distance" strategy.
 *
 * Phase 1: Solves for minimum sum squared distance (like regular squared distance optimization)
 * Phase 2: From the Phase 1 solution, finds the closest point to any target and optimizes
 *          to minimize JUST the distance to that single closest point
 */
export class TwoPhaseIrlsSolver extends BaseSolver {
  public offsetPadPoints: MultiOffsetIrlsSolverParams["offsetPadPoints"]
  public targetPointMap: MultiOffsetIrlsSolverParams["targetPointMap"]
  public constraintFn?: MultiOffsetIrlsSolverParams["constraintFn"]
  public networkWeights?: MultiOffsetIrlsSolverParams["networkWeights"] // copperhead patch P3
  public currentPosition: { x: number; y: number }
  public optimalPosition?: { x: number; y: number }

  private readonly initialPosition: { x: number; y: number }
  private readonly phase1Epsilon: number
  private readonly phase2Epsilon: number
  private readonly maxIterations: number

  override getSolverName(): string {
    return "TwoPhaseIrlsSolver"
  }

  private phase1Solver?: MultiOffsetIrlsSolver
  private phase2Solver?: MultiOffsetIrlsSolver
  private currentPhase: 1 | 2 = 1
  private phase1Position?: { x: number; y: number }
  private closestTargetPadId?: string
  private closestTargetPoint?: { x: number; y: number }

  constructor(params: TwoPhaseIrlsSolverParams) {
    super()
    this.offsetPadPoints = [...params.offsetPadPoints]
    this.targetPointMap = new Map(params.targetPointMap)
    this.initialPosition = { ...params.initialPosition }
    this.currentPosition = { ...params.initialPosition }
    this.constraintFn = params.constraintFn
    this.networkWeights = params.networkWeights // copperhead patch P3
    this.phase1Epsilon = params.phase1Epsilon ?? params.epsilon ?? 1e-6
    this.phase2Epsilon = params.phase2Epsilon ?? params.epsilon ?? 1e-6
    this.maxIterations = params.maxIterations ?? 100
  }

  override getConstructorParams(): TwoPhaseIrlsSolverParams {
    return {
      offsetPadPoints: this.offsetPadPoints.map((pad) => ({ ...pad })),
      targetPointMap: new Map(this.targetPointMap),
      initialPosition: this.initialPosition,
      constraintFn: this.constraintFn,
      networkWeights: this.networkWeights, // copperhead patch P3
      phase1Epsilon: this.phase1Epsilon,
      phase2Epsilon: this.phase2Epsilon,
      maxIterations: this.maxIterations,
    }
  }

  override _setup() {
    this.currentPosition = { ...this.initialPosition }
    this.optimalPosition = undefined
    this.currentPhase = 1
    this.phase1Position = undefined
    this.closestTargetPadId = undefined
    this.closestTargetPoint = undefined

    // Check if we have any work to do
    const hasTargets = Array.from(this.targetPointMap.values()).some(
      (targets) => targets.length > 0,
    )
    if (!hasTargets || this.offsetPadPoints.length === 0) {
      this.optimalPosition = { ...this.currentPosition }
      this.solved = true
      return
    }

    // Set up Phase 1: minimize sum squared distance
    this.phase1Solver = new MultiOffsetIrlsSolver({
      offsetPadPoints: this.offsetPadPoints,
      targetPointMap: this.targetPointMap,
      initialPosition: this.initialPosition,
      constraintFn: this.constraintFn,
      epsilon: this.phase1Epsilon,
      maxIterations: this.maxIterations,
      useSquaredDistance: true, // Phase 1 uses squared distance
      networkWeights: this.networkWeights, // copperhead patch P3
    })
    this.phase1Solver.setup()
  }

  override _step() {
    if (this.currentPhase === 1) {
      this.stepPhase1()
    } else {
      this.stepPhase2()
    }
  }

  private stepPhase1() {
    if (!this.phase1Solver) return

    this.phase1Solver.step()
    this.currentPosition = this.phase1Solver.getBestPosition()

    if (this.phase1Solver.solved) {
      this.phase1Position = this.phase1Solver.getBestPosition()
      this.setupPhase2()
    } else if (this.phase1Solver.failed) {
      this.failed = true
      this.error = `Phase 1 failed: ${this.phase1Solver.error}`
    }
  }

  private setupPhase2() {
    if (!this.phase1Position) return

    // Find the closest target point from the Phase 1 solution
    let minDistance = Infinity
    let closestPadId: string | undefined
    let closestTarget: { x: number; y: number } | undefined

    for (const pad of this.offsetPadPoints) {
      const targetPoints = this.targetPointMap.get(pad.id) || []
      if (targetPoints.length === 0) continue

      // Current absolute position of this offset pad at phase1 solution
      const padX = this.phase1Position.x + pad.offsetX
      const padY = this.phase1Position.y + pad.offsetY

      for (const targetPoint of targetPoints) {
        const dx = padX - targetPoint.x
        const dy = padY - targetPoint.y
        // copperhead patch P3: "closest" by weighted squared distance, which
        // is the pad's term in the final cost; a network weighted 0 never wins
        const weight = getNetworkWeight(
          this.networkWeights,
          targetPoint.networkId,
        )
        if (weight <= 0) continue
        const distance = weight * (dx * dx + dy * dy)

        if (distance < minDistance) {
          minDistance = distance
          closestPadId = pad.id
          closestTarget = targetPoint
        }
      }
    }

    this.closestTargetPadId = closestPadId
    this.closestTargetPoint = closestTarget

    if (!closestPadId || !closestTarget) {
      // No targets found, use Phase 1 result
      this.optimalPosition = this.phase1Position
      this.solved = true
      return
    }

    // Set up Phase 2: minimize distance to ONLY the closest target
    // Create a new target map with only the closest target
    const phase2TargetMap = new Map<string, { x: number; y: number }[]>()
    phase2TargetMap.set(closestPadId, [closestTarget])

    this.phase2Solver = new MultiOffsetIrlsSolver({
      offsetPadPoints: this.offsetPadPoints,
      targetPointMap: phase2TargetMap,
      initialPosition: this.phase1Position,
      constraintFn: this.constraintFn,
      epsilon: this.phase2Epsilon,
      maxIterations: this.maxIterations,
      useSquaredDistance: false, // Phase 2 uses regular distance
    })
    this.phase2Solver.setup()
    this.currentPhase = 2
  }

  private stepPhase2() {
    if (!this.phase2Solver) return

    this.phase2Solver.step()
    this.currentPosition = this.phase2Solver.getBestPosition()

    if (this.phase2Solver.solved) {
      this.optimalPosition = this.phase2Solver.getBestPosition()
      this.solved = true
    } else if (this.phase2Solver.failed) {
      this.failed = true
      this.error = `Phase 2 failed: ${this.phase2Solver.error}`
    }
  }

  /**
   * Get the current best position
   */
  getBestPosition(): { x: number; y: number } {
    return this.optimalPosition || this.currentPosition
  }

  /**
   * Get the current absolute positions for all offset pad points
   */
  getOffsetPadPositions(): Map<string, { x: number; y: number }> {
    const currentPos = this.getBestPosition()
    const padPositions = new Map<string, { x: number; y: number }>()

    for (const pad of this.offsetPadPoints) {
      padPositions.set(pad.id, {
        x: currentPos.x + pad.offsetX,
        y: currentPos.y + pad.offsetY,
      })
    }

    return padPositions
  }

  /**
   * Calculate total distance from current position to all assigned target points
   */
  getTotalDistance(position?: { x: number; y: number }): number {
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
        // Use squared distance to match the strategy description
        totalDistance += dx * dx + dy * dy
      }
    }

    return totalDistance
  }

  override visualize(): GraphicsObject {
    const graphics: GraphicsObject = {
      lines: [],
      points: [],
      rects: [],
      circles: [],
    }

    // Show current phase info
    graphics.points!.push({
      ...this.currentPosition,
      color: this.currentPhase === 1 ? "#FF6B6B" : "#4ECDC4",
      label: `Phase ${this.currentPhase}`,
    })

    // Show phase 1 result if available
    if (this.phase1Position && this.currentPhase === 2) {
      graphics.points!.push({
        ...this.phase1Position,
        color: "rgba(255, 107, 107, 0.5)",
        label: "Phase 1 result",
      })
    }

    // Show closest target if in phase 2
    if (this.closestTargetPoint && this.closestTargetPadId) {
      graphics.points!.push({
        ...this.closestTargetPoint,
        color: "#FFA500",
        label: `Closest target (${this.closestTargetPadId})`,
      })

      // Draw line from closest pad to closest target
      const closestPad = this.offsetPadPoints.find(
        (p) => p.id === this.closestTargetPadId,
      )
      if (closestPad) {
        const currentPos = this.getBestPosition()
        const padPos = {
          x: currentPos.x + closestPad.offsetX,
          y: currentPos.y + closestPad.offsetY,
        }
        graphics.lines!.push({
          points: [padPos, this.closestTargetPoint],
          strokeColor: "#FFA500",
        })
      }
    }

    // Include active solver visualization
    const activeSolver =
      this.currentPhase === 1 ? this.phase1Solver : this.phase2Solver
    if (activeSolver) {
      const solverViz = activeSolver.visualize()

      // Merge solver graphics, but modify colors to indicate phase
      const phaseColor =
        this.currentPhase === 1
          ? "rgba(255, 107, 107, 0.7)"
          : "rgba(76, 205, 196, 0.7)"

      if (solverViz.lines) {
        const modifiedLines = solverViz.lines.map((line) => ({
          ...line,
          strokeColor: phaseColor,
        }))
        graphics.lines!.push(...modifiedLines)
      }
      if (solverViz.points) {
        graphics.points!.push(...solverViz.points)
      }
      if (solverViz.rects) {
        graphics.rects!.push(...solverViz.rects)
      }
      if (solverViz.circles) {
        graphics.circles!.push(...solverViz.circles)
      }
    }

    // Show optimal position if found
    if (this.optimalPosition) {
      graphics.points!.push({
        ...this.optimalPosition,
        color: "rgba(76, 175, 80, 0.8)",
        label: "Final optimal position",
      })
    }

    return graphics
  }

  override getOutput() {
    return this.optimalPosition ?? this.currentPosition
  }
}
