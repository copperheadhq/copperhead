import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { draftSchematicToText } from '../src/kicad/draft/draft.js';
import { pinNets } from '../src/kicad/sexp.js';

/**
 * Multi-unit symbols place one unit per instance (#218).
 *
 * A symbol's units share symbol-space pin coordinates, so a single placed
 * instance overlays unrelated pins on one point and silently merges their
 * nets — the engine used to refuse these outright, which blocked 7 of 15 real
 * KiCad demo projects on ordinary parts (dual opamps, quad buffers, gang
 * jumpers). Now each unit becomes its own placement instance sharing the
 * part's refdes, the emitter writes `(unit N)` per instance, and net
 * endpoints keep plain package pin numbers.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

const draft = async (repo: string) =>
  draftSchematicToText({ repoRoot: repo, schematic: 'board.kicad_sch', symbolDirs: [SYMLIB] });

const writeIntent = async (repo: string, intent: unknown): Promise<void> => {
  await writeFile(path.join(repo, 'schematic.intent.json'), JSON.stringify(intent), 'utf8');
};

/** Both units of the DualBuf pack wired through their own resistors. */
const bothUnitsIntent = {
  version: 1,
  parts: [
    { ref: 'U1', libId: 'CopperStack:DualBuf', value: 'DualBuf', group: 'A' },
    { ref: 'R1', libId: 'Device:R', value: '1k', group: 'A' },
    { ref: 'R2', libId: 'Device:R', value: '2k', group: 'A' },
  ],
  nets: [
    { name: 'IN_A', pins: ['U1.1', 'R1.1'] },
    { name: 'OUT_A', pins: ['U1.2', 'R1.2'] },
    { name: 'IN_B', pins: ['U1.3', 'R2.1'] },
    { name: 'OUT_B', pins: ['U1.4', 'R2.2'] },
  ],
};

describe('multi-unit placement', () => {
  it('drafts both units as separate instances sharing the refdes', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-mu-both-'));
    try {
      await writeIntent(repo, bothUnitsIntent);
      const res = await draft(repo);
      expect(res.ok, res.ok ? '' : res.message).toBe(true);
      if (!res.ok) return;
      // two DualBuf instances, one per unit, both referenced U1
      expect([...res.text.matchAll(/\(lib_id "CopperStack:DualBuf"\)/g)]).toHaveLength(2);
      expect(res.text).toContain('(unit 1)');
      expect(res.text).toContain('(unit 2)');
      const refs = [...res.text.matchAll(/\(property "Reference" "U1"/g)];
      expect(refs).toHaveLength(2);
      // the shared lib symbol is embedded once
      expect([...res.text.matchAll(/^\t\t\(symbol "CopperStack:DualBuf"/gm)]).toHaveLength(1);
      // per-instance instance data carries the unit
      expect(res.text).toContain('(reference "U1") (unit 1)');
      expect(res.text).toContain('(reference "U1") (unit 2)');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('round-trips connectivity: every endpoint lands on its own net', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-mu-nets-'));
    try {
      await writeIntent(repo, bothUnitsIntent);
      const res = await draft(repo);
      expect(res.ok, res.ok ? '' : res.message).toBe(true);
      if (!res.ok) return;
      await mkdir(path.join(repo, 'out'), { recursive: true });
      const sch = path.join(repo, 'out', 'board.kicad_sch');
      await writeFile(sch, res.text, 'utf8');
      const nets = new Map((await pinNets(sch)).map((p) => [`${p.ref}.${p.pinNumber}`, p.net]));
      // unit pins resolve per instance: were the units overlaid (the old
      // hazard), U1.2 and U1.4 would share a point and fuse OUT_A into OUT_B
      expect(nets.get('U1.1')).toBe('IN_A');
      expect(nets.get('U1.2')).toBe('OUT_A');
      expect(nets.get('U1.3')).toBe('IN_B');
      expect(nets.get('U1.4')).toBe('OUT_B');
      expect(nets.get('R1.1')).toBe('IN_A');
      expect(nets.get('R2.2')).toBe('OUT_B');
      // and no phantom pins: the whole package is 4 pins, 2 per instance
      expect((await pinNets(sch)).filter((p) => p.ref === 'U1')).toHaveLength(4);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('is deterministic: the same intent emits identical bytes', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-mu-det-'));
    try {
      await writeIntent(repo, bothUnitsIntent);
      const a = await draft(repo);
      const b = await draft(repo);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.text).toBe(b.text);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('wires a common (unit-0) pin at every placed appearance', async () => {
    // The classic gate-pack shape: power pins live in the `_0_*` common unit
    // (an LM358's V+/V-), which KiCad draws on every placed unit. Each
    // appearance is wired to the pin's one net, so the appearances stay one
    // electrical point and no drawn pin end dangles.
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-mu-common-'));
    try {
      await writeIntent(repo, {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperStack:CommonPinPack', value: 'CommonPinPack', group: 'A' },
          { ref: 'R1', libId: 'Device:R', value: '1k', group: 'A' },
          { ref: 'R2', libId: 'Device:R', value: '2k', group: 'A' },
          { ref: 'R3', libId: 'Device:R', value: '3k', group: 'A' },
        ],
        nets: [
          { name: 'N1', pins: ['U1.1', 'R1.1'] },
          { name: 'N2', pins: ['U1.2', 'R2.1'] },
          { name: 'N3', pins: ['U1.3', 'R3.1'] },
          { name: 'N4', pins: ['U1.4', 'R2.2'] },
          { name: 'GND', pins: ['U1.5', 'R3.2'], kind: 'ground' as const },
        ],
      });
      const res = await draft(repo);
      expect(res.ok, res.ok ? '' : res.message).toBe(true);
      if (!res.ok) return;
      await mkdir(path.join(repo, 'out'), { recursive: true });
      const sch = path.join(repo, 'out', 'board.kicad_sch');
      await writeFile(sch, res.text, 'utf8');
      const rows = await pinNets(sch);
      // pin 5 is drawn once per placed unit; both appearances carry GND
      const pin5 = rows.filter((p) => p.ref === 'U1' && p.pinNumber === '5');
      expect(pin5).toHaveLength(2);
      expect(pin5.map((p) => p.net)).toEqual(['GND', 'GND']);
      // and the units' own pins still land on their own nets
      const nets = new Map(rows.map((p) => [`${p.ref}.${p.pinNumber}`, p.net]));
      expect(nets.get('U1.1')).toBe('N1');
      expect(nets.get('U1.4')).toBe('N4');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
