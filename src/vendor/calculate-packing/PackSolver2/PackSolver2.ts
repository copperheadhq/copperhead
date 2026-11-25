// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/PackSolver2/PackSolver2.ts
import type { GraphicsObject } from "../local/graphics-debug.js"
import { setPackedComponentPadCenters } from "./setPackedComponentPadCenters.js"
import { sortComponentQueue } from "./sortComponentQueue.js"
import { SingleComponentPackSolver } from "../SingleComponentPackSolver/SingleComponentPackSolver.js"
import { BaseSolver } from "../solver-utils/BaseSolver.js"
import type {
  InputComponent,
  OutputPad,
  PackedComponent,
  PackInput,
} from "../types.js"
import { getColorForString } from "../local/debug-graphics.js"
import { computeDistanceBetweenBoxes } from "../local/math-utils.js"
import { getComponentCollisionBoxes } from "./getComponentCollisionBoxes.js"
import { getComponentBounds } from "../geometry/getComponentBounds.js"
import { isPointInPolygon } from "../math/isPointInPolygon.js"
import { getPolygonCentroid } from "../math/getPolygonCentroid.js"
// copperhead patches P2, P5
import { isComponentInsideBoundaryOutline } from "../geometry/isComponentInsideBoundaryOutline.js"
import type { UnplacedComponent } from "../types.js"

export class PackSolver2 extends BaseSolver {
  declare activeSubSolver: SingleComponentPackSolver | null | undefined

  packInput: PackInput

  override getSolverName(): string {
    return "PackSolver2"
  }

  unpackedComponentQueue: InputComponent[] = []
  packedComponents: PackedComponent[] = []
  componentToPack?: InputComponent | null | undefined
  /** copperhead patch P5: components that could not be placed, and why */
  unplacedComponents: UnplacedComponent[] = []

  constructor(packInput: PackInput) {
    super()
    // PackSolver2 counts every nested candidate and optimizer step against its
    // own budget, so large boards can exceed BaseSolver's 100k default.
    this.MAX_ITERATIONS = 300_000
    this.packInput = packInput
  }

  override getConstructorParams() {
    return this.packInput
  }

  override _setup() {
    const { components, packOrderStrategy, packFirst = [] } = this.packInput

    this.unplacedComponents = []

    // Filter out components with no valid pads (e.g., pads with -Infinity sizes)
    const validComponents = components.filter((component) => {
      const valid =
        component.pads.length > 0 &&
        component.pads.every(
          (pad) =>
            Number.isFinite(pad.size.x) &&
            Number.isFinite(pad.size.y) &&
            pad.size.x > 0 &&
            pad.size.y > 0,
        )
      // copperhead patch P5: upstream dropped these silently (a dropped
      // static component is not an obstacle either)
      if (!valid) {
        this.unplacedComponents.push({
          componentId: component.componentId,
          rotationsTried: [],
          closestRejection: "none",
          message: `${component.componentId} was not packed: it has no pads, or a pad with a non-finite or non-positive size`,
        })
      }
      return valid
    })

    const staticComponents = validComponents.filter(
      (component) => component.isStatic,
    )
    const dynamicComponents = validComponents.filter(
      (component) => !component.isStatic,
    )

    this.packedComponents = staticComponents.map((component) => {
      const packedComponent: PackedComponent = {
        ...component,
        center: component.center ?? { x: 0, y: 0 },
        ccwRotationOffset:
          component.ccwRotationOffset ??
          component.availableRotationDegrees?.[0] ??
          0,
        pads: component.pads.map((pad) => ({
          ...pad,
          absoluteCenter: pad.absoluteCenter ?? { x: 0, y: 0 },
        })),
      }

      setPackedComponentPadCenters(packedComponent)

      return packedComponent
    })

    this.unpackedComponentQueue = sortComponentQueue({
      components: dynamicComponents,
      packOrderStrategy,
      packFirst,
    })
  }

