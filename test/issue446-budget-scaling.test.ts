import { describe, expect, it } from 'vitest';
import { computePartSelectionMaxTurns, resolveStageMaxTurns } from '../src/config.js';

describe('issue #446 part-selection budget scaling', () => {
  it('keeps small BOMs at 40 turns and scales for a 283-row BOM', () => {
    expect(computePartSelectionMaxTurns(20)).toBe(40);
    expect(computePartSelectionMaxTurns(283)).toBe(124);
  });

  it('handles zero, one, and the threshold rows', () => {
    expect(computePartSelectionMaxTurns(0)).toBe(40);
    expect(computePartSelectionMaxTurns(1)).toBe(40);
    expect(computePartSelectionMaxTurns(75)).toBe(40);
    expect(computePartSelectionMaxTurns(76)).toBe(41);
  });

  it('floors fractional counts and treats negative or non-finite counts as zero', () => {
    expect(computePartSelectionMaxTurns(75.9)).toBe(40);
    expect(computePartSelectionMaxTurns(-1)).toBe(40);
    expect(computePartSelectionMaxTurns(Number.NaN)).toBe(40);
    expect(computePartSelectionMaxTurns(Number.POSITIVE_INFINITY)).toBe(40);
  });

  it('uses the explicit per-stage override before the computed default', () => {
    expect(resolveStageMaxTurns('part-selection', { stageMaxTurns: { 'part-selection': 73 } }, 283)).toBe(73);
    expect(resolveStageMaxTurns('part-selection', {}, 283)).toBe(124);
    expect(resolveStageMaxTurns('schematic', { stageMaxTurns: { schematic: 51 } }, 283)).toBe(51);
    expect(resolveStageMaxTurns('other-stage', {}, 283)).toBeUndefined();
  });
});
