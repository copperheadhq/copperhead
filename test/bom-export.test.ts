import { describe, it, expect, afterEach } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  parseBom,
  buildExport,
  orderQuantity,
  isPassiveFootprint,
  isSupplier,
} from '../src/kicad/bom-export.js';
import { runExportBom, ExportError, parseBoards, parseSpares, parseSupplier } from '../src/commands/export.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

// A BOM that is drift-clean against the open-key fixture schematic (R1 10k, R2
// 1k, U1 ESP32-S3-MINI) and exercises every classification: R1 verified with an
// MPN, R2 with no MPN (the init/scaffold UNVERIFIED placeholder), U1 with a real
// MPN but flagged UNVERIFIED in its rationale.
const FIXTURE_BOM = `# Bill of Materials

| Refdes | Value | Footprint | MPN | Manufacturer | LCSC | Rationale |
|---|---|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | Yageo | C25804 | pullup, verified against datasheet |
| R2 | 1k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | | | placeholder, no MPN chosen yet |
| U1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | ESP32-S3-MINI-1-N8 | Espressif | C2913202 | UNVERIFIED: datasheet not yet checked |
`;

describe('BOM parsing (supplier-bom-export)', () => {
  it('maps columns by header, tolerating extra and reordered columns', () => {
    const rows = parseBom(FIXTURE_BOM);
    expect(rows.map((r) => r.refdes)).toEqual(['R1', 'R2', 'U1']);
    const r1 = rows[0]!;
    expect(r1).toMatchObject({
      value: '10k',
      footprint: 'Resistor_SMD:R_0603_1608Metric',
      mpn: 'RC0603FR-0710KL',
      manufacturer: 'Yageo',
      lcsc: 'C25804',
      unverified: false,
      hasMpn: true,
    });
  });

  it('treats the UNVERIFIED MPN placeholder as missing, and the token anywhere as a flag', () => {
    const rows = parseBom(FIXTURE_BOM);
    // R2: MPN column is the placeholder → no orderable MPN, and flagged.
    expect(rows[1]).toMatchObject({ hasMpn: false, unverified: true });
    // U1: real MPN, but UNVERIFIED appears in the rationale → flagged, has MPN.
    expect(rows[2]).toMatchObject({ hasMpn: true, unverified: true });
  });

  it('returns no rows when there is no Refdes-headed table', () => {
    expect(parseBom('# nothing here\n\njust prose\n')).toEqual([]);
  });
});

describe('quantity arithmetic (supplier-bom-export)', () => {
  it('applies the spares percentage (spec: 4/board, 10 boards, 10% → 44)', () => {
    expect(orderQuantity(4, 10, 10, false)).toBe(44);
  });

  it('applies the passive minimum (spec: 1/board, 1 board, 10% → 3)', () => {
    expect(orderQuantity(1, 1, 10, true)).toBe(3);
  });

  it('the passive minimum only raises, never lowers', () => {
    // 100/board, 1 board, 10% → 110 spares dominates the +2 floor.
    expect(orderQuantity(100, 1, 10, true)).toBe(110);
  });

  it('non-passive lines get percentage spares with no floor', () => {
    expect(orderQuantity(1, 1, 10, false)).toBe(2);
    expect(orderQuantity(1, 5, 10, false)).toBe(6);
  });

  it('classifies passive footprints by the R_/C_/L_ prefix after the library colon', () => {
    expect(isPassiveFootprint('Resistor_SMD:R_0603_1608Metric')).toBe(true);
    expect(isPassiveFootprint('Capacitor_SMD:C_0402_1005Metric')).toBe(true);
    expect(isPassiveFootprint('Inductor_SMD:L_0805_2012Metric')).toBe(true);
    expect(isPassiveFootprint('R_0603')).toBe(true); // bare, no library
    expect(isPassiveFootprint('RF_Module:ESP32-S3-MINI-1')).toBe(false);
  });
});

