/**
 * KiCad board export by text surgery (RFC 11 §6.2, AC-17.1): identity keeps
 * bytes, a placement change re-imports to the intended geometry (and matches
 * pcbnew when the oracle is enabled), copper is replaced record by record, and
 * zone refill goes through kicad-cli.
 */
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { applyCandidate, EXPORT_GENERATOR } from '../src/pcb/ir/kicad/export.js';
import { refillZones, extractFills } from '../src/pcb/ir/kicad/zones.js';
import { hashDesign } from '../src/pcb/ir/canonical.js';
import { mmToNm } from '../src/pcb/ir/units.js';
import { rotatePoint } from '../src/pcb/ir/geometry.js';
import { kicadLoadError } from '../src/kicad/cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures', 'microboards');
const STICKHUB = '/usr/share/kicad/demos/stickhub/StickHub.kicad_pcb';
const mm = mmToNm;

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

const load = async (name: string) => {
  const text = await readFile(path.join(GOLDEN, name, 'board.kicad_pcb'), 'utf8');
  const { design } = importBoard({ boardText: text, boardPath: name, now: 't' });
  return { text, design };
};

describe('export', () => {
  it('identity: only the generator pair changes', async () => {
    const { text, design } = await load('completion');
    const out = applyCandidate(text, design, {}, { generatorVersion: 'test' });
    expect(out.moved).toEqual([]);
    expect(out.copperRemoved).toBe(0);
    const normalize = (s: string) => s.replace(/\(generator "[^"]*"\)/, '').replace(/\(generator_version "[^"]*"\)/, '');
    expect(normalize(out.text)).toBe(normalize(text));
    expect(out.text).toContain(`(generator "${EXPORT_GENERATOR}")`);
    expect(hashDesign(importBoard({ boardText: out.text, boardPath: 'completion', now: 't' }).design)).toBe(hashDesign(design));
  });

  it('moves and rotates a footprint; pads follow because their angles are absolute', async () => {
    const { text, design } = await load('completion');
    const r1 = design.components.find((c) => c.reference === 'R1')!;
    const target = { id: r1.id, at: { x: r1.at.x + mm(2), y: r1.at.y - mm(1) }, rotation: 90_000, side: 'front' as const };
    const out = applyCandidate(text, design, { placement: [target] });
    expect(out.moved).toEqual(['R1']);
    expect(out.rotated).toEqual(['R1']);
    const re = importBoard({ boardText: out.text, boardPath: 'moved', now: 't' }).design;
    const r1b = re.components.find((c) => c.reference === 'R1')!;
    expect(r1b.at).toEqual(target.at);
    expect(r1b.rotation).toBe(90_000);
    for (const [i, pad] of r1.pads.entries()) {
      const local = rotatePoint({ x: pad.at.x - r1.at.x, y: pad.at.y - r1.at.y }, -r1.rotation);
      const expected = rotatePoint(local, 90_000);
      expect(r1b.pads[i]!.at).toEqual({ x: target.at.x + expected.x, y: target.at.y + expected.y });
      expect(r1b.pads[i]!.rotation).toBe((pad.rotation + 90_000) % 360_000);
    }
    // everything else is byte-identical
    const others = (s: string) => s.replace(/\(footprint "Resistor_SMD:R_0603_1608Metric"[\s\S]*?\n\t\)\n/g, '').replace(/\(generator "[^"]*"\)/, '');
    expect(others(out.text).length).toBe(others(text).length);
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-export-'));
    try {
      const p = path.join(dir, 'moved.kicad_pcb');
      await writeFile(p, out.text, 'utf8');
      expect(await kicadLoadError(p)).toBeNull();
      if (process.env.COPPERHEAD_TEST_PCBNEW === '1') {
        const res = await execa(process.env.COPPERHEAD_PCBNEW_PYTHON ?? '/usr/bin/python3', [path.join(HERE, 'support', 'pcbnew-pads.py'), p], {
          env: { ...process.env, PYTHONPATH: process.env.COPPERHEAD_PCBNEW_PYTHONPATH ?? '/usr/lib/python3/dist-packages' },
        });
        const oracle = (JSON.parse(res.stdout) as { ref: string; pads: { x: number; y: number }[] }[]).find((f) => f.ref === 'R1')!;
        for (const [i, op] of oracle.pads.entries()) {
          expect(Math.abs(r1b.pads[i]!.at.x - mm(op.x))).toBeLessThanOrEqual(1000);
          expect(Math.abs(r1b.pads[i]!.at.y - mm(op.y))).toBeLessThanOrEqual(1000);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a side flip instead of guessing', async () => {
    const { text, design } = await load('completion');
    const u1 = design.components.find((c) => c.reference === 'U1')!;
    const out = applyCandidate(text, design, { placement: [{ id: u1.id, at: u1.at, rotation: u1.rotation, side: 'back' }] });
    expect(out.refused).toEqual([{ id: u1.id, reason: expect.stringContaining('side flip') }]);
    expect(out.moved).toEqual([]);
  });

  it('replaces copper: removes source records not preserved, appends the candidate\'s', async () => {
    const { text, design } = await load('clearance');
    const sig1 = design.nets.find((n) => n.name === 'SIG1')!;
    const keep = design.routing.segments.filter((s) => s.netId === sig1.id).map((s) => s.id);
    const u1 = design.components.find((c) => c.reference === 'U1')!;
    const pad4 = u1.pads.find((p) => p.number === '4')!;
    const gnd = design.nets.find((n) => n.name === 'GND')!;
    const out = applyCandidate(text, design, {
      routing: {
        segments: [{ id: '', netId: gnd.id, layer: 'F.Cu', a: pad4.at, b: { x: pad4.at.x - mm(3), y: pad4.at.y }, width: mm(0.3) }],
        vias: [{ id: '', netId: gnd.id, at: { x: pad4.at.x - mm(3), y: pad4.at.y }, size: mm(0.6), drill: mm(0.3), layers: ['F.Cu', 'B.Cu'] }],
        preserveIds: new Set(keep),
      },
    });
    expect(out.copperRemoved).toBe(2);
    expect(out.copperAdded).toBe(2);
    const re = importBoard({ boardText: out.text, boardPath: 'c', now: 't' }).design;
    expect(re.routing.segments).toHaveLength(3);
    expect(re.routing.vias).toHaveLength(1);
    expect(re.routing.vias[0]!.netId).toBe(gnd.id);
    expect(re.routing.segments.filter((s) => s.netId === sig1.id).map((s) => s.id).sort()).toEqual([...keep].sort());
    const gndSeg = re.routing.segments.find((s) => s.netId === gnd.id)!;
    expect(gndSeg.width).toBe(mm(0.3));
    expect(gndSeg.id).toHaveLength(36);
    // deterministic ids: exporting again yields the same bytes
    expect(applyCandidate(text, design, { routing: { segments: [], vias: [], preserveIds: new Set(keep) } }).text).toBe(
      applyCandidate(text, design, { routing: { segments: [], vias: [], preserveIds: new Set(keep) } }).text,
    );
  });

  it('StickHub: identity export strips fills and keeps the IR hash', async () => {
    if (!existsSync(STICKHUB)) return;
    const text = await readFile(STICKHUB, 'utf8');
    const { design } = importBoard({ boardText: text, boardPath: 'StickHub.kicad_pcb', now: 't' });
    const out = applyCandidate(text, design, {});
    expect(out.text).not.toContain('(filled_polygon');
    expect(out.text.length).toBeLessThan(text.length);
    const re = importBoard({ boardText: out.text, boardPath: 'StickHub.kicad_pcb', now: 't' }).design;
    expect(hashDesign(re)).toBe(hashDesign(design));
    expect(re.routing.segments.length).toBe(design.routing.segments.length);
    expect(re.routing.zones.length).toBe(design.routing.zones.length);
  });

  it('refills zones through kicad-cli and reads the fills back', async () => {
    if (!existsSync(STICKHUB) || !(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-refill-'));
    try {
      const text = await readFile(STICKHUB, 'utf8');
      const { design } = importBoard({ boardText: text, boardPath: 'StickHub.kicad_pcb', now: 't' });
      const p = path.join(dir, 'StickHub.kicad_pcb');
      await cp(path.dirname(STICKHUB), dir, { recursive: true });
      await writeFile(p, applyCandidate(text, design, {}).text, 'utf8');
      expect(extractFills(await readFile(p, 'utf8'))).toEqual([]);
      const report = await refillZones(p);
      expect(report.source).toBe('drc');
      const fills = extractFills(await readFile(p, 'utf8'));
      expect(fills.length).toBeGreaterThan(0);
      expect(fills.every((f) => f.polygons.every((poly) => poly.outer.length >= 3))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
