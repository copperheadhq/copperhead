// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/PackSolver2/getComponentCollisionBoxes.ts
import type { PackedComponent } from "../types.js"
import { rotatePoint } from "../math/rotatePoint.js"

export interface CollisionBox {
  center: { x: number; y: number }
  width: number
  height: number
}

/**
 * Returns the collision boxes for a component. If the component has a
 * courtyard, returns a single courtyard-derived box (rotated + translated).
 * Otherwise, returns one box per pad (using absoluteCenter).
 */
export function getComponentCollisionBoxes(
  component: PackedComponent,
): CollisionBox[] {
  if (component.courtyard) {
    const courtyard = component.courtyard
    const angleRad = (component.ccwRotationOffset * Math.PI) / 180
    const rotatedOffset = rotatePoint(courtyard.offsetFromCenter, angleRad)

    // For 90/270 degree rotations, swap width and height
    const normalizedDeg = ((component.ccwRotationOffset % 360) + 360) % 360
    const swapDims = normalizedDeg === 90 || normalizedDeg === 270
    let width = courtyard.width
    let height = courtyard.height
    if (swapDims) {
      width = courtyard.height
      height = courtyard.width
    }

    return [
      {
        center: {
          x: component.center.x + rotatedOffset.x,
          y: component.center.y + rotatedOffset.y,
        },
        width,
        height,
      },
    ]
  }

  return component.pads.map((p) => ({
    center: { x: p.absoluteCenter.x, y: p.absoluteCenter.y },
    width: p.size.x,
    height: p.size.y,
  }))
}
