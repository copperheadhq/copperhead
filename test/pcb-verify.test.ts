/**
 * Verification (RFC 11 §10, AC-17.6, AC-17.7): the golden boards raise the
 * diagnostics their expected.json names, with the entity references named,
 * and nothing else at error severity; gates agree with the expected status;
 * a real routed board (StickHub, after a live zone refill) verifies clean.
 */
import { describe, it, expect } from 'vitest';
import { readFile, readdir, writeFile, mkdtemp, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { applyCandidate } from '../src/pcb/ir/kicad/export.js';
import { refillZones, extractFills } from '../src/pcb/ir/kicad/zones.js';
import { verifyDesign } from '../src/pcb/verify/index.js';
import { loadConstraints } from '../src/pcb/intent/load.js';
import { JLCPCB_2LAYER } from '../src/pcb/verify/profiles/index.js';
import { runDrc } from '../src/kicad/cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures', 'microboards');
const STICKHUB = '/usr/share/kicad/demos/stickhub/StickHub.kicad_pcb';
const IMPLEMENTED = /^(geom|conn|drc|preflight|intent)\./;

interface Expected {
  status: string;
  diagnostics: { code: string; entityReferences: string[] }[];
  drc: { errorTypes: string[]; consequential?: string[]; unconnected: number };
}

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

