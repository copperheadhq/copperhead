// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/SingleComponentPackSolver/SingleComponentPackSolver.ts
import type { GraphicsObject, Line, Point, Rect } from "../local/graphics-debug.js"
import { constructOutlinesFromPackedComponents } from "../constructOutlinesFromPackedComponents.js"
import {
  OutlineSegmentCandidatePointSolver,
  type NetworkTargetPointMappings,
} from "../OutlineSegmentCandidatePointSolver/OutlineSegmentCandidatePointSolver.js"
import { setPackedComponentPadCenters } from "../PackSolver2/setPackedComponentPadCenters.js"
import { BaseSolver } from "../solver-utils/BaseSolver.js"
import { getGraphicsFromPackOutput } from "../local/debug-graphics.js"
import type { Segment } from "../geometry/types.js"
import type {
  InputComponent,
  PackedComponent,
  PackPlacementStrategy,
  InputObstacle,
  PackInput,
} from "../types.js"
import { isStrongConnection } from "../utils/isStrongConnection.js"
import { checkOverlapWithPackedComponents } from "../PackSolver2/checkOverlapWithPackedComponents.js"
import { getComponentCollisionBoxes } from "../PackSolver2/getComponentCollisionBoxes.js"
import { computeDistanceBetweenBoxes, type Bounds } from "../local/math-utils.js"
import { isPointInPolygon } from "../math/isPointInPolygon.js"
import { getComponentBounds } from "../geometry/getComponentBounds.js"
// copperhead patches P2, P3, P5
import { isComponentInsideBoundaryOutline } from "../geometry/isComponentInsideBoundaryOutline.js"
import { getInputComponentBounds } from "../geometry/getInputComponentBounds.js"
import { getNetworkWeight } from "../utils/getNetworkWeight.js"
import type { PlacementRejectionReason, UnplacedComponent } from "../types.js"

// copperhead patch P5: helpers for failure messages
const formatNumber = (n: number) => String(Number(n.toFixed(3)))
const boundsOfPoints = (points: Array<{ x: number; y: number }>): Bounds => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y)),
})

type Phase = "outline" | "segment_candidate" | "evaluate"

interface QueuedOutlineSegment {
  segment: Segment
  availableRotations: number[]
  segmentIndex: number
  ccwFullOutline: Segment[] // The entire outline containing this segment
}

interface CandidateResult {
  segment: Segment
  rotation: number
  optimalPosition?: Point
  distance: number
  segmentIndex: number
  rotationIndex: number
}

/**
 * Packs a single component given a set of already packed components.
 *
 * Runs subsolvers and operates in several phases:
 * Phase 1: Compute outline (visualization shows outline)
 * Phase 2: Compute candidate point for each segment by finding the optimal
 *          point on each segment of the outline for each rotation-segment pair.
 *          (visualization shows candidate point for active segment using the
 *           visualize method of the OutlineSegmentCandidatePointSolver)
 * Phase 3: Score the points. Show the points in visualization with a "step"
 *          where step=0 is the best point (lowest distance) and step=N is the
 *          worst point.
 */
export class SingleComponentPackSolver extends BaseSolver {
  componentToPack: InputComponent
  packedComponents: PackedComponent[]
  packPlacementStrategy: PackPlacementStrategy
  minGap: number
  obstacles: InputObstacle[]
  boundaryOutline?: Array<{ x: number; y: number }>
  weightedConnections?: PackInput["weightedConnections"]
  networkWeights?: PackInput["networkWeights"] // copperhead patch P3

  override getSolverName(): string {
    return "SingleComponentPackSolver"
  }

  // Phase management
  currentPhase: Phase = "outline"
  outlines: Segment[][] = []
  queuedOutlineSegments: QueuedOutlineSegment[] = []
  currentSegmentIndex = 0
  currentRotationIndex = 0
  override activeSubSolver?: OutlineSegmentCandidatePointSolver | null = null
  candidateResults: CandidateResult[] = []
  rejectedCandidates: Array<
    CandidateResult & {
      gapDistance: number
      rejectionReason: PlacementRejectionReason // copperhead patch P5
    }
  > = []
  // copperhead patch P5: segment/rotation pairs that produced no candidate
  // point (no room along the segment, or the optimiser did not converge)
  candidatePointFailures = 0
  // copperhead patch P5: rotations attempted, in order
  rotationsTried: number[] = []
  bestCandidate?: CandidateResult
  outputPackedComponent?: PackedComponent
  bounds?: Bounds
  private networkTargetPointMappingsCache = new Map<
    number,
    NetworkTargetPointMappings
  >()

