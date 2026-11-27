// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/utils/getStronglyConnectedPadIds.ts
import type { PackInput } from "../types.js"
import { getWeightedConnectionIndex } from "./getWeightedConnectionIndex.js"

/**
 * Gets all pad IDs that have strong connections to a given pad.
 *
 * @param padId - The pad ID to find strong connections for
 * @param weightedConnections - Optional weighted connections from PackInput
 * @returns Set of pad IDs that have strong connections to the given pad
 */
export function getStronglyConnectedPadIds(
  padId: string,
  weightedConnections?: PackInput["weightedConnections"],
): Set<string> {
  // No weightedConnections = return empty set (will use networkId fallback)
  if (!weightedConnections || weightedConnections.length === 0) {
    return new Set<string>()
  }

  const index = getWeightedConnectionIndex(weightedConnections)
  const connectedPadIds = new Set(
    index.explicitlyConnectedPadIdsByPadId.get(padId),
  )
  connectedPadIds.delete(padId)

  return connectedPadIds
}