const cases = (await readdir(GOLDEN, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();

describe('profile', () => {
  it('the typed profile equals the vendored JSON', async () => {
    const json = JSON.parse(await readFile(path.join(HERE, '..', 'src', 'pcb', 'verify', 'profiles', 'jlcpcb-2layer.json'), 'utf8'));
    expect(JLCPCB_2LAYER).toEqual(json);
  });
});

describe('golden microboards verify as expected', () => {
  it.each(cases)('%s', async (name) => {
    const dir = path.join(GOLDEN, name);
    const exp = JSON.parse(await readFile(path.join(dir, 'expected.json'), 'utf8')) as Expected;
    const pcb = path.join(dir, 'board.kicad_pcb');
    const { design } = importBoard({ boardText: await readFile(pcb, 'utf8'), boardPath: pcb, projectText: await readFile(path.join(dir, 'board.kicad_pro'), 'utf8'), now: 't' });
    const kicad = await haveKicad();
    const drc = kicad ? await runDrc(pcb) : undefined;
    const { registry } = await loadConstraints(design, pcb);
    const v = verifyDesign({ design, ...(drc ? { drc } : {}), constraints: registry });
    const codes = new Set(v.diagnostics.map((d) => d.code));
    for (const e of exp.diagnostics) {
      if (!IMPLEMENTED.test(e.code)) continue;
      if (e.code.startsWith('drc.') && !kicad) continue;
      expect(codes, `${name}: expected ${e.code}`).toContain(e.code);
      const hit = v.diagnostics.filter((d) => d.code === e.code);
      for (const ref of e.entityReferences) expect(hit.some((d) => d.entityReferences.includes(ref)), `${name}: ${e.code} should name ${ref}`).toBe(true);
    }
    // no unexpected error-severity harness codes (KiCad consequential types excepted)
    const expectedCodes = new Set(exp.diagnostics.map((d) => d.code));
    const allowedDrc = new Set([...exp.drc.errorTypes, ...(exp.drc.consequential ?? [])].map((t) => `drc.${t}`));
    for (const d of v.diagnostics) {
      if (d.severity !== 'error') continue;
      if (d.code.startsWith('drc.')) {
        expect(allowedDrc, `${name}: unexpected ${d.code}`).toContain(d.code);
        continue;
      }
      expect(expectedCodes.has(d.code) || (d.code === 'conn.open' && expectedCodes.has('conn.short')), `${name}: unexpected ${d.code}: ${d.message}`).toBe(true);
    }
    // completion: KiCad and the connectivity checker agree on what is owed
    if (drc) expect(v.metrics.unrouted_count, `${name}: unrouted`).toBe(exp.drc.unconnected);
    // gates follow the expected status for the implemented families
    const implementedFailure = exp.diagnostics.some((d) => IMPLEMENTED.test(d.code) && d.code !== 'conn.unrouted' && !(d.code.startsWith('drc.') && !kicad));
    if (exp.status === 'PARTIAL') {
      // PARTIAL is a placed board: the placement gate holds; the routing gate holds unless the seeded fault is a routing one
      expect(v.gates.placement.passed, `${name}: placement gate should pass`).toBe(true);
      const routingFault = exp.diagnostics.some((d) => /^(drc\.|intent\.routing\.|conn\.short|geom\.via-layers)/.test(d.code) && !(d.code.startsWith('drc.') && !kicad));
      if (!routingFault) expect(v.gates.routing.passed, `${name}: routing gate should pass`).toBe(true);
      else expect(v.gates.routing.passed, `${name}: routing gate should fail`).toBe(false);
    } else if (implementedFailure) {
      expect(v.gates.preflight.passed && v.gates.placement.passed && v.gates.routing.passed, `${name}: a gate should fail`).toBe(false);
    }
  }, 120_000);
});

describe('courtyard overlap without a courtyard', () => {
  it('a footprint with no courtyard takes no part in courtyard overlap (as in KiCad DRC); pre-flight warns instead', async () => {
    const pcb = path.join(GOLDEN, 'overlap', 'board.kicad_pcb');
    const text = await readFile(pcb, 'utf8');
    const projectText = await readFile(path.join(GOLDEN, 'overlap', 'board.kicad_pro'), 'utf8');
    const i = text.indexOf('(footprint "Capacitor_SMD:C_0603_1608Metric"');
    const j = text.indexOf('\n\t(footprint', i + 1);
    const block = text.slice(i, j > 0 ? j : undefined);
    // C1 without its courtyard, and 0.55 mm further into U1 so its pads (not only the courtyard it no longer has) reach U1's courtyard
    const noCourtyard = block.replace(/\n\t\t\(fp_rect\n\t\t\t\(start -1\.48 -0\.73\)[\s\S]*?\(layer "F\.CrtYd"\)\n\t\t\)/, '').replace('(at 119.05 112)', '(at 118.5 112)');
    expect(noCourtyard).not.toContain('F.CrtYd');
    expect(noCourtyard).toContain('(at 118.5 112)');
    const profile = JLCPCB_2LAYER;
    const verify = (t: string) => verifyDesign({ design: importBoard({ boardText: t, boardPath: pcb, projectText, now: 't' }).design, profile }).diagnostics;
    expect(verify(text).filter((d) => d.code === 'geom.courtyard-overlap')).toHaveLength(1);
    const without = verify(text.replace(block, noCourtyard));
    expect(without.filter((d) => d.code === 'geom.courtyard-overlap')).toEqual([]);
    expect(without.some((d) => d.code === 'preflight.courtyard' && d.entityReferences.includes('C1'))).toBe(true);
  });
});

describe('a real routed board verifies clean', () => {
  it('StickHub after a live zone refill: no shorts, no opens, completion 1.0', async () => {
    if (!existsSync(STICKHUB) || !(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-verify-'));
    try {
      await cp(path.dirname(STICKHUB), dir, { recursive: true });
      const p = path.join(dir, 'StickHub.kicad_pcb');
      const text = await readFile(STICKHUB, 'utf8');
      const { design: original } = importBoard({ boardText: text, boardPath: p, now: 't' });
      await writeFile(p, applyCandidate(text, original, {}).text, 'utf8');
      const drc = await refillZones(p);
      const refilled = await readFile(p, 'utf8');
      const { design } = importBoard({ boardText: refilled, boardPath: p, projectText: await readFile(path.join(dir, 'StickHub.kicad_pro'), 'utf8'), now: 't' });
      const fills = extractFills(refilled);
      expect(fills.length).toBeGreaterThan(0);
      const v = verifyDesign({ design, fills, drc });
      const errors = v.diagnostics.filter((d) => d.severity === 'error' && !d.code.startsWith('drc.'));
      expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
      expect(v.metrics.unrouted_count).toBe(0);
      expect(v.metrics.completion_rate).toBe(1);
      expect(v.metrics.shorts).toBe(0);
      expect(v.disagreements).toEqual([]);
      expect(v.gates.routing.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('IR renderer', () => {
  it('draws the board, copper, and numbered diagnostics with a legend', async () => {
    const { renderSvg } = await import('../src/pcb/ir/svg.js');
    const pcb = path.join(GOLDEN, 'short', 'board.kicad_pcb');
    const { design } = importBoard({ boardText: await readFile(pcb, 'utf8'), boardPath: pcb, now: 't' });
    const v = verifyDesign({ design });
    const svg = renderSvg(design, { diagnostics: v.diagnostics, title: 'short' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('conn.short');
    expect((svg.match(/<line /g) ?? []).length).toBe(design.routing.segments.length);
    expect(svg).toContain('>1</text>');
  });
});

describe('pre-flight annular ring', () => {
  it('measures a slotted hole per axis and tolerates imperial rounding on a round one', async () => {
    const p = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
    const { design } = importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, now: 't' });
    const j1 = design.components.find((c) => c.reference === 'J1')!;
    const pad = j1.pads.find((x) => x.type === 'thru_hole')!;
    // barrel-jack style: 3.5 x 3.5 pad around a 1 x 3 slot; d carries the slot's long side, which is not the ring
    pad.size = { w: 3_500_000, h: 3_500_000 };
    pad.drill = { d: 3_000_000, slot: { w: 1_000_000, h: 3_000_000 } };
    expect(verifyDesign({ design }).diagnostics.filter((d) => d.code === 'preflight.annular' && d.entityReferences[0] === `J1.${pad.number}`)).toEqual([]);
    // 0.0354 in pad on a 0.6 mm drill: 149.58 µm ring against a 150 µm minimum
    pad.size = { w: 899_160, h: 1_501_140 };
    pad.drill = { d: 600_000 };
    expect(verifyDesign({ design }).diagnostics.filter((d) => d.code === 'preflight.annular' && d.entityReferences[0] === `J1.${pad.number}`)).toEqual([]);
    pad.drill = { d: 620_000 };
    expect(verifyDesign({ design }).diagnostics.filter((d) => d.code === 'preflight.annular' && d.entityReferences[0] === `J1.${pad.number}`)).toHaveLength(1);
  });
});
