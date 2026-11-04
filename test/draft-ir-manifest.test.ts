import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { validateIntent, parseIntent } from '../src/kicad/draft/ir.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { bomSymbolDossier } from '../src/kicad/dossier.js';
import { parseManifest } from '../src/kicad/parts/manifest.js';
import { STAGES } from '../src/commands/create.js';

// structured-part-selection, create-pipeline delta "Stage 4 builds parts from
// the manifest": IR parts inherit the manifest's verified ids, disagreement
// and absence are findings, off-board entries are not drawn, and the dossier
// resolves recorded lib_ids exactly.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const DRAFT_FIXTURE = path.join(HERE, 'fixtures', 'draft');

const MANIFEST = {
  version: 1,
  parts: [
    { ref: 'J1', value: 'Conn_01x03', libId: 'CopperConn:Conn_01x03', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical', mpn: 'PH-3', group: 'Power' },
    { ref: 'U1', value: 'MCU8', libId: 'CopperMCU:MCU8', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', mpn: 'MCU8-SOIC', group: 'MCU' },
    { ref: 'R1', value: '10k', package: '0603', group: 'MCU' },
    { ref: 'R2', value: '10k', package: '0603', group: 'MCU' },
    { ref: 'C1', value: '100n', package: '0402', group: 'MCU' },
    { ref: 'BT1', value: '500mAh Li-Po', mpn: 'LP503035', offBoard: true, group: 'Power' },
  ],
};

async function fixtureRepo(manifest: object | null = MANIFEST) {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-irmanifest-'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  await cp(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
  if (manifest) await writeFile(path.join(repo, 'docs', 'parts.intent.json'), JSON.stringify(manifest));
  const docs = path.join(repo, 'docs');
  const intentPath = path.join(repo, 'schematic.intent.json');
  const intent = async () => JSON.parse(await readFile(intentPath, 'utf8'));
  const setIntent = (o: object) => writeFile(intentPath, JSON.stringify(o));
  const validate = async () => {
    const { intent: ir } = parseIntent(await readFile(intentPath, 'utf8'));
    return validateIntent(ir!, new SymbolSource(repo, [SYMLIB]), docs);
  };
  return { repo, docs, intent, setIntent, validate, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('validateIntent with a parts manifest', () => {
  it('passes the fixture intent, which agrees with the manifest', async () => {
    const r = await fixtureRepo();
    try {
      const res = await r.validate();
      expect(res.findings.map((f) => f.detail)).toEqual([]);
    } finally { await r.cleanup(); }
  });

  it('lets an IR part give its ref alone and inherits libId, value, footprint and group', async () => {
    const r = await fixtureRepo();
    try {
      const ir = await r.intent();
      ir.parts = ir.parts.map((p: { ref: string }) => ({ ref: p.ref }));
      await r.setIntent(ir);
      const res = await r.validate();
      expect(res.findings.map((f) => f.detail)).toEqual([]);
      const u1 = res.validated!.intent.parts.find((p) => p.ref === 'U1')!;
      expect(u1).toMatchObject({ libId: 'CopperMCU:MCU8', value: 'MCU8', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', group: 'MCU' });
      const r1 = res.validated!.intent.parts.find((p) => p.ref === 'R1')!;
      expect(r1).toMatchObject({ libId: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric', group: 'MCU' });
      expect(res.validated!.symbols.get('U1')?.pins).toHaveLength(8);
    } finally { await r.cleanup(); }
  });

  it('refuses a field that disagrees with the manifest, naming both', async () => {
    const r = await fixtureRepo();
    try {
      const ir = await r.intent();
      ir.parts.find((p: { ref: string }) => p.ref === 'U1').libId = 'CopperMCU:Other';
      ir.parts.find((p: { ref: string }) => p.ref === 'R1').value = '4k7';
      await r.setIntent(ir);
      const d = (await r.validate()).findings.map((f) => f.detail);
      expect(d).toContain('U1 differs from parts.intent.json: libId "CopperMCU:Other" vs "CopperMCU:MCU8" — the manifest is the decided part list; give the ref alone to inherit it, or change the manifest and run draft_bom');
      expect(d.some((x) => x.startsWith('R1 differs from parts.intent.json: value "4k7" vs "10k"'))).toBe(true);
    } finally { await r.cleanup(); }
  });

  it('refuses a ref the manifest lacks and an off-board entry that is drawn', async () => {
    const r = await fixtureRepo();
    try {
      const ir = await r.intent();
      ir.parts.push({ ref: 'U9', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MCU' });
      ir.parts.push({ ref: 'BT1' });
      await r.setIntent(ir);
      const d = (await r.validate()).findings.map((f) => f.detail);
      expect(d).toContain('U9 is not in parts.intent.json; add it there and run draft_bom, or drop it from the intent');
      expect(d).toContain('BT1 is off-board in parts.intent.json (no place on the board); drop it from the intent');
    } finally { await r.cleanup(); }
  });

  it('does not cross-check BOM.md when a manifest exists (BOM.md is its render)', async () => {
    const r = await fixtureRepo();
    try {
      await writeFile(path.join(r.docs, 'BOM.md'), '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 99k | x | y | stale |\n');
      expect((await r.validate()).findings).toEqual([]);
    } finally { await r.cleanup(); }
  });

  it('keeps the BOM.md cross-check without a manifest', async () => {
    const r = await fixtureRepo(null);
    try {
      await writeFile(path.join(r.docs, 'BOM.md'), '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 99k | Resistor_SMD:R_0603_1608Metric | y | stale |\n');
      const d = (await r.validate()).findings.map((f) => f.detail);
      expect(d.some((x) => x.includes("R1") && x.includes("BOM.md"))).toBe(true);
    } finally { await r.cleanup(); }
  });
});

describe('dossier with a parts manifest', () => {
  it('resolves recorded lib_ids exactly, omits passives and off-board parts, and flags a stale id', async () => {
    const m = parseManifest(JSON.stringify({ ...MANIFEST, parts: [...MANIFEST.parts, { ref: 'U2', value: 'Ghost', libId: 'CopperMCU:Ghost', footprint: 'x:y', mpn: 'GHOST-1', group: 'MCU' }] })).manifest!;
    const d = await bomSymbolDossier('irrelevant: the manifest is authoritative', [SYMLIB], { manifest: m });
    expect(d).toContain('- U1 (MCU8-SOIC): CopperMCU:MCU8 — 8 pin(s):');
    expect(d).toContain('- J1 (PH-3): CopperConn:Conn_01x03 — 3 pin(s):');
    expect(d).not.toContain('also installed');
    expect(d).not.toMatch(/\bR1\b|\bC1\b|\bBT1\b/);
    expect(d).toContain('- U2 (GHOST-1): CopperMCU:Ghost does NOT resolve on this machine');
  });
});

describe('stage-4 prompt contract', () => {
  it('points the schematic stage at the manifest for parts', () => {
    const prompt = STAGES.find((s) => s.name === 'schematic')!.prompt('brief', 'docs');
    expect(prompt).toContain('docs/parts.intent.json');
    expect(prompt).toMatch(/by "ref" alone/);
    expect(prompt).toMatch(/off-board entries out/);
  });
});