describe('supplier format emitters (golden, supplier-bom-export)', () => {
  const rows = parseBom(FIXTURE_BOM);

  it('JLCPCB assembly CSV: Comment/Designator/Footprint/LCSC, verified rows only', () => {
    const { csv } = buildExport(rows, 'jlcpcb', { boards: 1, spares: 10, includeUnverified: false });
    expect(csv).toBe(
      'Comment,Designator,Footprint,LCSC Part #\n' +
        '10k,R1,Resistor_SMD:R_0603_1608Metric,C25804\n',
    );
  });

  it('JLCPCB groups multiple designators sharing value+footprint+LCSC onto one line', () => {
    const multi = parseBom(
      '| Refdes | Value | Footprint | MPN | LCSC |\n' +
        '|---|---|---|---|---|\n' +
        '| R10 | 10k | R_0603 | RC0603FR-0710KL | C25804 |\n' +
        '| R2 | 10k | R_0603 | RC0603FR-0710KL | C25804 |\n',
    );
    const { csv } = buildExport(multi, 'jlcpcb', { boards: 1, spares: 10, includeUnverified: false });
    // Designators naturally sorted (R2 before R10) and quoted because of the comma.
    expect(csv).toBe('Comment,Designator,Footprint,LCSC Part #\n10k,"R2,R10",R_0603,C25804\n');
  });

  it('DigiKey cart CSV carries computed quantity, MPN, and manufacturer (spec: 5 boards)', () => {
    const { csv } = buildExport(rows, 'digikey', { boards: 5, spares: 10, includeUnverified: false });
    // R1 passive, 1/board × 5 = 5; ceil(5.5)=6, floor 5+2=7 → 7.
    expect(csv).toBe(
      'Manufacturer Part Number,Manufacturer,Quantity,Customer Reference\n' +
        'RC0603FR-0710KL,Yageo,7,R1\n',
    );
  });

  it('Mouser cart CSV uses the Mouser MPN header', () => {
    const { csv } = buildExport(rows, 'mouser', { boards: 1, spares: 10, includeUnverified: false });
    expect(csv).toBe(
      'Mfr. Part Number,Manufacturer,Quantity,Customer Reference\n' +
        'RC0603FR-0710KL,Yageo,3,R1\n',
    );
  });

  it('defuses cells a spreadsheet would evaluate as a formula', () => {
    const hostile = parseBom(
      '| Refdes | Value | Footprint | MPN | Manufacturer |\n' +
        '|---|---|---|---|---|\n' +
        '| R1 | 10k | R_0603 | =cmd\'/c calc\' | -Yageo |\n',
    );
    const { csv } = buildExport(hostile, 'mouser', { boards: 1, spares: 10, includeUnverified: false });
    expect(csv.split('\n')[1]).toBe("'=cmd'/c calc','-Yageo,3,R1");
  });
});

