// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/geometry/getComponentBounds.ts
import type { Bounds } from "../local/math-utils.js"
import type { PackedComponent } from "../types.js"
import { rotatePoint } from "../math/rotatePoint.js"
import { expandRotatedRectIntoBounds } from "./expandRotatedRectIntoBounds.js"

/** Axis-aligned bounds of a component, expanded by `minGap`. */
export const getComponentBounds = (
  component: PackedComponent,
  minGap = 0,
): Bounds => {
  const bounds: Bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  }

  const angleRad = (component.ccwRotationOffset * Math.PI) / 180

  for (const pad of component.pads) {
    // Position the pad by rotating its local offset (kept fresh from the
    // component's current center), but treat its box as axis-aligned: pad.size
    // is already the final rotated size (setPackedComponentPadCenters swaps w/h
    // for 90/270), so rotating the rect again would apply the rotation twice.
    const rotatedOffset = rotatePoint(pad.offset, angleRad)
    const cx = component.center.x + rotatedOffset.x
    const cy = component.center.y + rotatedOffset.y
    const hw = pad.size.x / 2
    const hh = pad.size.y / 2
    bounds.minX = Math.min(bounds.minX, cx - hw)
    bounds.maxX = Math.max(bounds.maxX, cx + hw)
    bounds.minY = Math.min(bounds.minY, cy - hh)
    bounds.maxY = Math.max(bounds.maxY, cy + hh)
  }

  if (component.courtyard) {
    expandRotatedRectIntoBounds({
      bounds,
      center: component.courtyard.offsetFromCenter,
      width: component.courtyard.width,
      height: component.courtyard.height,
      angleRad,
      translate: component.center,
    })
  }

  return {
    minX: bounds.minX - minGap,
    maxX: bounds.maxX + minGap,
    minY: bounds.minY - minGap,
    maxY: bounds.maxY + minGap,
  }
}
