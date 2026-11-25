// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/pack.ts
import { PackSolver2 } from "./PackSolver2/PackSolver2.js"
import type { PackInput, PackOutput } from "./types.js"

const DEFAULT_PACK_DIRECTION_FALLBACK = "right"

/**
 * The pack algorithm performs the following steps:
 * 1. Sort the components using the packOrderStrategy
 * 2. Select the next component to pack
 * 3. If the first component, pack at center (0,0) and go to step 2
 * 4. Compute the outline of all packed components with a gap of minGap + max(pad.width, pad.height)/2
 * 5. Find the point along the outline that minimizes the distance of the pad
 *    centers within a networkId. If no shared pads, pack to the defaultPackDirection
 * 6. Add the component at the selected point, with it's pad at the position
 *    minimizing the distance between the pad centers
 * 7. To determine the component rotation, find the minimum distance between pad
 *    centers for the remaining pads at each possible rotation (making sure that
 *    we never pack such that two pads overlap)
 * 8. Go to step 2 until all components are packed
 */
export const pack = (input: PackInput): PackOutput => {
  const solver = new PackSolver2(input)
  solver.solve()
  return {
    ...input,
    components: solver.packedComponents,
    unplacedComponents: solver.getUnplacedComponents(), // copperhead patch P5
  }
}
