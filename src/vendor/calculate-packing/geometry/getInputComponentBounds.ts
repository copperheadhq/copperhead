// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/geometry/getInputComponentBounds.ts
import type { InputComponent } from "../types.js"
import type { Bounds } from "../local/math-utils.js"
import { expandRotatedRectIntoBounds } from "./expandRotatedRectIntoBounds.js"

export const getInputComponentBounds = (
  component: InputComponent,
  { rotationDegrees = 0 },
): Bounds => {
  const bounds: Bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  }

  const angleRad = (rotationDegrees * Math.PI) / 180

  for (const pad of component.pads) {
    expandRotatedRectIntoBounds({
      bounds,
      center: pad.offset,
      width: pad.size.x,
      height: pad.size.y,
      angleRad,
    })
  }

  if (component.courtyard) {
    expandRotatedRectIntoBounds({
      bounds,
      center: component.courtyard.offsetFromCenter,
      width: component.courtyard.width,
      height: component.courtyard.height,
      angleRad,
    })
  }

  return bounds
}
