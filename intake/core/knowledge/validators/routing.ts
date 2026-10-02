/**
 * Confidence-as-routing policy (SPEC §8, §3.5).
 *
 * Provider confidence orders the review queue relative to the provider's
 * calibrated threshold — nothing else. It never admits, blocks, or overrides
 * a validator (AC-7.2: validators never read confidence).
 */

export interface ReviewQueueItem {
  taskId: string;
  providerId: string;
  confidence: number;
}

export interface CalibrationThresholds {
  /** providerId → calibrated reviewRoutingThreshold. */
  [providerId: string]: { reviewRoutingThreshold: number } | undefined;
}

/**
 * Order review tasks most-suspect first: greatest shortfall below the
 * provider's calibrated threshold (AC-7.1). Uncalibrated providers sort
 * before calibrated ones at equal shortfall (their thresholds are unknown —
 * treat as maximally suspect).
 */
export function orderReviewQueue(
  items: ReviewQueueItem[],
  calibration: CalibrationThresholds,
): ReviewQueueItem[] {
  const shortfall = (item: ReviewQueueItem): number => {
    const threshold = calibration[item.providerId]?.reviewRoutingThreshold;
    if (threshold === undefined) return Number.POSITIVE_INFINITY;
    return threshold - item.confidence;
  };
  return [...items].sort((a, b) => {
    const diff = shortfall(b) - shortfall(a);
    if (diff !== 0) return diff < 0 ? -1 : 1;
    return a.taskId.localeCompare(b.taskId);
  });
}
