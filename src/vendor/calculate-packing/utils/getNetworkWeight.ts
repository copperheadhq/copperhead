// copperhead patch P3 (not upstream): the weight of a network in the packer's distance cost.

/**
 * Weight of `networkId` in `networkWeights`: 1 when the map or the network is
 * absent, otherwise the given value. Only own keys count, so a network named
 * like an Object.prototype member ("constructor") is not misread.
 */
export function getNetworkWeight(
  networkWeights: Record<string, number> | undefined,
  networkId: string | undefined,
): number {
  if (networkWeights === undefined || networkId === undefined) return 1;
  if (!Object.prototype.hasOwnProperty.call(networkWeights, networkId)) return 1;
  const weight = networkWeights[networkId];
  return weight === undefined ? 1 : weight;
}
