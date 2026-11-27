// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/utils/getWeightedConnectionIndex.ts
import {
  createWeightedConnectionIndex,
  type WeightedConnectionIndex,
  type WeightedConnections,
} from "./createWeightedConnectionIndex.js"

const weightedConnectionIndexCache = new WeakMap<
  WeightedConnections,
  WeightedConnectionIndex
>()

/**
 * Reuses an index for repeated checks against the same weighted-connections
 * array. Pack inputs are treated as immutable while a layout is being solved.
 */
export function getWeightedConnectionIndex(
  weightedConnections: WeightedConnections,
): WeightedConnectionIndex {
  const cachedIndex = weightedConnectionIndexCache.get(weightedConnections)
  if (cachedIndex) return cachedIndex

  const index = createWeightedConnectionIndex(weightedConnections)
  weightedConnectionIndexCache.set(weightedConnections, index)
  return index
}