describe('exclusion rules (supplier-bom-export)', () => {
  const rows = parseBom(FIXTURE_BOM);

  it('excludes MPN-less rows and UNVERIFIED rows by default, and names them', () => {
    const res = buildExport(rows, 'digikey', { boards: 1, spares: 10, includeUnverified: false });
    expect(res.included.map((r) => r.refdes)).toEqual(['R1']);
    expect(res.excluded.map((e) => `${e.row.refdes}:${e.reason}`)).toEqual(['R2:no MPN', 'U1:UNVERIFIED']);
    expect(res.warnings.join('\n')).toContain('R2');
    expect(res.warnings.join('\n')).toContain('U1');
  });

  it('--include-unverified opts UNVERIFIED-with-MPN in, but never MPN-less rows', () => {
    const res = buildExport(rows, 'digikey', { boards: 1, spares: 10, includeUnverified: true });
    expect(res.included.map((r) => r.refdes)).toEqual(['R1', 'U1']);
    // R2 has no MPN — still excluded even with the flag.
    expect(res.excluded.map((e) => e.row.refdes)).toEqual(['R2']);
    // U1 is included but still reported as unverified.
    expect(res.warnings.join('\n')).toMatch(/INCLUDED but UNVERIFIED.*U1/);
  });

  it('JLCPCB notes blank LCSC part numbers in the warnings footer', () => {
    const noLcsc = parseBom(
      '| Refdes | Value | Footprint | MPN |\n|---|---|---|---|\n| R1 | 10k | R_0603 | RC0603FR-0710KL |\n',
    );
    const res = buildExport(noLcsc, 'jlcpcb', { boards: 1, spares: 10, includeUnverified: false });
    expect(res.included.map((r) => r.refdes)).toEqual(['R1']);
    expect(res.warnings.join('\n')).toMatch(/no LCSC part #.*R1/);
  });

  it('JLCPCB warns that --boards/--spares are ignored when set to a non-default', () => {
    const boardsSet = buildExport(rows, 'jlcpcb', { boards: 25, spares: 10, includeUnverified: false });
    expect(boardsSet.warnings.join('\n')).toMatch(/--boards\/--spares are ignored for jlcpcb/);
    const sparesSet = buildExport(rows, 'jlcpcb', { boards: 1, spares: 15, includeUnverified: false });
    expect(sparesSet.warnings.join('\n')).toMatch(/--boards\/--spares are ignored for jlcpcb/);
  });

  it('JLCPCB does not warn about quantity flags at their defaults', () => {
    const res = buildExport(rows, 'jlcpcb', { boards: 1, spares: 10, includeUnverified: false });
    expect(res.warnings.join('\n')).not.toMatch(/ignored for jlcpcb/);
  });

  it('cart suppliers never emit the jlcpcb quantity-flags note', () => {
    const res = buildExport(rows, 'digikey', { boards: 25, spares: 15, includeUnverified: false });
    expect(res.warnings.join('\n')).not.toMatch(/ignored for jlcpcb/);
  });
});

describe('flag validation (cli-surface)', () => {
  it('accepts the three suppliers and rejects others', () => {
    expect(isSupplier('jlcpcb')).toBe(true);
    expect(isSupplier('acme')).toBe(false);
    expect(() => parseSupplier('acme')).toThrow(/supported: jlcpcb, digikey, mouser/);
    expect(parseSupplier('mouser')).toBe('mouser');
  });

  it('rejects non-positive-integer boards and negative spares', () => {
    expect(() => parseBoards('0')).toThrow(ExportError);
    expect(() => parseBoards('1.5')).toThrow(ExportError);
    expect(parseBoards('5')).toBe(5);
    expect(() => parseSpares('-1')).toThrow(ExportError);
    expect(parseSpares('0')).toBe(0);
  });
});

describe('export command end-to-end (supplier-bom-export)', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  async function fixtureWithBom(): Promise<string> {
    const t = await tempFixtureRepo();
    cleanup = t.cleanup;
    // init writes .copperhead/config.json (schematic path) and docs/; then we
    // replace the scaffolded BOM with our controlled, drift-clean one.
    await runInit({ repoRoot: t.repo, installHooks: false });
    await writeFile(path.join(t.repo, 'docs', 'BOM.md'), FIXTURE_BOM, 'utf8');
    return t.repo;
  }

  it('writes outputs/digikey-bom.csv from a drift-clean repo', async () => {
    const repo = await fixtureWithBom();
    const res = await runExportBom({ repoRoot: repo, supplier: 'digikey', boards: 1, spares: 10, includeUnverified: false });
    expect(res.outPath).toBe(path.join('outputs', 'digikey-bom.csv'));
    const written = await readFile(path.join(repo, res.outPath), 'utf8');
    expect(written).toBe(res.csv);
    expect(written).toContain('RC0603FR-0710KL,Yageo,3,R1');
    expect(written).not.toContain('U1'); // UNVERIFIED, excluded by default
  });

  it('refuses to export when BOM.md drifts from the schematic', async () => {
    const repo = await fixtureWithBom();
    // Change R1's value so BOM.md disagrees with the schematic (10k).
    await writeFile(path.join(repo, 'docs', 'BOM.md'), FIXTURE_BOM.replace('| 10k |', '| 47k |'), 'utf8');
    await expect(
      runExportBom({ repoRoot: repo, supplier: 'digikey', boards: 1, spares: 10, includeUnverified: false }),
    ).rejects.toThrow(/drift/i);
    // Nothing written on refusal.
    expect(existsSync(path.join(repo, 'outputs', 'digikey-bom.csv'))).toBe(false);
  });

  it('errors when there is no BOM.md to export', async () => {
    const t = await tempFixtureRepo();
    cleanup = t.cleanup;
    await expect(
      runExportBom({ repoRoot: t.repo, supplier: 'jlcpcb', boards: 1, spares: 10, includeUnverified: false }),
    ).rejects.toThrow(/BOM\.md/);
  });

  it('makes zero network calls during export (network-free invariant)', async () => {
    const repo = await fixtureWithBom();
    const originalFetch = globalThis.fetch;
    let fetched = false;
    // Any outbound fetch during a deterministic export is a contract violation.
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error('network access attempted during export');
    }) as typeof fetch;
    try {
      await runExportBom({ repoRoot: repo, supplier: 'mouser', boards: 2, spares: 10, includeUnverified: false });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetched).toBe(false);
  });
});
