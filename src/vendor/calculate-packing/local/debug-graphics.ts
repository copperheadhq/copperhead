// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/testing/createColorMapFromStrings.ts (getColorForString), plus a P1 stub for lib/testing/getGraphicsFromPackOutput.ts
import type { GraphicsObject } from "./graphics-debug.js"
import type { PackOutput } from "../types.js"

export const getColorForString = (string: string, alpha = 1) => {
  // pseudo random number from string
  const hash = string.split("").reduce((acc, char) => {
    return acc * 31 + char.charCodeAt(0)
  }, 0)
  return `hsl(${hash % 360}, 100%, 50%, ${alpha})`
}

/**
 * copperhead P1: lib/testing/ is not vendored. Visualisation is debug-only and
 * never used by copperhead, so this returns an empty graphics object.
 */
export const getGraphicsFromPackOutput = (
  _packOutput: PackOutput,
): GraphicsObject => ({
  coordinateSystem: "cartesian",
  points: [],
  lines: [],
  rects: [],
  circles: [],
  texts: [],
})