  private packFirstComponent(): void {
    const firstComponentToPack = this.unpackedComponentQueue.shift()!

    // If boundary outline exists, use its geometric centroid as the starting position
    let initialPosition = { x: 0, y: 0 }
    if (
      this.packInput.boundaryOutline &&
      this.packInput.boundaryOutline.length >= 3
    ) {
      initialPosition = getPolygonCentroid(this.packInput.boundaryOutline)
    }

    const newPackedComponent: PackedComponent = {
      ...firstComponentToPack,
      center: initialPosition,
      ccwRotationOffset:
        firstComponentToPack.ccwRotationOffset ??
        firstComponentToPack.availableRotationDegrees?.[0] ??
        0,
      pads: firstComponentToPack.pads.map((p) => ({
        ...p,
        absoluteCenter: { x: 0, y: 0 },
      })),
    }

    setPackedComponentPadCenters(newPackedComponent)

    // If there are obstacles, ensure at least minGap clearance; otherwise fall back to outline-based placement
    const obstacles = this.packInput.obstacles ?? []
    const newComponentBoxes = getComponentCollisionBoxes(newPackedComponent)
    const tooCloseToObstacles = obstacles.some((obs) => {
      const obsBox = {
        center: { x: obs.absoluteCenter.x, y: obs.absoluteCenter.y },
        width: obs.width,
        height: obs.height,
      }
      return newComponentBoxes.some((box) => {
        const { distance } = computeDistanceBetweenBoxes(box, obsBox)
        return distance + 1e-6 < this.packInput.minGap
      })
    })

    // copperhead patch P2: exact containment in the boundary outline (upstream
    // tested pad centres and bounding-box corners only)
    let outsideBoundaryOutline = false
    if (
      this.packInput.boundaryOutline &&
      this.packInput.boundaryOutline.length >= 3
    ) {
      outsideBoundaryOutline = !isComponentInsideBoundaryOutline(
        newPackedComponent,
        this.packInput.boundaryOutline,
      )
    }

    // copperhead patch P2: upstream did not check the bounds here
    let outsideBounds = false
    if (this.packInput.bounds) {
      const componentBounds = getComponentBounds(newPackedComponent, 0)
      const bounds = this.packInput.bounds
      const eps = 1e-6
      outsideBounds =
        componentBounds.minX < bounds.minX - eps ||
        componentBounds.maxX > bounds.maxX + eps ||
        componentBounds.minY < bounds.minY - eps ||
        componentBounds.maxY > bounds.maxY + eps
    }

    if (!tooCloseToObstacles && !outsideBounds && !outsideBoundaryOutline) {
      this.packedComponents.push(newPackedComponent)
      return
    }

    // Attempt to place along obstacle outlines using the SingleComponentPackSolver
    const fallbackSolver = new SingleComponentPackSolver({
      packedComponents: [],
      componentToPack: firstComponentToPack,
      packPlacementStrategy: this.packInput.packPlacementStrategy,
      minGap: this.packInput.minGap,
      obstacles: obstacles,
      bounds: this.packInput.bounds,
      boundaryOutline: this.packInput.boundaryOutline,
      weightedConnections: this.packInput.weightedConnections,
      networkWeights: this.packInput.networkWeights, // copperhead patch P3
    })
    // copperhead patch P4: an exception inside the fallback marks this
    // component unplaced rather than aborting the solve (BaseSolver.step has
    // already recorded it on fallbackSolver.error)
    try {
      fallbackSolver.solve()
    } catch {}
    const result = fallbackSolver.failed ? undefined : fallbackSolver.getResult()
    if (result) {
      this.packedComponents.push(result)
    } else {
      // copperhead patch P4: upstream placed the component at the centre
      // "even if it violates constraints". It is recorded as unplaced instead,
      // and the remaining components are still packed.
      const detail = fallbackSolver.getFailureDetail()
      if (!detail.rotationsTried.includes(newPackedComponent.ccwRotationOffset)) {
        detail.rotationsTried.unshift(newPackedComponent.ccwRotationOffset)
      }
      if (detail.closestRejection === "none") {
        detail.closestRejection = tooCloseToObstacles
          ? "obstacle"
          : outsideBounds
            ? "bounds"
            : "boundary"
      }
      this.unplacedComponents.push(detail)
    }
  }

  override _step() {
    if (this.solved || this.failed) return

    // Special case: first component (when no components are packed yet)
    if (this.packedComponents.length === 0) {
      if (this.unpackedComponentQueue.length === 0) {
        this.solved = true
        return
      }
      this.packFirstComponent()
      return
    }

    // If we have an active sub-solver, continue with it
    if (!this.activeSubSolver) {
      // Need to start a new component
      if (this.unpackedComponentQueue.length === 0) {
        this.solved = true
        return
      }

      this.componentToPack = this.unpackedComponentQueue.shift()
      if (!this.componentToPack) {
        this.solved = true
        return
      }
      this.activeSubSolver = new SingleComponentPackSolver({
        packedComponents: this.packedComponents,
        componentToPack: this.componentToPack,
        packPlacementStrategy: this.packInput.packPlacementStrategy,
        minGap: this.packInput.minGap,
        obstacles: this.packInput.obstacles ?? [],
        bounds: this.packInput.bounds,
        boundaryOutline: this.packInput.boundaryOutline,
        weightedConnections: this.packInput.weightedConnections,
        networkWeights: this.packInput.networkWeights, // copperhead patch P3
      })
      this.activeSubSolver.setup()
    }

    // copperhead patch P4: an exception in one component's sub-solver marks
    // that component unplaced instead of aborting the solve (BaseSolver.step
    // has already recorded it on the sub-solver's error and set failed)
    try {
      this.activeSubSolver.step()
    } catch {}

    if (this.activeSubSolver.failed) {
      // copperhead patch P4/P5: upstream failed the whole solve here. The
      // component is recorded as unplaced with its failure detail, and
      // packing continues with the next one.
      this.unplacedComponents.push(this.activeSubSolver.getFailureDetail())
      this.componentToPack = undefined
      this.activeSubSolver = undefined
      return
    }

    if (this.activeSubSolver.solved) {
      // Get the result from the SingleComponentPackSolver
      const result = this.activeSubSolver.getResult()
      if (result) {
        this.packedComponents.push(result)
      } else {
        // copperhead patch P4: upstream placed the component at (0, 0) here
        this.unplacedComponents.push(this.activeSubSolver.getFailureDetail())
      }
      this.componentToPack = undefined
      this.activeSubSolver = undefined
    }
  }