  constructor(params: {
    componentToPack: InputComponent
    packedComponents: PackedComponent[]
    packPlacementStrategy: PackPlacementStrategy
    minGap?: number
    obstacles?: InputObstacle[]
    bounds?: Bounds
    boundaryOutline?: Array<{ x: number; y: number }>
    weightedConnections?: PackInput["weightedConnections"]
    networkWeights?: PackInput["networkWeights"] // copperhead patch P3
  }) {
    super()
    this.componentToPack = params.componentToPack
    this.packedComponents = params.packedComponents
    this.packPlacementStrategy = params.packPlacementStrategy
    this.minGap = params.minGap ?? 0
    this.obstacles = params.obstacles ?? []
    this.bounds = params.bounds
    this.boundaryOutline = params.boundaryOutline
    this.weightedConnections = params.weightedConnections
    this.networkWeights = params.networkWeights // copperhead patch P3
  }

  override _setup() {
    super._setup()
    this.currentPhase = "outline"
    this.outlines = []
    this.queuedOutlineSegments = []
    this.candidateResults = []
    this.activeSubSolver = undefined
    this.currentSegmentIndex = 0
    this.currentRotationIndex = 0
    this.networkTargetPointMappingsCache.clear()
  }

  override _step() {
    if (this.solved || this.failed) return

    switch (this.currentPhase) {
      case "outline":
        this.executeOutlinePhase()
        break
      case "segment_candidate":
        this.executeSegmentCandidatePhase()
        break
      case "evaluate":
        this.executeEvaluatePhase()
        break
    }
  }

  private executeOutlinePhase() {
    // Special case: if no packed components, attempt center; if too close to obstacles, fall back to outline-based placement
    if (this.packedComponents.length === 0) {
      const availableRotations = this.componentToPack
        .availableRotationDegrees ?? [0, 90, 180, 270]
      const position = { x: 0, y: 0 }
      const rotation = availableRotations[0] ?? 0

      // Build candidate at center and verify obstacle clearance
      const candidate = this.createPackedComponent(position, rotation)
      this.noteRotationTried(rotation) // copperhead patch P5
      const candidateBoxes = getComponentCollisionBoxes(candidate)
      const tooCloseToObstacles = (this.obstacles ?? []).some((obs) => {
        const obsBox = {
          center: { x: obs.absoluteCenter.x, y: obs.absoluteCenter.y },
          width: obs.width,
          height: obs.height,
        }
        return candidateBoxes.some((box) => {
          const { distance } = computeDistanceBetweenBoxes(box, obsBox)
          return distance + 1e-6 < this.minGap
        })
      })

      // copperhead patch P2/P4: upstream accepted (0, 0) after checking only
      // obstacles, so a part could land outside the bounds or the boundary
      // outline. Both are checked; otherwise fall through to outline-based
      // placement.
      if (
        !tooCloseToObstacles &&
        !this.isOutsideBounds(candidate) &&
        !this.isOutsideBoundaryOutline(candidate)
      ) {
        this.outputPackedComponent = candidate
        this.solved = true
        return
      }
      // Otherwise, fall through to outline construction using obstacles
    }

    // Construct outlines from packed components (and obstacles)
    this.outlines = constructOutlinesFromPackedComponents(
      this.packedComponents,
      {
        minGap: this.minGap,
        obstacles: this.obstacles,
      },
    )

    // Queue all segment-rotation pairs
    const availableRotations = this.componentToPack
      .availableRotationDegrees ?? [0, 90, 180, 270]

    for (
      let segmentIndex = 0;
      segmentIndex < this.outlines.length;
      segmentIndex++
    ) {
      const outline = this.outlines[segmentIndex]!
      for (let i = 0; i < outline.length; i++) {
        const segment = outline[i]!
        this.queuedOutlineSegments.push({
          segment,
          availableRotations: [...availableRotations],
          segmentIndex: segmentIndex * 1000 + i, // Unique index across all outlines
          ccwFullOutline: outline, // Pass the entire outline containing this segment
        })
      }
    }

    // Also add boundary outline segments if available
    // This allows components to be placed in empty areas along the board edges
    // where no packed components exist to create outline segments
    if (this.boundaryOutline && this.boundaryOutline.length >= 3) {
      const boundarySegments: Segment[] = []
      for (let i = 0; i < this.boundaryOutline.length; i++) {
        const p1 = this.boundaryOutline[i]!
        const p2 = this.boundaryOutline[(i + 1) % this.boundaryOutline.length]!
        boundarySegments.push([p1, p2])
      }

      // Add boundary segments with a unique segment index offset
      const boundaryOutlineIndex = this.outlines.length
      for (let i = 0; i < boundarySegments.length; i++) {
        const segment = boundarySegments[i]!
        this.queuedOutlineSegments.push({
          segment,
          availableRotations: [...availableRotations],
          segmentIndex: boundaryOutlineIndex * 1000 + i,
          ccwFullOutline: boundarySegments,
        })
      }
    }

    // Add obstacle boundary segments for isolated obstacles
    // This allows components to be placed adjacent to obstacles that aren't
    // connected to the main packed component cluster
    let obstacleOutlineIndex = this.outlines.length + 1
    for (const obstacle of this.obstacles) {
      const hw = obstacle.width / 2 + this.minGap
      const hh = obstacle.height / 2 + this.minGap
      const cx = obstacle.absoluteCenter.x
      const cy = obstacle.absoluteCenter.y

      // Create a CCW outline around the obstacle (including minGap)
      const obstacleCorners = [
        { x: cx - hw, y: cy - hh },
        { x: cx + hw, y: cy - hh },
        { x: cx + hw, y: cy + hh },
        { x: cx - hw, y: cy + hh },
      ]

      const obstacleSegments: Segment[] = [
        [obstacleCorners[0]!, obstacleCorners[1]!], // bottom
        [obstacleCorners[1]!, obstacleCorners[2]!], // right
        [obstacleCorners[2]!, obstacleCorners[3]!], // top
        [obstacleCorners[3]!, obstacleCorners[0]!], // left
      ]

      for (let i = 0; i < obstacleSegments.length; i++) {
        const segment = obstacleSegments[i]!
        this.queuedOutlineSegments.push({
          segment,
          availableRotations: [...availableRotations],
          segmentIndex: obstacleOutlineIndex * 1000 + i,
          ccwFullOutline: obstacleSegments,
        })
      }
      obstacleOutlineIndex++
    }

    // Move to next phase
    this.currentPhase = "segment_candidate"
    this.currentSegmentIndex = 0
    this.currentRotationIndex = 0
  }

