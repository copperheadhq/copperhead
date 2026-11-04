import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { renderManifest, manifestDrift } from '../src/kicad/parts/render.js';
import { parseManifest } from '../src/kicad/parts/manifest.js';
import { parseBomTable, bomFootprintRows, bomFootprintId } from '../src/memory/bom-table.js';
import { checkDrift } from '../src/memory/drift.js';

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
