// @ts-nocheck
// Vendored from tscircuit/calculate-packing@a2d60ae: lib/PackSolver2/sortComponentQueue.ts
import type { InputComponent, PackInput } from "../types.js"

export interface SortComponentQueueParams {
  components: InputComponent[]
  packOrderStrategy: PackInput["packOrderStrategy"]
  packFirst?: string[]
}

export function sortComponentQueue({
  components,
  packOrderStrategy,
  packFirst = [],
}: SortComponentQueueParams): InputComponent[] {
  // Create a map for quick lookup of packFirst priorities
  const packFirstMap = new Map<string, number>()
  packFirst.forEach((componentId, index) => {
    packFirstMap.set(componentId, index)
  })

  return [...components].sort((a, b) => {
    const aPackFirstIndex = packFirstMap.get(a.componentId)
    const bPackFirstIndex = packFirstMap.get(b.componentId)

    // If both components are in packFirst, sort by their order in packFirst
    if (aPackFirstIndex !== undefined && bPackFirstIndex !== undefined) {
      return aPackFirstIndex - bPackFirstIndex
    }

    // If only one component is in packFirst, it comes first
    if (aPackFirstIndex !== undefined) return -1
    if (bPackFirstIndex !== undefined) return 1

    // Neither component is in packFirst, use the regular strategy
    if (packOrderStrategy === "largest_to_smallest") {
      return b.pads.length - a.pads.length
    }
    return a.pads.length - b.pads.length
  })
}
