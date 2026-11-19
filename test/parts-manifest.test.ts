import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseManifest, MANIFEST_VERSION } from '../src/kicad/parts/manifest.js';
import { passiveDefault, allPassiveFootprints, isPassivePrefix } from '../src/kicad/parts/passives.js';
import { validatePartsManifest, formatManifestFindings, subsystemHeadings } from '../src/kicad/parts/validate.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { FootprintResolver, footprintSearchDirs } from '../src/kicad/footprints.js';
import { symbolSearchDirs, resolveLibrarySymbol } from '../src/kicad/symlib.js';

// structured-part-selection: the parts manifest is the stage-3 artifact, and
// the validator is the one function behind draft_bom, the completion
// predicate and the finish gate (design D2). Fixture symbol library, fixture
// stock footprints in a temp dir, no kicad-cli.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

const SUBSYSTEMS = '# Subsystems\n\n## Power\n\nrail\n\n## MCU\n\ncore\n\n## Overview\n\nprose only\n';

function mod(name: string, pads: string[]): string {
  return `(footprint "${name}" (version 20240108) (generator "test") (layer "F.Cu")\n${pads
    .map((p) => `  (pad "${p}" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))`)
    .join('\n')}\n)\n`;
}

let stock: string;
let repo: string;
let footprints: FootprintResolver;
let symbols: SymbolSource;

beforeAll(async () => {
  stock = await mkdtemp(path.join(tmpdir(), 'copperhead-stockfp-'));
  const libs: Record<string, Record<string, string[]>> = {
    Resistor_SMD: { R_0603_1608Metric: ['1', '2'], R_0402_1005Metric: ['1', '2'] },
    Capacitor_SMD: { C_0402_1005Metric: ['1', '2'], C_0603_1608Metric: ['1', '2'] },
    Package_SO: {
      'SOIC-8_3.9x4.9mm_P1.27mm': ['1', '2', '3', '4', '5', '6', '7', '8'],
      'SOIC-14_3.9x8.7mm_P1.27mm': [...Array(14)].map((_, i) => String(i + 1)),
      'SOIC-6_3.9x4.9mm_P1.27mm': ['1', '2', '3', '4', '5', '6'],
    },
    'Connector_PinHeader_2.54mm': { 'PinHeader_1x03_P2.54mm_Vertical': ['1', '2', '3'] },
  };
  for (const [lib, mods] of Object.entries(libs)) {
    const dir = path.join(stock, `${lib}.pretty`);
    await mkdir(dir, { recursive: true });
    for (const [name, pads] of Object.entries(mods)) await writeFile(path.join(dir, `${name}.kicad_mod`), mod(name, pads));
  }
  repo = await mkdtemp(path.join(tmpdir(), 'copperhead-manifest-'));
  footprints = await FootprintResolver.create({ projectDir: repo, stockDirs: [stock], global: false, kicadMajor: null, env: {} });
  symbols = new SymbolSource(repo, [SYMLIB]);
});

