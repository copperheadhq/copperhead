import { describe, expect, it } from 'vitest';
import { computePartSelectionMaxTurns, resolveStageMaxTurns } from '../src/config.js';

describe('issue #446 part-selection budget scaling', () => {
  it('keeps small BOMs at the default 40 turns and scales for a 283-row BOM', () => {
    expect(computePartSelectionMaxTurns(20, 40)).toBe(40);
    expect(computePartSelectionMaxTurns(283, 40)).toBe(124);
  });

  it('handles zero, one, and the threshold rows', () => {
    expect(computePartSelectionMaxTurns(0, 40)).toBe(40);
    expect(computePartSelectionMaxTurns(1, 40)).toBe(40);
    expect(computePartSelectionMaxTurns(75, 40)).toBe(40);
    expect(computePartSelectionMaxTurns(76, 40)).toBe(41);
  });

  it('floors fractional counts and treats negative or non-finite counts as zero', () => {
    expect(computePartSelectionMaxTurns(75.9, 40)).toBe(40);
    expect(computePartSelectionMaxTurns(-1, 40)).toBe(40);
    expect(computePartSelectionMaxTurns(Number.NaN, 40)).toBe(40);
    expect(computePartSelectionMaxTurns(Number.POSITIVE_INFINITY, 40)).toBe(40);
  });

  it('uses the configured maxTurns as the floor, so a small BOM keeps a larger budget (AC-15.19)', () => {
    expect(computePartSelectionMaxTurns(10, 100)).toBe(100);
    expect(resolveStageMaxTurns('part-selection', { maxTurns: 100 }, 10)).toBe(100);
    // the row-scaled value still wins once it exceeds the configured floor
    expect(resolveStageMaxTurns('part-selection', { maxTurns: 100 }, 283)).toBe(124);
    expect(resolveStageMaxTurns('part-selection', { maxTurns: 20 }, 10)).toBe(20);
  });

  it('uses the explicit per-stage override before the computed default', () => {
    expect(
      resolveStageMaxTurns('part-selection', { maxTurns: 40, stageMaxTurns: { 'part-selection': 73 } }, 283),
    ).toBe(73);
    expect(resolveStageMaxTurns('part-selection', { maxTurns: 40 }, 283)).toBe(124);
    expect(resolveStageMaxTurns('schematic', { maxTurns: 40, stageMaxTurns: { schematic: 51 } }, 283)).toBe(51);
    expect(resolveStageMaxTurns('other-stage', { maxTurns: 40 }, 283)).toBeUndefined();
  });
});
