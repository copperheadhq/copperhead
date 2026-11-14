import { describe, it, expect } from 'vitest';
import { isEngineAuthoredSchematic, isCreateProducedRepo } from '../src/kicad/fab.js';

describe('engine-authored detection (hand-takeover release)', () => {
  it('recognizes the copperhead generator stamp and its absence', () => {
    expect(isEngineAuthoredSchematic('(kicad_sch\n\t(version 20231120)\n\t(generator "copperhead-draft")\n)')).toBe(true);
    // a KiCad re-save replaces the generator: the sheet has left drafting mode
    expect(isEngineAuthoredSchematic('(kicad_sch\n\t(version 20231120)\n\t(generator "eeschema")\n)')).toBe(false);
    expect(isEngineAuthoredSchematic('')).toBe(false);
  });

  it('only reads the file head, so a marker buried in content does not count', () => {
    expect(isEngineAuthoredSchematic(`(kicad_sch\n${' '.repeat(500)}(generator "copperhead-draft")`)).toBe(false);
  });

  it('isCreateProducedRepo still reads the origin marker', () => {
    expect(isCreateProducedRepo({ origin: 'create' })).toBe(true);
    expect(isCreateProducedRepo({ origin: 'init' })).toBe(false);
    expect(isCreateProducedRepo(null)).toBe(false);
  });
});