  private executeSegmentCandidatePhase() {
    if (this.activeSubSolver?.solved || this.activeSubSolver?.failed) {
      const queuedSegment =
        this.queuedOutlineSegments[this.currentSegmentIndex]!
      const rotation =
        queuedSegment.availableRotations[this.currentRotationIndex]!

      let distance = Infinity
      let optimalPosition: Point | undefined

      if (this.activeSubSolver.solved && this.activeSubSolver.optimalPosition) {
        optimalPosition = this.activeSubSolver.optimalPosition

        // Check if this candidate overlaps with any packed components
        const candidateComponent = this.createPackedComponent(
          optimalPosition,
          rotation,
        )
        const { hasOverlap, gapDistance } = checkOverlapWithPackedComponents({
          component: candidateComponent,
          packedComponents: this.packedComponents,
          minGap: this.minGap,
        })

        // Also ensure we keep minGap from any obstacles
        let minObstacleGapDistance = Infinity
        const candidateCollisionBoxes =
          getComponentCollisionBoxes(candidateComponent)
        const tooCloseToObstacles = (this.obstacles ?? []).some((obs) => {
          const obsBox = {
            center: { x: obs.absoluteCenter.x, y: obs.absoluteCenter.y },
            width: obs.width,
            height: obs.height,
          }
          return candidateCollisionBoxes.some((box) => {
            const { distance } = computeDistanceBetweenBoxes(box, obsBox)
            minObstacleGapDistance = Math.min(minObstacleGapDistance, distance)
            return distance + 1e-6 < this.minGap
          })
        })

        // Check if component is outside bounds
        // (copperhead patch P2: now with a 1e-6 tolerance, see isOutsideBounds)
        const outsideBounds = this.isOutsideBounds(candidateComponent)

        // copperhead patch P2: exact containment. Every collision box and pad
        // box must lie inside the boundary outline: corners inside, and no
        // outline segment crossing the box. Upstream tested only pad centres
        // and the bounding-box corners, which lets a box straddle a notch.
        const outsideBoundaryOutline =
          this.isOutsideBoundaryOutline(candidateComponent)

        // Calculate distance based on pack strategy
        distance = this.calculateDistance(optimalPosition, rotation)

        if (hasOverlap) {
          this.rejectedCandidates.push({
            segment: queuedSegment.segment,
            rotation,
            optimalPosition,
            distance,
            segmentIndex: queuedSegment.segmentIndex,
            rotationIndex: this.currentRotationIndex,
            gapDistance: gapDistance!,
            rejectionReason: "overlap", // copperhead patch P5
          })
        } else if (tooCloseToObstacles) {
          this.rejectedCandidates.push({
            segment: queuedSegment.segment,
            rotation,
            optimalPosition,
            distance,
            segmentIndex: queuedSegment.segmentIndex,
            rotationIndex: this.currentRotationIndex,
            gapDistance: minObstacleGapDistance,
            rejectionReason: "obstacle", // copperhead patch P5
          })
        } else if (outsideBounds) {
          this.rejectedCandidates.push({
            segment: queuedSegment.segment,
            rotation,
            optimalPosition,
            distance,
            segmentIndex: queuedSegment.segmentIndex,
            rotationIndex: this.currentRotationIndex,
            gapDistance: -1, // Special marker for bounds violation
            rejectionReason: "bounds", // copperhead patch P5
          })
        } else if (outsideBoundaryOutline) {
          this.rejectedCandidates.push({
            segment: queuedSegment.segment,
            rotation,
            optimalPosition,
            distance,
            segmentIndex: queuedSegment.segmentIndex,
            rotationIndex: this.currentRotationIndex,
            gapDistance: -1, // Special marker for boundary violation
            rejectionReason: "boundary", // copperhead patch P5
          })
        } else {
          // Store candidate result
          this.candidateResults.push({
            segment: queuedSegment.segment,
            rotation,
            optimalPosition,
            distance,
            segmentIndex: queuedSegment.segmentIndex,
            rotationIndex: this.currentRotationIndex,
          })
        }
      } else {
        // copperhead patch P5: this segment/rotation pair produced no candidate
        this.candidatePointFailures++
      }

      // Move to next rotation
      this.currentRotationIndex++
      this.activeSubSolver = undefined
    }

    // Check if we need to start a new segment-rotation pair
    while (!this.activeSubSolver) {
      if (this.currentSegmentIndex >= this.queuedOutlineSegments.length) {
        // All segments processed, move to evaluation phase
        this.currentPhase = "evaluate"
        return
      }

      const queuedSegment =
        this.queuedOutlineSegments[this.currentSegmentIndex]!
      if (
        this.currentRotationIndex >= queuedSegment.availableRotations.length
      ) {
        // All rotations for this segment processed, move to next segment
        this.currentSegmentIndex++
        this.currentRotationIndex = 0
        continue
      }

      const rotation =
        queuedSegment.availableRotations[this.currentRotationIndex]!
      this.noteRotationTried(rotation) // copperhead patch P5

      // Create new OutlineSegmentCandidatePointSolver
      this.activeSubSolver = new OutlineSegmentCandidatePointSolver({
        outlineSegment: queuedSegment.segment,
        ccwFullOutline: queuedSegment.ccwFullOutline,
        componentRotationDegrees: rotation,
        packStrategy: this.packPlacementStrategy,
        minGap: this.minGap,
        packedComponents: this.packedComponents,
        componentToPack: this.componentToPack,
        obstacles: this.obstacles,
        globalBounds: this.bounds,
        boundaryOutline: this.boundaryOutline,
        weightedConnections: this.weightedConnections,
        networkWeights: this.networkWeights, // copperhead patch P3
        networkTargetPointMappingsCache: this.networkTargetPointMappingsCache,
      })

      this.activeSubSolver.setup()
      break
    }

    // Step the active subsolver
    this.activeSubSolver.step()
  }

