/**
 * IR core (RFC 11 §6.1, ADR 0005): units, the geometry facade over the
 * polygon kernel, canonical hashing, and snapshot immutability.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mmToNm, nmToMm, normMdeg } from '../src/pcb/ir/units.js';
import {
  rect, circle, stadium, roundRect, capsule, rotatePoint, placeLocal, union, intersects, intersection,
  area, bbox, contains, distance, offset, chainLoops, centroid,
} from '../src/pcb/ir/geometry.js';
import { canonicalJson, hashDesign, sha256 } from '../src/pcb/ir/canonical.js';
import { makeSnapshot, writeRunDir, verifySnapshotIntact } from '../src/pcb/ir/snapshot.js';
import type { PcbDesign } from '../src/pcb/ir/types.js';

const mm = mmToNm;

describe('units', () => {
  it('round-trips millimetres at nanometre precision', () => {
    expect(mm(1.234567)).toBe(1234567);
    expect(nmToMm(1234567)).toBe('1.234567');
    expect(nmToMm(-0)).toBe('0');
    expect(nmToMm(mm(100))).toBe('100');
    expect(normMdeg(-90_000)).toBe(270_000);
  });
});

describe('geometry facade', () => {
  it('rotates in KiCad\'s Y-down frame (pcbnew-verified convention)', () => {
    // D4 on StickHub: footprint at (150.4, 96.75) rot -90, pad 1 local (-0.45, 0) -> absolute (150.4, 96.3)
    const p = rotatePoint({ x: mm(-0.45), y: 0 }, -90_000);
    expect(p).toEqual({ x: 0, y: mm(-0.45) });
    const placed = placeLocal(rect(mm(-0.45), 0, mm(0.4), mm(0.6)), { x: mm(150.4), y: mm(96.75) }, -90_000);
    expect(centroid(placed)).toEqual({ x: mm(150.4), y: mm(96.3) });
  });

  it('measures rectangles, circles, stadiums, and rounded rects', () => {
    expect(area(rect(0, 0, mm(2), mm(1)))).toBe(mm(2) * mm(1));
    const c = circle(0, 0, mm(1));
    expect(area(c) / (Math.PI * (mm(0.5) ** 2))).toBeCloseTo(1, 1);
    const s = stadium(0, 0, mm(3), mm(1));
    expect(bbox(s)).toEqual({ minX: mm(-1.5), minY: mm(-0.5), maxX: mm(1.5), maxY: mm(0.5) });
    const rr = roundRect(0, 0, mm(2), mm(1), mm(0.25));
    expect(area(rr)).toBeLessThan(area(rect(0, 0, mm(2), mm(1))));
    expect(area(rr)).toBeGreaterThan(0.9 * area(rect(0, 0, mm(2), mm(1))));
  });

  it('unions, intersects, and keeps touching shapes apart', () => {
    const a = rect(0, 0, mm(2), mm(2));
    const b = rect(mm(1), 0, mm(2), mm(2));
    const touching = rect(mm(2), 0, mm(2), mm(2));
    expect(intersects(a, b)).toBe(true);
    expect(intersects(a, touching)).toBe(false);
    expect(area(union([a, b])[0]!)).toBe(mm(3) * mm(2));
    expect(area(intersection(a, b)[0]!)).toBe(mm(1) * mm(2));
  });

  it('computes edge distance and containment', () => {
    const a = rect(0, 0, mm(2), mm(2));
    const far = rect(mm(5), 0, mm(2), mm(2));
    expect(distance(a, far)).toBe(mm(3));
    expect(distance(a, rect(mm(1), 0, mm(2), mm(2)))).toBe(0);
    expect(contains(a, { x: 0, y: 0 })).toBe(true);
    expect(contains(a, { x: mm(1), y: 0 })).toBe(true); // boundary counts as inside
    expect(contains(a, { x: mm(1.1), y: 0 })).toBe(false);
  });

  it('offsets outward and inward', () => {
    const a = rect(0, 0, mm(2), mm(2));
    const grown = offset(a, mm(0.5));
    expect(grown).toHaveLength(1);
    expect(bbox(grown[0]!)).toEqual({ minX: mm(-1.5), minY: mm(-1.5), maxX: mm(1.5), maxY: mm(1.5) });
    const shrunk = offset(a, mm(-0.5));
    expect(shrunk).toHaveLength(1);
    expect(area(shrunk[0]!)).toBeCloseTo(mm(1) * mm(1), -8);
  });

  it('strokes a track into a capsule', () => {
    const c = capsule({ x: 0, y: 0 }, { x: mm(4), y: 0 }, mm(0.25));
    const b = bbox(c);
    expect(b.minX).toBe(mm(-0.125));
    expect(b.maxX).toBe(mm(4.125));
    expect(b.maxY - b.minY).toBe(mm(0.25));
  });

  it('chains outline segments into loops', () => {
    const p = (x: number, y: number) => ({ x: mm(x), y: mm(y) });
    const segs = [
      { a: p(0, 0), b: p(10, 0) },
      { a: p(10, 10), b: p(0, 10) }, // reversed
      { a: p(10, 0), b: p(10, 10) },
      { a: p(0, 10), b: p(0, 0.0005) }, // 0.5 um gap
    ];
    const { loops, open } = chainLoops(segs, mm(0.001));
    expect(open).toBe(0);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
  });
});

function design(overrides: Partial<PcbDesign> = {}): PcbDesign {
  return {
    schemaVersion: '1.0',
    designId: 'd',
    source: { files: { board: 'b.kicad_pcb' }, kicadVersion: '10.0.4', boardFileVersion: 20240108, importedAt: '2026-09-06T00:00:00Z', contentHash: '' },
    board: { outline: rect(mm(115), mm(112), mm(30), mm(24)), cutouts: [], layers: [], keepouts: [], fabricationProfile: 'jlcpcb-2layer', rules: { severities: {}, clearanceNm: mm(0.2), trackWidthNm: mm(0.25), viaDiameterNm: mm(0.6), viaDrillNm: mm(0.3), copperEdgeClearanceNm: mm(0.3), netClasses: {} } },
    components: [],
    nets: [],
    constraints: [],
    placement: { components: [], lockedComponentIds: [] },
    routing: { segments: [], arcs: [], vias: [], zones: [] },
    preserved: [],
    lossy: [],
    ...overrides,
  };
}

describe('canonical hashing', () => {
  it('is key-order independent and rejects non-integers', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(() => canonicalJson({ x: 1.5 })).toThrow(/integers only/);
    expect(sha256('a')).toHaveLength(64);
  });

  it('ignores the import timestamp and stored hash', () => {
    const a = design();
    const b = design({ source: { ...a.source, importedAt: '2027-01-01T00:00:00Z', contentHash: 'stale' } });
    expect(hashDesign(a)).toBe(hashDesign(b));
    const c = design({ designId: 'other' });
    expect(hashDesign(c)).not.toBe(hashDesign(a));
  });
});

describe('snapshot immutability (AC-17.2)', () => {
  it('detects a snapshot rewritten under the engine', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-snap-'));
    try {
      const src = path.join(dir, 'board.kicad_pcb');
      await writeFile(src, '(kicad_pcb)', 'utf8');
      const snap = makeSnapshot(design(), { kind: 'verify' });
      const run = await writeRunDir(path.join(dir, 'run'), snap, [src]);
      expect(await verifySnapshotIntact(run, { fileHash: run.fileHash, designHash: snap.hash })).toEqual({ ok: true });
      // an engine that writes into its input
      const { chmod } = await import('node:fs/promises');
      await chmod(run.snapshotPath, 0o644);
      await writeFile(run.snapshotPath, (await readFile(run.snapshotPath, 'utf8')).replace('"designId":"d"', '"designId":"x"'), 'utf8');
      const res = await verifySnapshotIntact(run, { fileHash: run.fileHash, designHash: snap.hash });
      expect(res.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