  override visualize(): GraphicsObject {
    if (this.activeSubSolver) {
      return this.activeSubSolver.visualize()
    }

    // Create a visualization of the packed components
    const graphics: Required<GraphicsObject> = {
      coordinateSystem: "cartesian",
      title: "Pack Solver 2",
      points: [],
      lines: [],
      rects: [],
      circles: [],
      texts: [],
      arrows: [],
    }

    // Draw obstacles from PackInput (if any)
    if (this.packInput.obstacles && this.packInput.obstacles.length > 0) {
      for (const obstacle of this.packInput.obstacles) {
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

    if (this.packInput.bounds) {
      graphics.lines!.push({
        points: [
          { x: this.packInput.bounds.minX, y: this.packInput.bounds.minY },
          { x: this.packInput.bounds.minX, y: this.packInput.bounds.maxY },
          { x: this.packInput.bounds.maxX, y: this.packInput.bounds.maxY },
          { x: this.packInput.bounds.maxX, y: this.packInput.bounds.minY },
          { x: this.packInput.bounds.minX, y: this.packInput.bounds.minY },
        ],
        strokeColor: "rgba(0,0,0,0.5)",
        strokeDash: "2 2",
      })
    }

    if (
      this.packInput.boundaryOutline &&
      this.packInput.boundaryOutline.length
    ) {
      const points = [...this.packInput.boundaryOutline]
      if (
        points.length > 0 &&
        (points[0]!.x !== points[points.length - 1]!.x ||
          points[0]!.y !== points[points.length - 1]!.y)
      ) {
        points.push({ ...points[0]! })
      }

      graphics.lines!.push({
        points,
        strokeColor: "rgba(0, 0, 255, 0.5)",
        strokeDash: "4 2",
      })
    }

    if (this.packedComponents.length === 0) {
      // Show all the components in the queue at (0,0)
      for (const component of this.unpackedComponentQueue) {
        for (const pad of component.pads) {
          graphics.rects!.push({
            center: { x: 0, y: 0 },
            width: pad.size.x,
            height: pad.size.y,
            fill: "rgba(0,0,0,0.1)",
          })
        }
      }
    }

    const allPads = this.packedComponents.flatMap((c) => c.pads)
    const networkToPadMap = new Map<string, OutputPad[]>()
    for (const pad of allPads) {
      if (pad.networkId) {
        networkToPadMap.set(pad.networkId, [
          ...(networkToPadMap.get(pad.networkId) || []),
          pad,
        ])
      }
    }

    for (const pad of allPads) {
      graphics.rects!.push({
        center: pad.absoluteCenter,
        width: pad.size.x,
        height: pad.size.y,
        fill: "rgba(255,0,0,0.5)",
      })
    }

    for (const [networkId, pads] of networkToPadMap.entries()) {
      for (let i = 0; i < pads.length; i++) {
        for (let j = i + 1; j < pads.length; j++) {
          const pad1 = pads[i]!
          const pad2 = pads[j]!
          graphics.lines!.push({
            points: [pad1.absoluteCenter, pad2.absoluteCenter],
            strokeColor: getColorForString(networkId, 0.5),
          })
        }
      }
    }

    return graphics
  }

  override getOutput() {
    return {
      packedComponents: this.packedComponents,
      unpackedComponents: this.unpackedComponentQueue,
      unplacedComponents: this.getUnplacedComponents(), // copperhead patch P5
    }
  }

  /**
   * copperhead patch P5: every component that could not be placed. If the
   * solve stopped early (the iteration cap), the component in progress and
   * those still queued are included with reason "none".
   */
  getUnplacedComponents(): UnplacedComponent[] {
    const out = [...this.unplacedComponents]
    if (!this.failed) return out
    const active = this.activeSubSolver
    const pending = [
      ...(active ? [active.componentToPack] : []),
      ...this.unpackedComponentQueue,
    ]
    for (const component of pending) {
      out.push({
        componentId: component.componentId,
        rotationsTried:
          active && active.componentToPack === component
            ? [...active.rotationsTried]
            : [],
        closestRejection: "none",
        message: `${component.componentId} was not packed: ${this.error ?? "the solve stopped early"}`,
      })
    }
    return out
  }
}
