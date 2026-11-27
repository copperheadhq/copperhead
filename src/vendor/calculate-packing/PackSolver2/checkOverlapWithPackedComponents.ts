// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/PackSolver2/checkOverlapWithPackedComponents.ts
import type { PackedComponent } from "../types.js"
import { computeDistanceBetweenBoxes } from "../local/math-utils.js"
import { getComponentCollisionBoxes } from "./getComponentCollisionBoxes.js"

export interface CheckOverlapWithPackedComponentsParams {
  component: PackedComponent
  packedComponents: PackedComponent[]
  minGap: number
}

export function checkOverlapWithPackedComponents({
  component,
  packedComponents,
  minGap,
}: CheckOverlapWithPackedComponentsParams): {
  hasOverlap: boolean
  gapDistance?: number
} {
  const allPackedBoxes = packedComponents.flatMap((c) =>
    getComponentCollisionBoxes(c),
  )
  const newComponentBoxes = getComponentCollisionBoxes(component)

  for (const newBox of newComponentBoxes) {
    for (const packedBox of allPackedBoxes) {
      const { distance: boxDist } = computeDistanceBetweenBoxes(
        newBox,
        packedBox,
      )
      if (boxDist + 1e-6 < minGap) {
        return {
          hasOverlap: true,
          gapDistance: boxDist,
        }
      }
    }
  }

  return {
    hasOverlap: false,
  }
}