afterAll(async () => {
  await rm(stock, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

const U1 = { ref: 'U1', value: 'MCU8', libId: 'CopperMCU:MCU8', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', mpn: 'MCU8-SOIC', group: 'MCU', rationale: 'controller' };
const J1 = { ref: 'J1', value: 'Conn_01x03', libId: 'CopperConn:Conn_01x03', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical', mpn: 'PH-3', group: 'Power' };
const R1 = { ref: 'R1', value: '10k', package: '0603', group: 'MCU' };
const C1 = { ref: 'C1', value: '100n', package: '0402', group: 'MCU' };

function manifest(parts: object[], extra: object = {}): string {
  return JSON.stringify({ version: MANIFEST_VERSION, parts, ...extra });
}

async function validate(json: string, subsystems: string | null = SUBSYSTEMS) {
  const { manifest: m, findings } = parseManifest(json);
  if (!m) throw new Error(`shape findings: ${findings.map((f) => f.detail).join('; ')}`);
  return validatePartsManifest(m, { symbols, footprints, subsystemsMd: subsystems });
}

describe('parseManifest (shape)', () => {
  it('refuses invalid JSON, a wrong version, and a non-array parts', () => {
    expect(parseManifest('{').manifest).toBeNull();
    expect(parseManifest('{').findings[0]!.detail).toMatch(/not valid JSON/);
    expect(parseManifest('{"version":2,"parts":[]}').findings[0]!.detail).toMatch(/unsupported manifest version 2/);
    expect(parseManifest('{"version":1,"parts":{}}').findings[0]!.detail).toMatch(/"parts" must be an array/);
  });

  it('refuses grouped and duplicate refdes, naming the entry', () => {
    const r = parseManifest(manifest([{ ref: 'C5-C8', value: '100n' }, { ref: 'R1', value: '1k' }, { ref: 'R1', value: '2k' }, { ref: 'R1, R2', value: '1k' }]));
    expect(r.manifest).toBeNull();
    const details = r.findings.map((f) => f.detail);
    expect(details.some((d) => d.startsWith('C5-C8: one entry per refdes'))).toBe(true);
    expect(details).toContain('duplicate refdes R1');
    expect(details.some((d) => d.startsWith('R1, R2: one entry per refdes'))).toBe(true);
  });

  it('refuses wrong field types with the field named', () => {
    const r = parseManifest(manifest([{ ref: 'U1', value: 'X', group: 5 }, { ref: 'U2', value: 'Y', offBoard: 'yes' }]));
    expect(r.findings.map((f) => f.detail)).toEqual([
      'U1: "group" must be a string, got 5',
      'U2: "offBoard" must be true or false, got "yes"',
    ]);
  });

  it('requires a reason on every substitution', () => {
    const r = parseManifest(manifest([U1], { substitutions: [{ ref: 'U1', wanted: 'DRV8701', chosen: 'MCU8' }] }));
    expect(r.manifest).toBeNull();
    expect(r.findings[0]!.detail).toMatch(/substitution needs a non-empty "reason"/);
  });

  it('trims and keeps optional fields, dropping empty ones', () => {
    const r = parseManifest(manifest([{ ref: ' R1 ', value: ' 10k ', package: '0603', mpn: '', verified: true }]));
    expect(r.manifest?.parts[0]).toEqual({ ref: 'R1', value: '10k', package: '0603', verified: true });
  });
});

describe('passive table', () => {
  it('expands the common chips and through-hole packages', () => {
    expect(passiveDefault('R', '0603')).toEqual({ libId: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric' });
    expect(passiveDefault('C', '0402')).toEqual({ libId: 'Device:C', footprint: 'Capacitor_SMD:C_0402_1005Metric' });
    expect(passiveDefault('D', 'SOD123')).toEqual({ libId: 'Device:D', footprint: 'Diode_SMD:D_SOD-123' });
    expect(passiveDefault('LED', '3mm')).toEqual({ libId: 'Device:LED', footprint: 'LED_THT:LED_D3.0mm' });
    expect(passiveDefault('led', '0805 metric')?.footprint).toBe('LED_SMD:LED_0805_2012Metric');
    expect(passiveDefault('R', '0603 Metric')?.footprint).toBe('Resistor_SMD:R_0603_1608Metric');
  });

  it('returns null for an unknown prefix or package', () => {
    expect(passiveDefault('U', '0603')).toBeNull();
    expect(passiveDefault('R', 'QFN')).toBeNull();
    expect(isPassivePrefix('U')).toBe(false);
    expect(isPassivePrefix('fb')).toBe(true);
  });

  it('emits only footprint ids and symbols installed in the stock libraries (skipped without KiCad)', async () => {
    const fpDirs = await footprintSearchDirs();
    const symDirs = await symbolSearchDirs();
    if (!fpDirs.length || !symDirs.length) return;
    const resolver = await FootprintResolver.create({ projectDir: tmpdir(), stockDirs: fpDirs, global: false, kicadMajor: null, env: {} });
    for (const id of allPassiveFootprints()) {
      const r = await resolver.resolve(id);
      expect(r.ok, id).toBe(true);
    }
    for (const libId of ['Device:R', 'Device:C', 'Device:C_Polarized', 'Device:L', 'Device:FerriteBead', 'Device:D', 'Device:LED', 'Device:Fuse', 'Device:Crystal', 'Device:Crystal_GND24', 'Switch:SW_Push', 'Connector:TestPoint']) {
      expect((await resolveLibrarySymbol(libId, symDirs)).status, libId).toBe('ok');
    }
  });
});

describe('validatePartsManifest', () => {
  it('accepts a clean manifest and fills passive ids from the package', async () => {
    const v = await validate(manifest([U1, J1, R1, C1]));
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.stops).toEqual([]);
    const r1 = v.parts.find((p) => p.ref === 'R1')!;
    expect(r1.libId).toBe('Device:R');
    expect(r1.footprint).toBe('Resistor_SMD:R_0603_1608Metric');
    expect(r1.symbol?.pins.map((p) => p.number).sort()).toEqual(['1', '2']);
    expect(v.parts.find((p) => p.ref === 'U1')!.symbol?.pins).toHaveLength(8);
    // Overview has no parts: reported as a note, never a finding
    expect(v.emptyGroups).toEqual(['Overview']);
    expect(v.warnings.some((w) => w.includes('Overview'))).toBe(true);
  });

  it('refuses a description in value and names rationale as the home for prose', async () => {
    const v = await validate(manifest([{ ...R1, value: '1S Li-Po cell, 500 mAh, bare leads' }, U1, J1]));
    expect(v.findings.map((f) => f.detail)).toEqual(['R1: "value" reads as a description ("1S Li-Po cell, 500 mAh, bare leads"); keep the component value there and move the prose to "rationale"']);
  });

  it('checks groups both ways against SUBSYSTEMS.md', async () => {
    const v = await validate(manifest([{ ...U1, group: 'Radio' }, { ...R1, group: undefined }, J1]));
    const d = v.findings.map((f) => f.detail);
    expect(d).toContain('U1: group "Radio" is not a SUBSYSTEMS.md heading; available: Power, MCU, Overview');
    expect(d.some((x) => x.startsWith('R1: no "group"'))).toBe(true);
    expect(v.emptyGroups).toEqual(['MCU', 'Overview']);
  });

  it('skips group checks when SUBSYSTEMS.md is absent but still requires a group', async () => {
    const v = await validate(manifest([{ ...U1, group: 'Anything' }, { ...R1, group: undefined }]), null);
    expect(v.findings.map((f) => f.detail)).toEqual(['R1: no "group"; name the SUBSYSTEMS.md heading this part belongs to']);
    expect(v.emptyGroups).toBeNull();
  });

  it('requires libId, footprint and mpn on an active part, with the off-board escape named', async () => {
    const v = await validate(manifest([{ ref: 'U2', value: 'Thing', group: 'MCU' }]));
    const d = v.findings.map((f) => f.detail);
    expect(d.some((x) => x.startsWith('U2: no "libId"'))).toBe(true);
    expect(d.some((x) => x.includes('"offBoard": true'))).toBe(true);
    expect(d.some((x) => x.startsWith('U2: no "mpn"'))).toBe(true);
  });

  it('asks a passive for a package or explicit ids, and names unknown packages', async () => {
    const v = await validate(manifest([{ ref: 'R9', value: '1k', group: 'MCU' }, { ref: 'C9', value: '1u', package: 'QFN', group: 'MCU' }]));
    const d = v.findings.map((f) => f.detail);
    expect(d.some((x) => x.startsWith('R9: give "package"'))).toBe(true);
    expect(d.some((x) => x.startsWith('C9: package "QFN" is not known for a C part'))).toBe(true);
    // explicit ids on a passive win over the table
    const v2 = await validate(manifest([{ ref: 'R9', value: '1k', libId: 'Device:R', footprint: 'Resistor_SMD:R_0402_1005Metric', package: '0603', group: 'MCU' }]));
    expect(v2.parts[0]!.footprint).toBe('Resistor_SMD:R_0402_1005Metric');
  });

  it('reports an unresolvable lib_id with the real location', async () => {
    const v = await validate(manifest([{ ...U1, libId: 'Device:MCU8' }]));
    expect(v.findings[0]!.detail).toMatch(/U1: .*CopperMCU:MCU8/);
  });

  it('reports a footprint slip with the closest installed ids, not as a stop', async () => {
    const v = await validate(manifest([{ ...U1, footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.37mm' }]));
    expect(v.stops).toEqual([]);
    expect(v.findings[0]!.detail).toMatch(/U1: footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.37mm" is not in library "Package_SO"; installed: Package_SO:SOIC-8_3.9x4.9mm_P1.27mm/);
  });

  it('treats an uninstalled library as the user stop, not a finding', async () => {
    const v = await validate(manifest([{ ...U1, footprint: 'Vendor_QFN:QFN-8_Special' }]));
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.stops.map((s) => `${s.ref} ${s.footprint} ${s.why}`)).toEqual(['U1 Vendor_QFN:QFN-8_Special no-library']);
    expect(formatManifestFindings(v)).toMatch(/need a library the user must install/);
  });

  it('refuses a pin with no pad, and an unpinned pad when a fitting variant exists', async () => {
    const six = await validate(manifest([{ ...U1, footprint: 'Package_SO:SOIC-6_3.9x4.9mm_P1.27mm' }]));
    expect(six.findings[0]!.detail).toMatch(/U1: pin\(s\) 7, 8 have no pad in footprint Package_SO:SOIC-6.*parts\.intent\.json/);
    const fourteen = await validate(manifest([{ ...U1, footprint: 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm' }]));
    expect(fourteen.findings[0]!.detail).toMatch(/pad\(s\) 9, 10, 11, 12, 13, 14 .* would float .*SOIC-8_3.9x4.9mm_P1.27mm in the same library matches/);
  });

  it('exempts an off-board entry from symbol, footprint and pad checks', async () => {
    const v = await validate(manifest([{ ref: 'BT1', value: '500mAh Li-Po', mpn: 'LP503035', offBoard: true, group: 'Power', rationale: 'bare leads to J1' }, U1, J1, R1]));
    expect(v.findings).toEqual([]);
    const bt = v.parts.find((p) => p.ref === 'BT1')!;
    expect(bt.offBoard).toBe(true);
    expect(bt.libId).toBeNull();
    expect(bt.footprint).toBeNull();
  });

  it('checks substitutions point at an entry that carries the chosen part', async () => {
    const v = await validate(
      manifest([U1, J1], {
        substitutions: [
          { ref: 'U1', wanted: 'DRV8701', chosen: 'MCU8', reason: 'no installed symbol for DRV8701' },
          { ref: 'U7', wanted: 'X', chosen: 'Y', reason: 'z' },
          { ref: 'J1', wanted: 'USB-C', chosen: 'Molex 1234', reason: 'none installed' },
        ],
      }),
    );
    expect(v.findings.map((f) => f.detail)).toEqual([
      'substitution for U7: no part entry has that refdes',
      'substitution for J1: "chosen" is "Molex 1234" but the entry carries value "Conn_01x03", mpn "PH-3"; they must agree',
    ]);
  });

  it('caps the listed findings and counts the rest', async () => {
    const parts = [...Array(50)].map((_, i) => ({ ref: `U${i + 1}`, value: 'X', group: 'MCU' }));
    const { manifest: m } = parseManifest(manifest(parts));
    const v = await validatePartsManifest(m!, { symbols, footprints, subsystemsMd: SUBSYSTEMS, maxFindings: 10 });
    expect(v.findings).toHaveLength(10);
    expect(v.omitted).toBe(150 - 10);
    expect(formatManifestFindings(v)).toMatch(/…and 140 more/);
  });

  it('reads headings at every depth, in order', () => {
    expect(subsystemHeadings('# T\n## A\n### A.1\n## B\n')).toEqual(['A', 'A.1', 'B']);
    expect(subsystemHeadings('')).toBeNull();
  });
});

describe('fixture footprints', () => {
  it('are readable where the test put them', async () => {
    await access(path.join(stock, 'Resistor_SMD.pretty', 'R_0603_1608Metric.kicad_mod'));
  });
});

describe('"noPart": a board feature with nothing to buy (AC-19.9)', () => {
  // A mounting hole, a fiducial, a pad test point: on the board, so its symbol,
  // footprint and pads are checked like any part, and exempt from the MPN rule.
  const H1 = { ref: 'H1', value: 'MountingHole', libId: 'CopperConn:Conn_01x03', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical', group: 'Power' };

  it('validates clean without an mpn', async () => {
    const v = await validate(manifest([{ ...H1, noPart: true }]));
    expect(v.findings.map((f) => f.detail)).toEqual([]);
    expect(v.parts[0]).toMatchObject({ noPart: true, mpn: null });
  });

  it('the missing-mpn finding names the flag, so a description never lands in "mpn"', async () => {
    const v = await validate(manifest([H1]));
    expect(v.findings.map((f) => f.detail).join('\n')).toMatch(/H1: no "mpn".*"noPart": true/);
  });

  it('refuses noPart with an mpn, and noPart with offBoard', async () => {
    const both = await validate(manifest([{ ...H1, noPart: true, mpn: 'NPTH-3.2mm (fab-drilled)' }]));
    expect(both.findings.map((f) => f.detail).join('\n')).toMatch(/H1: "noPart" is true but "mpn" is "NPTH-3.2mm \(fab-drilled\)"/);
    const off = await validate(manifest([{ ref: 'H1', value: 'MountingHole', group: 'Power', offBoard: true, noPart: true }]));
    expect(off.findings.map((f) => f.detail).join('\n')).toMatch(/"offBoard" and "noPart" cannot both be true/);
  });

  it('is still checked against the libraries: a bad footprint is a finding', async () => {
    const v = await validate(manifest([{ ...H1, noPart: true, footprint: 'Connector_PinHeader_2.54mm:Nope' }]));
    expect(v.ok).toBe(false);
    expect(v.findings[0]!.detail).toMatch(/H1: footprint "Connector_PinHeader_2.54mm:Nope"/);
  });

  it('must be a boolean', () => {
    const { manifest: m, findings } = parseManifest(manifest([{ ...H1, noPart: 'yes' }]));
    expect(m).toBeNull();
    expect(findings[0]!.detail).toMatch(/H1: "noPart" must be true or false/);
  });
});