  private executeEvaluatePhase() {
    // Find the best candidate (lowest distance)
    if (this.candidateResults.length === 0) {
      this.failed = true
      this.error = "No valid candidates found"
      return
    }

    // Sort candidates by distance (ascending)
    this.candidateResults.sort((a, b) => a.distance - b.distance)
    this.bestCandidate = this.candidateResults[0]!

    // Create the output packed component
    if (this.bestCandidate.optimalPosition) {
      this.outputPackedComponent = this.createPackedComponent(
        this.bestCandidate.optimalPosition,
        this.bestCandidate.rotation,
      )
    }

    this.solved = true
  }

  private calculateDistance(position: Point, rotation: number): number {
    // Create temporary packed component to calculate network distances
    const tempComponent = this.createPackedComponent(position, rotation)

    let totalDistance = 0
    const useSquaredDistance =
      this.packPlacementStrategy ===
        "minimum_sum_squared_distance_to_network" ||
      this.packPlacementStrategy === "minimum_closest_sum_squared_distance"

    // Calculate sum of distances to all pads on same networks
    for (const pad of tempComponent.pads) {
      let minDistanceToNetwork = Infinity

      for (const packedComponent of this.packedComponents) {
        for (const packedPad of packedComponent.pads) {
          if (packedPad.networkId === pad.networkId) {
            // Check if this is a strong connection (should be considered)
            // or a weak connection (should be ignored when weightedConnections is provided)
            if (
              !isStrongConnection(
                pad.padId,
                packedPad.padId,
                this.weightedConnections,
              )
            ) {
              continue // Skip weak connections
            }

            const dx = pad.absoluteCenter.x - packedPad.absoluteCenter.x
            const dy = pad.absoluteCenter.y - packedPad.absoluteCenter.y
            const dist = Math.sqrt(dx * dx + dy * dy)
            minDistanceToNetwork = Math.min(minDistanceToNetwork, dist)
          }
        }
      }

      if (minDistanceToNetwork < Infinity) {
        // copperhead patch P3: the pad's term is scaled by its network weight
        totalDistance +=
          getNetworkWeight(this.networkWeights, pad.networkId) *
          (useSquaredDistance
            ? minDistanceToNetwork * minDistanceToNetwork
            : minDistanceToNetwork)
      }
    }

    return totalDistance
  }

