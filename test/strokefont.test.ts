import { describe, it, expect } from 'vitest';
import { strokeTextExtent, strokeTextHeight, wrapTwoLines, LINE_PITCH } from '../src/kicad/strokefont.js';

describe('stroke-font metrics (#307)', () => {
  it('measures by glyph: a wide-glyph string outruns a narrow one of the same length', () => {
    const wide = strokeTextExtent('WWWW', 3.5, 'left');
    const narrow = strokeTextExtent('iiii', 3.5, 'left');
    expect(wide.maxX).toBeGreaterThan(2 * narrow.maxX);
  });

  it('centres and right-aligns about the anchor', () => {
    const l = strokeTextExtent('Power', 3.5, 'left');
    const c = strokeTextExtent('Power', 3.5, 'center');
    const r = strokeTextExtent('Power', 3.5, 'right');
    expect(l.minX).toBeGreaterThan(0);
    expect(c.minX).toBeLessThan(0);
    expect(c.maxX).toBeGreaterThan(0);
    expect(r.maxX).toBeLessThanOrEqual(0.12 * 3.5 + 0.1 * 3.5);
  });

  it('measures multi-line text by its widest line and one line pitch per extra line', () => {
    expect(strokeTextExtent('ab\nWWWWWW', 2, 'left')).toEqual(strokeTextExtent('WWWWWW', 2, 'left'));
    expect(strokeTextHeight('one', 3.5)).toBe(3.5);
    expect(strokeTextHeight('one\ntwo', 3.5)).toBeCloseTo(3.5 * (1 + LINE_PITCH), 9);
  });

  it('wraps at the space that leaves the narrowest two lines', () => {
    expect(wrapTwoLines('Mechanical connector and mounting holes', 3.5)).toBe('Mechanical connector\nand mounting holes');
    const two = wrapTwoLines('Mechanical connector and mounting holes', 3.5)!;
    for (const alt of ['Mechanical\nconnector and mounting holes', 'Mechanical connector and\nmounting holes']) {
      expect(strokeTextExtent(two, 3.5, 'left').maxX).toBeLessThan(strokeTextExtent(alt, 3.5, 'left').maxX);
    }
  });

  it('has nothing to wrap without a space between words', () => {
    expect(wrapTwoLines('MechanicalConnector', 3.5)).toBeNull();
    expect(wrapTwoLines(' leading', 3.5)).toBeNull();
    expect(wrapTwoLines('trailing ', 3.5)).toBeNull();
  });
});
