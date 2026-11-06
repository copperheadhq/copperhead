import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { renderManifest, manifestDrift } from '../src/kicad/parts/render.js';
import { parseManifest } from '../src/kicad/parts/manifest.js';
import { parseBomTable, bomFootprintRows, bomFootprintId } from '../src/memory/bom-table.js';
import { parseBom, buildExport } from '../src/kicad/bom-export.js';
import { checkDrift } from '../src/memory/drift.js';
import { runCheck } from '../src/commands/check.js';
import { syncVerify } from '../src/commands/sync.js';

// structured-part-selection: BOM.md is the manifest's render (docs-memory
// delta). Existing readers must see the same rows a hand-written table gives,
// the render must be byte-stable, and a hand edit to the rendered file is
// drift against the manifest.

const MANIFEST = JSON.stringify({
  version: 1,
  parts: [
    { ref: 'U1', value: 'MCU8', libId: 'CopperMCU:MCU8', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', mpn: 'MCU8-SOIC', group: 'MCU', rationale: 'controller | 8 pins' },
    { ref: 'R1', value: '10k', package: '0603', group: 'MCU', mpn: 'RC0603FR-0710KL', verified: true },
    { ref: 'BT1', value: '500mAh Li-Po', mpn: 'LP503035', offBoard: true, group: 'Power', rationale: 'bare leads' },
  ],
  substitutions: [{ ref: 'U1', wanted: 'DRV8701', chosen: 'MCU8', reason: 'no installed symbol' }],
});

function manifest() {
  const { manifest: m, findings } = parseManifest(MANIFEST);
  if (!m) throw new Error(findings.map((f) => f.detail).join('; '));
  return m;
}

describe('renderManifest', () => {
  it('renders the canonical columns plus Symbol, flags, off-board and substitutions', () => {
    const md = renderManifest(manifest());
    expect(md).toContain('rendered from parts.intent.json');
    expect(md).toContain('| Refdes | Value | Footprint | MPN | Rationale | Symbol |');
    expect(md).toContain('| U1 | MCU8 | Package_SO:SOIC-8_3.9x4.9mm_P1.27mm | MCU8-SOIC (UNVERIFIED) | controller \\| 8 pins | CopperMCU:MCU8 |');
    expect(md).toContain('| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL |  | Device:R |');
    expect(md).toContain('| BT1 | 500mAh Li-Po | (off-board) | LP503035 (UNVERIFIED) | bare leads |  |');
    expect(md).toContain('## Substitutions');
    expect(md).toContain('| U1 | DRV8701 | MCU8 | no installed symbol |');
  });

  it('is byte-identical on repeated render', () => {
    expect(renderManifest(manifest())).toBe(renderManifest(manifest()));
  });

  it('is read by the existing BOM readers with the same rows', () => {
    const md = renderManifest(manifest());
    const rows = parseBomTable(md);
    expect(rows.map((r) => r.refdes)).toEqual(['U1', 'R1', 'BT1']);
    expect(rows[0]).toMatchObject({ value: 'MCU8', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', flags: ['UNVERIFIED'] });
    expect(rows[1]).toMatchObject({ value: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric', mpn: 'RC0603FR-0710KL', flags: [] });
    expect(rows[2]).toMatchObject({ footprint: '(off-board)', offBoard: true, flags: ['UNVERIFIED'] });
    // the substitutions table is headed Part, not Refdes, so it is not a BOM row
    expect(rows).toHaveLength(3);
    expect(bomFootprintRows(md)).toEqual([
      { refdes: 'U1', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm' },
      { refdes: 'R1', footprint: 'Resistor_SMD:R_0603_1608Metric' },
      { refdes: 'BT1', footprint: '', offBoard: true },
    ]);
    expect(bomFootprintId('(off-board)')).toBe('');
    expect(bomFootprintId('`(off-board)`')).toBe('');
  });
});

describe('manifestDrift', () => {
  async function repo(bom: string | null): Promise<{ root: string; docs: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(path.join(tmpdir(), 'copperhead-render-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs);
    await writeFile(path.join(docs, 'parts.intent.json'), MANIFEST);
    if (bom !== null) await writeFile(path.join(docs, 'BOM.md'), bom);
    // a zero-symbol schematic: checkDrift's bootstrap carve-out applies, so
    // only the manifest comparison speaks
    await writeFile(path.join(root, 'empty.kicad_sch'), '(kicad_sch (version 20231120) (generator "test"))\n');
    return { root, docs, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  it('is silent when BOM.md is the render, line endings aside', async () => {
    const r = await repo(renderManifest(manifest()).replace(/\n/g, '\r\n'));
    try {
      expect(await manifestDrift(r.docs)).toEqual([]);
      expect(await checkDrift(r.root, 'docs', 'empty.kicad_sch')).toEqual([]);
    } finally {
      await r.cleanup();
    }
  });

  it('names the refdes and cell a hand edit changed', async () => {
    const r = await repo(renderManifest(manifest()).replace('| R1 | 10k |', '| R1 | 4k7 |'));
    try {
      const d = await checkDrift(r.root, 'docs', 'empty.kicad_sch');
      expect(d).toEqual([{ doc: 'BOM.md', claim: 'R1 value 4k7', actual: 'R1 value 10k in parts.intent.json' }]);
    } finally {
      await r.cleanup();
    }
  });

  it('reports a missing BOM.md, a deleted row, and a prose-only edit', async () => {
    const missing = await repo(null);
    try {
      expect((await manifestDrift(missing.docs))[0]).toMatchObject({ doc: 'BOM.md', claim: 'absent' });
    } finally {
      await missing.cleanup();
    }
    const deleted = await repo(renderManifest(manifest()).replace(/\| BT1 .*\n/, ''));
    try {
      expect(await manifestDrift(deleted.docs)).toEqual([{ doc: 'BOM.md', claim: 'BT1 absent', actual: 'BT1 (500mAh Li-Po) in parts.intent.json' }]);
    } finally {
      await deleted.cleanup();
    }
    const prose = await repo(`${renderManifest(manifest())}\nhand-written note\n`);
    try {
      expect((await manifestDrift(prose.docs))[0]!.actual).toMatch(/outside the table/);
    } finally {
      await prose.cleanup();
    }
  });

  it('is empty with no manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'copperhead-render-'));
    try {
      expect(await manifestDrift(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the render through the supplier export (AC-19.10)', () => {
  // `copperhead export bom` reads BOM.md. The render adds a Substitutions
  // table, an "(UNVERIFIED)" annotation on the MPN, an "(off-board)" footprint
  // and a "(no part)" MPN; none of them may reach a supplier file as a part.
  const WITH_HOLE = JSON.stringify({
    ...JSON.parse(MANIFEST),
    parts: [...JSON.parse(MANIFEST).parts, { ref: 'H1', value: 'MountingHole_M3', libId: 'CopperConn:Conn_01x03', footprint: 'MountingHole:MountingHole_3.2mm_M3', group: 'Power', noPart: true }],
  });
  const md = renderManifest(parseManifest(WITH_HOLE).manifest!);
  const opts = { boards: 1, spares: 10, includeUnverified: true };

  it('renders a board feature with the no-part marker, read back as NO_PART', () => {
    expect(md).toContain('| H1 | MountingHole_M3 | MountingHole:MountingHole_3.2mm_M3 | (no part) |  | CopperConn:Conn_01x03 |');
    const h1 = parseBomTable(md).find((r) => r.refdes === 'H1')!;
    expect(h1).toMatchObject({ noPart: true, flags: ['NO_PART'] });
  });

  it('reads only the parts table: the substitutions are not order lines', () => {
    expect(parseBom(md).map((r) => r.refdes)).toEqual(['U1', 'R1', 'BT1', 'H1']);
  });

  it('exports the bare MPN, with the verification flag carried beside it', () => {
    const u1 = parseBom(md).find((r) => r.refdes === 'U1')!;
    expect(u1).toMatchObject({ mpn: 'MCU8-SOIC', unverified: true, hasMpn: true });
    const { csv, warnings } = buildExport(parseBom(md), 'digikey', opts);
    expect(csv).toContain('MCU8-SOIC,,2,U1');
    expect(csv).not.toContain('UNVERIFIED');
    expect(warnings.join('\n')).toContain('INCLUDED but UNVERIFIED (--include-unverified): U1 (MCU8-SOIC)');
  });

  it('keeps an off-board part on a distributor cart and off the assembly BOM', () => {
    const rows = parseBom(md);
    expect(rows.find((r) => r.refdes === 'BT1')).toMatchObject({ offBoard: true, footprint: '', mpn: 'LP503035' });
    expect(buildExport(rows, 'digikey', opts).csv).toContain('LP503035,,2,BT1');
    const jlc = buildExport(rows, 'jlcpcb', opts);
    expect(jlc.csv).not.toContain('BT1');
    expect(jlc.csv).not.toContain('off-board');
    expect(jlc.excluded.find((e) => e.row.refdes === 'BT1')?.reason).toBe('off-board');
    expect(jlc.warnings.join('\n')).toMatch(/EXCLUDED \(off-board\): BT1/);
  });

  it('leaves a board feature off every order, without a warning', () => {
    for (const supplier of ['jlcpcb', 'digikey', 'mouser'] as const) {
      const out = buildExport(parseBom(md), supplier, opts);
      expect(out.csv).not.toContain('H1');
      expect(out.csv).not.toContain('no part');
      expect(out.excluded.find((e) => e.row.refdes === 'H1')?.reason).toBe('board feature');
      expect(out.warnings.join('\n')).not.toContain('H1');
    }
  });
});

describe('a manifest file that does not parse (AC-19.11)', () => {
  it('is reported as drift, not treated as no manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'copperhead-render-'));
    try {
      const docs = path.join(root, 'docs');
      await mkdir(docs);
      await writeFile(path.join(docs, 'BOM.md'), renderManifest(manifest()));
      await writeFile(path.join(root, 'empty.kicad_sch'), '(kicad_sch (version 20231120) (generator "test"))\n');
      // truncated mid-write
      await writeFile(path.join(docs, 'parts.intent.json'), MANIFEST.slice(0, 80));
      const drift = await manifestDrift(docs);
      expect(drift).toHaveLength(1);
      expect(drift[0]).toMatchObject({ doc: 'parts.intent.json', claim: 'is a valid parts manifest' });
      expect(drift[0]!.actual).toMatch(/not valid JSON/);
      expect(await checkDrift(root, 'docs', 'empty.kicad_sch')).toEqual(drift);
      // a wrong field type is the same story
      await writeFile(path.join(docs, 'parts.intent.json'), MANIFEST.replace('"verified":true', '"verified":"yes"'));
      expect((await manifestDrift(docs))[0]!.actual).toMatch(/R1: "verified" must be true or false/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('manifest drift with no schematic configured (AC-19.14)', () => {
  async function docsOnly(): Promise<{ root: string; docs: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(path.join(tmpdir(), 'copperhead-docsonly-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs);
    return { root, docs, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  it('check and sync stay clean with no manifest, or with a manifest and its render', async () => {
    const { root, docs, cleanup } = await docsOnly();
    try {
      expect((await runCheck(root, () => {})).drift).toMatchObject({ ok: true, mismatches: [] });
      await writeFile(path.join(docs, 'parts.intent.json'), MANIFEST);
      await writeFile(path.join(docs, 'BOM.md'), renderManifest(manifest()));
      const res = await runCheck(root, () => {});
      expect(res.drift).toMatchObject({ ok: true, mismatches: [] });
      expect(res.ok).toBe(true);
      expect((await syncVerify(root)).resolvable.filter((i) => i.kind === 'drift')).toEqual([]);
    } finally { await cleanup(); }
  });

  it('check fails and sync lists it when the manifest does not parse, the BOM is missing, or the render was hand-edited', async () => {
    const { root, docs, cleanup } = await docsOnly();
    try {
      const lines: string[] = [];
      // manifest with no BOM.md
      await writeFile(path.join(docs, 'parts.intent.json'), MANIFEST);
      let res = await runCheck(root, (s) => lines.push(s));
      expect(res.ok).toBe(false);
      expect(res.drift.mismatches[0]).toMatchObject({ doc: 'BOM.md', claim: 'absent' });
      expect(lines.join('\n')).toMatch(/drift: BOM\.md claims "absent"/);
      // hand-edited render
      await writeFile(path.join(docs, 'BOM.md'), renderManifest(manifest()).replace('| R1 | 10k |', '| R1 | 47k |'));
      res = await runCheck(root, () => {});
      expect(res.ok).toBe(false);
      expect(res.drift.mismatches.map((m) => m.doc)).toContain('BOM.md');
      // truncated manifest
      await writeFile(path.join(docs, 'parts.intent.json'), MANIFEST.slice(0, 80));
      res = await runCheck(root, () => {});
      expect(res.ok).toBe(false);
      expect(res.drift.mismatches[0]).toMatchObject({ doc: 'parts.intent.json', claim: 'is a valid parts manifest' });
      const drift = (await syncVerify(root)).resolvable.filter((i) => i.kind === 'drift');
      expect(drift).toHaveLength(1);
      expect(drift[0]).toMatchObject({ doc: 'parts.intent.json' });
      expect(drift[0]!.resolution).toMatch(/draft_bom/);
    } finally { await cleanup(); }
  });
});
