/**
 * Rule stages (RFC 11 §8.5 stages 1 and 2; task 7.0): edge and fixed placement,
 * keepout and separation legalization, deterministic and constraint-driven,
 * on the golden boards whose seeded faults they exist for.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { placeMechanical, legalizeKeepouts, legalizeSeparation, legalizeEdge, keepoutZones } from '../src/pcb/engines/legalize.js';
import { placeBoard } from '../src/pcb/engines/place.js';
import { loadConstraints } from '../src/pcb/intent/load.js';
import { checkIntent } from '../src/pcb/verify/checkers/intent.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { applyCandidate } from '../src/pcb/ir/kicad/export.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');
const HARNESS = { network: 'none' as const, allowHarnessEngines: true, denyLicenses: [] };

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

async function load(caseName: string) {
  const p = path.join(GOLDEN, caseName, 'board.kicad_pcb');
  const text = await readFile(p, 'utf8');
  const projectText = await readFile(p.replace(/\.kicad_pcb$/, '.kicad_pro'), 'utf8');
  const design = importBoard({ boardText: text, boardPath: p, projectText, now: 't' }).design;
  const { registry } = await loadConstraints(design, p);
  return { p, text, projectText, design, registry };
}

describe('rule stages', () => {
  it('edge: J1 is moved against the west edge and the edge constraint then passes', async () => {
    const { text, projectText, design, registry } = await load('fixed-connector');
    const movable = new Set(design.components.map((c) => c.id));
    const r = placeMechanical(design, registry, movable);
    expect(r.placements).toHaveLength(1);
    expect(r.notes[0]).toMatch(/J1 moved .* to the west edge/);
    const after = importBoard({ boardText: applyCandidate(text, design, { placement: r.placements }).text, boardPath: 'b', projectText, now: 't' }).design;
    expect(checkIntent(after, registry).diagnostics.filter((d) => d.code === 'intent.mechanical.edge')).toEqual([]);
    // idempotent
    expect(placeMechanical(after, registry, movable).placements).toEqual([]);
  });
  it('keepout: R2 is moved the least distance out of the ring around H1', async () => {
    const { text, design, registry } = await load('keepout');
    expect(keepoutZones(design, registry)).toHaveLength(1);
    const movable = new Set(design.components.map((c) => c.id));
    const r = legalizeKeepouts(design, registry, movable, []);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^R2 moved .* out of keepout/);
    const after = importBoard({ boardText: applyCandidate(text, design, { placement: r.placements }).text, boardPath: 'b', now: 't' }).design;
    expect(checkIntent(after, registry).diagnostics.filter((d) => d.code === 'intent.manufacturing.keepout')).toEqual([]);
    const r2 = after.components.find((c) => c.reference === 'R2')!;
    const before = design.components.find((c) => c.reference === 'R2')!;
    expect(Math.hypot(r2.at.x - before.at.x, r2.at.y - before.at.y)).toBeLessThan(6_000_000);
  });
  it('separation: the digital block is pushed away until the minimum holds, and stays on the board', async () => {
    const { text, design, registry } = await load('separation');
    const movable = new Set(design.components.map((c) => c.id));
    const r = legalizeSeparation(design, registry, movable, []);
    expect(r.notes[0]).toMatch(/moved .* away from/);
    const after = importBoard({ boardText: applyCandidate(text, design, { placement: r.placements }).text, boardPath: 'b', now: 't' }).design;
    const v = checkIntent(after, registry);
    expect(v.diagnostics.filter((d) => d.code === 'intent.functional.separation')).toEqual([]);
    const ob = design.board.outline.outer;
    const maxX = Math.max(...ob.map((q) => q.x));
    for (const c of after.components) for (const pad of c.pads) expect(pad.at.x).toBeLessThan(maxX);
  });
  it('edge: a placer result inside the copper-to-edge clearance is moved the least distance back in (B4: pyplacer on overlap)', async () => {
    const { text, projectText, design } = await load('overlap');
    const movable = new Set(design.components.map((c) => c.id));
    const c1 = design.components.find((c) => c.reference === 'C1')!;
    const ob = design.board.outline.outer;
    const minX = Math.min(...ob.map((q) => q.x));
    // what pyplacer did on B4: C1 parked 1.2 mm from the west edge, its copper inside the 0.5 mm rule
    const proposed = [{ id: c1.id, at: { x: minX + 1_235_000, y: c1.at.y }, rotation: c1.rotation, side: c1.attributes.side }];
    const r = legalizeEdge(design, movable, proposed);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^C1 moved .* mm in from the board edge$/);
    const moved = r.placements.find((p) => p.id === c1.id)!;
    expect(moved.at.x).toBeGreaterThan(proposed[0]!.at.x);
    expect(moved.at.x - proposed[0]!.at.x).toBeLessThan(3_000_000);
    const after = importBoard({ boardText: applyCandidate(text, design, { placement: r.placements }).text, boardPath: 'b', projectText, now: 't' }).design;
    const inset = design.board.rules.copperEdgeClearanceNm;
    for (const c of after.components) for (const pad of c.pads) expect(pad.at.x - inset).toBeGreaterThan(minX);
    // a part already inside is untouched
    expect(legalizeEdge(after, movable, []).placements).toEqual([]);
  });
  it('edge: a mounting hole at the edge is not moved (B4: H1 on keepout was pushed 2.8 mm in)', async () => {
    const { design } = await load('keepout');
    const h1 = design.components.find((c) => c.reference === 'H1')!;
    const ob = design.board.outline.outer;
    const minX = Math.min(...ob.map((q) => q.x));
    const movable = new Set(design.components.map((c) => c.id));
    const r = legalizeEdge(design, movable, [{ id: h1.id, at: { x: minX + 1_000_000, y: h1.at.y }, rotation: h1.rotation, side: h1.attributes.side }]);
    expect(r.notes).toEqual([]);
    expect(r.placements.find((p) => p.id === h1.id)!.at.x).toBe(minX + 1_000_000);
  });
});

describe('placeBoard with the rule stages', () => {
  it.each(['fixed-connector', 'keepout', 'separation'])('%s ends PASS with every hard intent constraint satisfied', async (caseName) => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-legalize-'));
    try {
      const res = await placeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, caseName, 'board.kicad_pcb'), runDir: path.join(dir, 'run'), placers: ['placer-fixed'], policy: HARNESS, probe: false, limits: { engineSeconds: 60, wallSeconds: 60 } });
      expect(res.outcome.status, res.outcome.detail.join('\n')).toBe('PASS');
      const c = res.ranking.candidates[0]!;
      expect(c.eligible).toBe(true);
      expect(c.metrics.intent_hard_violations).toBe(0);
      expect(c.metrics.intent_hard_total).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
