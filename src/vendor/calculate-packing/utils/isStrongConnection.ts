// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/utils/isStrongConnection.ts
import type { PackInput } from "../types.js"
import { getWeightedConnectionIndex } from "./getWeightedConnectionIndex.js"

/**
 * Checks if two pads have a "strong" (weighted) connection.
 *
 * - If weightedConnections is not provided or empty, all connections are strong
 *   (backward compatible with existing behavior)
 * - Pad pairs explicitly listed together are always strong
 * - Pads that do not participate in weightedConnections keep the normal
 *   same-network fallback
 * - An unlisted pair is weak only when one of its participating pads belongs to
 *   a weighted connection with ignoreWeakConnections enabled
 *
 * @param pad1Id - First pad ID
 * @param pad2Id - Second pad ID
 * @param weightedConnections - Optional weighted connections from PackInput
 * @returns true if the connection is strong, false if weak
 */
export function isStrongConnection(
  pad1Id: string,
  pad2Id: string,
  weightedConnections?: PackInput["weightedConnections"],
): boolean {
  if (!weightedConnections?.length) {
    return true
  }

  const index = getWeightedConnectionIndex(weightedConnections)
  const pairIsExplicitlyWeighted = index.explicitlyConnectedPadIdsByPadId
    .get(pad1Id)
    ?.has(pad2Id)

  if (pairIsExplicitlyWeighted) {
    return true
  }

  const eitherPadRejectsWeakConnections =
    index.padIdsRejectingWeakConnections.has(pad1Id) ||
    index.padIdsRejectingWeakConnections.has(pad2Id)

  return !eitherPadRejectsWeakConnections
}
