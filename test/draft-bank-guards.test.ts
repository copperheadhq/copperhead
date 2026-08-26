import { describe, it, expect } from 'vitest';
import { interiorGridPoints, segCrossesStubGrowth, splitBankRuns, type Seg, type SchematicDraftReport } from '../src/kicad/draft/engine.js';
import { formatSchematicDraftReport } from '../src/kicad/draft/draft.js';

/**
 * The geometric predicates behind two mechanisms whose failure mode is a net
 * that is not the net the IR declared, and which the engine's own placement
 * keeps out of reach from the IR: no intent produces a sheet where a bank
 * trunk wants to cross a foreign stub, because the placement pass already
 * spaced the columns. Testing them here, as the pure functions they are, is
 * what keeps the vetoes from being asserted by reasoning alone.
 */

const U = 1.27;

/** On-segment test for orthogonal segments, mirroring the engine's own. */
function onSeg(x: number, y: number, s: Seg): boolean {
  const E = 0.005;
  return (
    x >= Math.min(s.x1, s.x2) - E &&
    x <= Math.max(s.x1, s.x2) + E &&
    y >= Math.min(s.y1, s.y2) - E &&
    y <= Math.max(s.y1, s.y2) + E &&
    (Math.abs(s.x1 - s.x2) < E ? Math.abs(x - s.x1) < E : Math.abs(y - s.y1) < E)
  );
}

describe('interiorGridPoints: a wired label may only sit on its own run', () => {
  /**
   * A trunk-and-branch run as the router emits it: three horizontal reaches
   * onto one vertical trunk, the trunk split at every branch meet. Its points
   * sort into an order that says nothing about which point joins which, and
   * this is the shape whose sorted points, paired up, produced the diagonal
   * (128.27, 36.83)-(99.06, 45.72) that could anchor a label in open sheet.
   */
  const run: Seg[] = [
    { x1: 99.06, y1: 27.94, x2: 113.03, y2: 27.94 },
    { x1: 128.27, y1: 36.83, x2: 113.03, y2: 36.83 },
    { x1: 99.06, y1: 45.72, x2: 113.03, y2: 45.72 },
    { x1: 113.03, y1: 27.94, x2: 113.03, y2: 36.83 },
    { x1: 113.03, y1: 36.83, x2: 113.03, y2: 45.72 },
  ];

  it('every point it returns lies on one of the segments it was given', () => {
    const pts = interiorGridPoints(run, U);
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) {
      expect(run.some((s) => onSeg(p.x, p.y, s)), `(${p.x}, ${p.y}) lies on no segment of the run`).toBe(true);
    }
  });

  it('pairing the run\'s points instead of its segments walks off the wires', () => {
    // What the caller must not do, kept here so the reason the signature takes
    // segments is visible: the anchor-preference sort interleaves the corners,
    // so pts[2]/pts[3] are the ends of no segment and the walk between them is
    // diagonal — off every wire, where KiCad attaches nothing.
    const pts = run.flatMap((s) => [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]);
    pts.sort((a, b) => a.y - b.y || a.x - b.x);
    const paired: Seg[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      paired.push({ x1: pts[i]!.x, y1: pts[i]!.y, x2: pts[i + 1]!.x, y2: pts[i + 1]!.y });
    }
    expect(paired.some((s) => s.x1 !== s.x2 && s.y1 !== s.y2)).toBe(true);
    const strays = interiorGridPoints(paired, U).filter((p) => !run.some((s) => onSeg(p.x, p.y, s)));
    expect(strays.length).toBeGreaterThan(0);
  });

  it('excludes the endpoints, which the caller has already tried', () => {
    const pts = interiorGridPoints([{ x1: 0, y1: 0, x2: 3 * U, y2: 0 }], U);
    expect(pts).toEqual([
      { x: U, y: 0 },
      { x: 2 * U, y: 0 },
    ]);
  });

  it('returns nothing for a segment with no room inside it', () => {
    expect(interiorGridPoints([{ x1: 0, y1: 0, x2: U, y2: 0 }], U)).toEqual([]);
    expect(interiorGridPoints([{ x1: 5, y1: 5, x2: 5, y2: 5 }], U)).toEqual([]);
    expect(interiorGridPoints([], U)).toEqual([]);
  });
});

