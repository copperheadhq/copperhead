// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/utils/createWeightedConnectionIndex.ts
import type { PackInput } from "../types.js"

export type WeightedConnections = NonNullable<PackInput["weightedConnections"]>

export interface WeightedConnectionIndex {
  explicitlyConnectedPadIdsByPadId: Map<string, Set<string>>
  padIdsRejectingWeakConnections: Set<string>
}

/**
 * Builds constant-time lookups for weighted-connection checks.
 */
export function createWeightedConnectionIndex(
  weightedConnections: WeightedConnections,
): WeightedConnectionIndex {
  const explicitlyConnectedPadIdsByPadId = new Map<string, Set<string>>()
  const padIdsRejectingWeakConnections = new Set<string>()

  for (const { padIds, ignoreWeakConnections } of weightedConnections) {
    for (const padId of padIds) {
      let explicitlyConnectedPadIds =
        explicitlyConnectedPadIdsByPadId.get(padId)
      if (!explicitlyConnectedPadIds) {
        explicitlyConnectedPadIds = new Set<string>()
        explicitlyConnectedPadIdsByPadId.set(padId, explicitlyConnectedPadIds)
      }

      for (const connectedPadId of padIds) {
        explicitlyConnectedPadIds.add(connectedPadId)
      }

      if (ignoreWeakConnections === true) {
        padIdsRejectingWeakConnections.add(padId)
      }
    }
  }

  return {
    explicitlyConnectedPadIdsByPadId,
    padIdsRejectingWeakConnections,
  }
}
