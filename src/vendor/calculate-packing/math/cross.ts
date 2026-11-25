// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/math/cross.ts
import type { Point } from "../local/math-utils.js"

/** 2-D cross product (O→A × O→B). */
export const cross = (O: Point, A: Point, B: Point): number =>
  (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x)