describe('segCrossesStubGrowth: a trunk may not cross where a stub could grow', () => {
  const REACH = 4 * U; // the engine's STUB + 2, the grown length of a signal stub
  const EPS = 0.005;
  // a foreign pin at (20, 30) whose stub grows upward, toward the trunk
  const pin = { x: 20, y: 30 };
  const up = { dx: 0, dy: -1 };

  it('vetoes a trunk that spans the pin\'s x within the stub\'s reach', () => {
    const seg: Seg = { x1: 10, y1: 30 - 3 * U, x2: 30, y2: 30 - 3 * U };
    expect(segCrossesStubGrowth(seg, pin, up, REACH, EPS)).toBe(true);
  });

  it('allows a trunk one unit beyond the reach', () => {
    const seg: Seg = { x1: 10, y1: 30 - 5 * U, x2: 30, y2: 30 - 5 * U };
    expect(segCrossesStubGrowth(seg, pin, up, REACH, EPS)).toBe(false);
  });

  it('allows a trunk that clears the pin in x, however close in y', () => {
    const seg: Seg = { x1: 25, y1: 30 - 2 * U, x2: 40, y2: 30 - 2 * U };
    expect(segCrossesStubGrowth(seg, pin, up, REACH, EPS)).toBe(false);
  });

  it('allows a trunk on the side the stub grows away from', () => {
    const seg: Seg = { x1: 10, y1: 30 + 2 * U, x2: 30, y2: 30 + 2 * U };
    expect(segCrossesStubGrowth(seg, pin, up, REACH, EPS)).toBe(false);
  });

  it('catches collinear overlap, which a crossing test alone would miss', () => {
    // a trunk running straight down the stub's own line
    const seg: Seg = { x1: 20, y1: 30 - 3 * U, x2: 20, y2: 30 - U };
    expect(segCrossesStubGrowth(seg, pin, up, REACH, EPS)).toBe(true);
  });

  it('measures the pin point itself, so a stub with nowhere to grow is still guarded', () => {
    const seg: Seg = { x1: 10, y1: 30, x2: 30, y2: 30 };
    expect(segCrossesStubGrowth(seg, pin, { dx: 0, dy: 0 }, REACH, EPS)).toBe(true);
  });
});

describe('splitBankRuns: a member that cannot join cleanly splits the run', () => {
  const all = (): boolean => true;

  it('chains every member when each one clears', () => {
    expect(splitBankRuns(['a', 'b', 'c'], all, all)).toEqual([['a', 'b', 'c']]);
  });

  it('drops a member whose own stub is blocked, and ends the run there', () => {
    // 'x' cannot stub: it joins nothing and the run before it is flushed, so
    // the members after it start a fresh trunk rather than reaching across.
    const runs = splitBankRuns(['a', 'b', 'x', 'c', 'd'], (c) => c !== 'x', all);
    expect(runs).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('starts a new run at a member that cannot join the one before it', () => {
    // unlike a blocked stub, a failed JOIN keeps the member: it can still
    // anchor the next trunk.
    const runs = splitBankRuns(['a', 'b', 'c', 'd'], all, (prev) => prev !== 'b');
    expect(runs).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('emits no run of one: a lone stub is no bank', () => {
    expect(splitBankRuns(['a', 'x', 'b'], (c) => c !== 'x', all)).toEqual([]);
    expect(splitBankRuns(['a'], all, all)).toEqual([]);
    expect(splitBankRuns([], all, all)).toEqual([]);
  });

  it('flushes a trailing run', () => {
    expect(splitBankRuns(['x', 'a', 'b'], (c) => c !== 'x', all)).toEqual([['a', 'b']]);
  });
});

describe('the draft report marks the class no pin attests', () => {
  const base = {
    groups: [], wireCount: 0, labelCount: 0, pwrFlags: [], noConnects: 0, paper: 'A4', notes: [], mergedNets: [],
  } as unknown as SchematicDraftReport;
  const classes = (netClasses: SchematicDraftReport['netClasses']): string =>
    formatSchematicDraftReport({ ...base, netClasses }).split('\n').find((l) => l.includes('net classes:'))!;

  it('leaves an ordinary board unmarked: a defaulted signal is not an inference worth flagging', () => {
    // Every signal net on a board reaches no power_in/power_out pin, so it
    // arrives here with a `name` basis. Marking those would decorate almost
    // the whole line and tell a reader nothing.
    const line = classes([
      { name: 'VCC', class: 'rail', overridden: false, basis: 'pin-type' },
      { name: 'GND', class: 'ground', overridden: false, basis: 'pin-type' },
      { name: 'SDA', class: 'signal', overridden: false, basis: 'name' },
      { name: 'RESET_N', class: 'signal', overridden: false, basis: 'name' },
    ]);
    expect(line).toContain('SDA=signal');
    expect(line).not.toContain('~');
  });

  it('marks a POWER class taken from the net name, and says what the mark means', () => {
    const line = classes([
      { name: 'GNDD', class: 'ground', overridden: false, basis: 'name' },
      { name: '5V0', class: 'rail', overridden: false, basis: 'name' },
      { name: 'SDA', class: 'signal', overridden: false, basis: 'name' },
    ]);
    expect(line).toContain('GNDD=ground~');
    expect(line).toContain('5V0=rail~');
    expect(line).toMatch(/SDA=signal(?!~)/); // the signal beside them is not marked
    expect(line).toContain('~=inferred from the net name, not from any pin type');
  });

  it('keeps the IR override mark, which outranks the basis', () => {
    const line = classes([
      { name: 'VCC', class: 'signal', overridden: true, basis: 'declared' },
      { name: 'GNDD', class: 'ground', overridden: false, basis: 'name' },
    ]);
    expect(line).toContain('VCC=signal*');
    expect(line).toContain('*=IR override');
    expect(line).toContain('~=inferred');
  });
});