  private createPackedComponent(
    position: Point,
    rotation: number,
  ): PackedComponent {
    const component: PackedComponent = {
      ...this.componentToPack,
      center: position,
      ccwRotationOffset: rotation,
      pads: this.componentToPack.pads.map((pad) => ({
        ...pad,
        absoluteCenter: { x: 0, y: 0 }, // Will be set by setPackedComponentPadCenters
      })),
    }

    setPackedComponentPadCenters(component)
    return component
  }

  override visualize(): GraphicsObject {
    if (this.activeSubSolver) {
      return this.activeSubSolver.visualize()
    }
    const graphics: GraphicsObject = getGraphicsFromPackOutput({
      components: this.packedComponents,
      minGap: this.minGap,
      packOrderStrategy: "largest_to_smallest",
      packPlacementStrategy: this.packPlacementStrategy,
    })

    graphics.points ??= []
    graphics.lines ??= []
    graphics.rects ??= []
    graphics.texts ??= []
    graphics.circles ??= []

    // Draw obstacles from PackInput (if any)
    if (this.obstacles && this.obstacles.length > 0) {
      for (const obstacle of this.obstacles) {
        graphics.rects!.push({
          center: obstacle.absoluteCenter,
          width: obstacle.width,
          height: obstacle.height,
          fill: "rgba(0,0,0,0.1)",
          stroke: "#555",
          label: obstacle.obstacleId,
        } as Rect)
      }
    }

    if (this.bounds) {
      graphics.lines!.push({
        points: [
          { x: this.bounds.minX, y: this.bounds.minY },
          { x: this.bounds.minX, y: this.bounds.maxY },
          { x: this.bounds.maxX, y: this.bounds.maxY },
          { x: this.bounds.maxX, y: this.bounds.minY },
          { x: this.bounds.minX, y: this.bounds.minY },
        ],
        strokeColor: "rgba(0,0,0,0.5)",
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

    switch (this.currentPhase) {
      case "outline":
        this.visualizeOutlinePhase(graphics)
        break
      case "segment_candidate":
        this.visualizeSegmentCandidatePhase(graphics)
        break
      case "evaluate":
        this.visualizeEvaluatePhase(graphics)
        break
    }

    return graphics
  }

  private visualizeOutlinePhase(graphics: GraphicsObject) {
    // Show outlines with lines
    for (const outline of this.outlines) {
      for (const segment of outline) {
        const [p1, p2] = segment
        graphics.lines!.push({
          points: [p1, p2],
          strokeColor: "#ff4444",
        } as Line)
      }
    }
    for (let i = 0; i < this.outlines.length; i++) {
      const outline = this.outlines[i]!
      for (let u = 0; u < outline.length; u++) {
        const [p1, p2] = outline[u]!
        graphics.points!.push({
          x: p1.x,
          y: p1.y,
          label: `outlines [${i}] [${u}]`,
          color: "#ff4444",
        } as Point)
      }
    }
  }

  private visualizeSegmentCandidatePhase(graphics: GraphicsObject) {
    // Show all outlines
    this.visualizeOutlinePhase(graphics)

    // Show active subsolver visualization if present
    if (this.activeSubSolver) {
      const subSolverViz = this.activeSubSolver.visualize()

      // Merge subsolver graphics
      if (subSolverViz.lines) graphics.lines!.push(...subSolverViz.lines)
      if (subSolverViz.points) graphics.points!.push(...subSolverViz.points)
      if (subSolverViz.rects) graphics.rects!.push(...subSolverViz.rects)
      if (subSolverViz.circles)
        graphics.circles!.push(...(subSolverViz.circles ?? []))
    } else {
      // Show all candidate results with their pads when no active sub solver
      for (let i = 0; i < this.candidateResults.length; i++) {
        const candidate = this.candidateResults[i]!

        if (candidate.optimalPosition) {
          // Create a temporary packed component at this candidate position
          const tempComponent = this.createPackedComponent(
            candidate.optimalPosition,
            candidate.rotation,
          )

          // Draw all pads for this candidate
          for (const pad of tempComponent.pads) {
            graphics.rects!.push({
              center: pad.absoluteCenter,
              width: pad.size.x,
              height: pad.size.y,
              fill: `rgba(255,165,0,0.3)`,
              stroke: `rgba(255,165,0,0.8)`,
              strokeWidth: 1,
            } as Rect)
          }

          // Draw the candidate point
          graphics.points!.push({
            x: candidate.optimalPosition.x,
            y: candidate.optimalPosition.y,
            label: `c${i}, d=${candidate.distance.toFixed(3)}`,
            color: "rgba(255,165,0,0.8)",
          } as Point)
        }
      }
    }
  }

  private visualizeEvaluatePhase(graphics: GraphicsObject) {
    // Show all outlines
    this.visualizeOutlinePhase(graphics)

    // Show all candidate points with step values (step=0 is best)
    for (let i = 0; i < this.candidateResults.length; i++) {
      const candidate = this.candidateResults[i]!
      if (!candidate.optimalPosition) continue
      const step = i // Since we sorted by distance, index is the step
      const isBest = step === 0

      graphics.points!.push({
        x: candidate.optimalPosition.x,
        y: candidate.optimalPosition.y,
        label: `step=${step}, d=${candidate.distance.toFixed(3)}`,
        color: isBest ? "rgba(0,255,0,0.8)" : "rgba(255,165,0,0.6)",
      } as Point)
    }

    for (let i = 0; i < this.rejectedCandidates.length; i++) {
      const candidate = this.rejectedCandidates[i]!
      if (!candidate.optimalPosition) continue
      graphics.points!.push({
        x: candidate.optimalPosition.x,
        y: candidate.optimalPosition.y,
        label: `rejected, d=${candidate.distance.toFixed(3)}\ngap_distance=${candidate.gapDistance}`,
        color: "rgba(255,0,0,0.8)",
      } as Point)
    }

    // Show the final placed component if available
    if (this.outputPackedComponent) {
      for (const pad of this.outputPackedComponent.pads) {
        graphics.rects!.push({
          center: pad.absoluteCenter,
          width: pad.size.x,
          height: pad.size.y,
          fill: "rgba(0,255,0,0.7)",
        } as Rect)
      }
    }
  }

  // copperhead patch P5: record each rotation attempted, in order
  private noteRotationTried(rotation: number) {
    if (!this.rotationsTried.includes(rotation)) {
      this.rotationsTried.push(rotation)
    }
  }

  // copperhead patch P2: the bounds check, with the 1e-6 tolerance the gap
  // checks use, so rounding does not reject a part flush with the bounds
  private isOutsideBounds(component: PackedComponent): boolean {
    if (!this.bounds) return false
    const componentBounds = getComponentBounds(component, 0)
    const eps = 1e-6
    return (
      componentBounds.minX < this.bounds.minX - eps ||
      componentBounds.maxX > this.bounds.maxX + eps ||
      componentBounds.minY < this.bounds.minY - eps ||
      componentBounds.maxY > this.bounds.maxY + eps
    )
  }

  // copperhead patch P2: exact containment in the boundary outline
  private isOutsideBoundaryOutline(component: PackedComponent): boolean {
    if (!this.boundaryOutline || this.boundaryOutline.length < 3) return false
    return !isComponentInsideBoundaryOutline(component, this.boundaryOutline)
  }

  /**
   * copperhead patch P5: why this component could not be placed.
   *
   * - `closestRejection` is the check that rejected the lowest-cost candidate
   *   position, which is the one the packer would otherwise have chosen.
   * - When the component's rotated extent exceeds the bounds (or the boundary
   *   outline's bounding box) in every rotation tried, it is "bounds" (or
   *   "boundary") instead.
   * - It is "none" when no candidate position was generated.
   */
  getFailureDetail(): UnplacedComponent {
    const componentId = this.componentToPack.componentId
    const rotationsTried = [...this.rotationsTried]
    const counts = { overlap: 0, obstacle: 0, bounds: 0, boundary: 0 }
    let closest: (typeof this.rejectedCandidates)[number] | undefined
    for (const rejected of this.rejectedCandidates) {
      counts[rejected.rejectionReason]++
      if (!closest || rejected.distance < closest.distance) closest = rejected
    }

    let closestRejection: PlacementRejectionReason =
      closest?.rejectionReason ?? "none"
    const notes: string[] = []

    const hasBoundary = !!this.boundaryOutline && this.boundaryOutline.length >= 3
    const frame = this.bounds ?? (hasBoundary ? boundsOfPoints(this.boundaryOutline!) : undefined)
    if (frame && rotationsTried.length > 0) {
      const frameWidth = frame.maxX - frame.minX
      const frameHeight = frame.maxY - frame.minY
      const extents = rotationsTried.map((rotationDegrees) => {
        const b = getInputComponentBounds(this.componentToPack, { rotationDegrees })
        return { rotationDegrees, width: b.maxX - b.minX, height: b.maxY - b.minY }
      })
      if (
        extents.every(
          (e) => e.width > frameWidth + 1e-6 || e.height > frameHeight + 1e-6,
        )
      ) {
        closestRejection = this.bounds ? "bounds" : "boundary"
        notes.push(
          `it is larger than the ${this.bounds ? "bounds" : "boundary outline"} (${formatNumber(frameWidth)} x ${formatNumber(frameHeight)}) in every rotation tried (${extents
            .map((e) => `${e.rotationDegrees} deg: ${formatNumber(e.width)} x ${formatNumber(e.height)}`)
            .join(", ")})`,
        )
      }
    }

    const total = this.rejectedCandidates.length
    if (total > 0 && closest) {
      notes.push(
        `${total} candidate position${total === 1 ? "" : "s"} rejected (overlap ${counts.overlap}, obstacle ${counts.obstacle}, bounds ${counts.bounds}, boundary ${counts.boundary}); the lowest-cost one, at (${formatNumber(closest.optimalPosition!.x)}, ${formatNumber(closest.optimalPosition!.y)}) rotation ${closest.rotation}, failed the ${closest.rejectionReason} check`,
      )
    } else {
      notes.push("no candidate position was generated")
    }
    if (this.candidatePointFailures > 0) {
      notes.push(
        `${this.candidatePointFailures} outline segment/rotation pair${this.candidatePointFailures === 1 ? "" : "s"} had no room or did not converge`,
      )
    }
    if (this.error && this.error !== "No valid candidates found") {
      notes.push(`solver error: ${this.error}`)
    }

    return {
      componentId,
      rotationsTried,
      closestRejection,
      message: `${componentId} could not be placed: ${notes.join("; ")}`,
    }
  }

  getResult(): PackedComponent | undefined {
    return this.outputPackedComponent
  }

  override getOutput() {
    return this.getResult()
  }

  override getConstructorParams() {
    return {
      componentToPack: this.componentToPack,
      packedComponents: this.packedComponents,
      packPlacementStrategy: this.packPlacementStrategy,
      minGap: this.minGap,
      obstacles: this.obstacles,
      bounds: this.bounds,
      boundaryOutline: this.boundaryOutline,
      weightedConnections: this.weightedConnections,
      networkWeights: this.networkWeights, // copperhead patch P3
    }
  }
}
