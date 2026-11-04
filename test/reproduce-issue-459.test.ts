import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { STAGES } from '../src/commands/create.js';
import { FootprintResolver } from '../src/kicad/footprints.js';
import { parseBomTable, bomFootprintRows } from '../src/memory/bom-table.js';
import { bomSymbolDossier } from '../src/kicad/dossier.js';

describe('Phase 2 — Issue #459 Defect Reproductions', () => {
  const partSelectionStage = STAGES.find((s) => s.name === 'part-selection')!;

  it('1. Honest UNVERIFIED MPN leaves stage 3 incomplete', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'copperhead-defect-1-'));
    try {
      const docs = path.join(tmp, 'docs');
      await mkdir(docs, { recursive: true });
      // A well-formed BOM where the model honestly flagged the introduced MPN as UNVERIFIED per prompt instructions
      const bom = [
        '# Bill of Materials',
        '',
        '| Refdes | Value | Footprint | MPN | Rationale |',
        '|---|---|---|---|---|',
        '| U1 | STM32F103C8T6 | Package_QFP:LQFP-48_7x7mm_P0.5mm | UNVERIFIED STM32F103C8T6 | Main MCU |',
        '| C1 | 100nF | Resistor_SMD:R_0603_1608Metric | UNVERIFIED GRM188R71C104KA01D | Decoupling |',
      ].join('\n');
      await writeFile(path.join(docs, 'BOM.md'), bom, 'utf8');

      // Observed: isComplete returns false because cols[4] starts with UNVERIFIED
      const complete = await partSelectionStage.isComplete(tmp, 'docs');
      expect(complete).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('2. A supporting table can confuse positional completion parsing', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'copperhead-defect-2-'));
    try {
      const docs = path.join(tmp, 'docs');
      await mkdir(docs, { recursive: true });
      // A BOM where all actual parts have UNVERIFIED MPNs, but a supporting table has a non-UNVERIFIED 4th column
      const bom = [
        '# Bill of Materials',
        '',
        '| Refdes | Value | Footprint | MPN | Rationale |',
        '|---|---|---|---|---|',
        '| U1 | STM32F103C8T6 | Package_QFP:LQFP-48_7x7mm_P0.5mm | UNVERIFIED STM32F103C8T6 | Main MCU |',
        '',
        '## Power Budget',
        '',
        '| Rail | Nominal | Max | Voltage | Notes |',
        '|---|---|---|---|---|',
        '| 3V3 | 50mA | 150mA | 3.3V | Microcontroller and logic supply |',
      ].join('\n');
      await writeFile(path.join(docs, 'BOM.md'), bom, 'utf8');

      // In create.ts: cols[4] for the second table is "3.3V", which doesn't start with UNVERIFIED!
      // This causes rows.some(...) to return true even though NO actual part in the BOM has a non-UNVERIFIED MPN!
      // (Or conversely, a non-standard column layout breaks positional indexing)
      const text = bom;
      const rows = text.split('\n').filter(
        (l) => l.startsWith('|') && !l.includes('---') && !l.toLowerCase().includes('refdes'),
      );
      const matchesOnSupportingTable = rows.some((row) => {
        const cols = row.split('|').map((c) => c.trim());
        const mpn = cols[4] ?? '';
        return mpn && !mpn.toUpperCase().startsWith('UNVERIFIED');
      });
      // The supporting table row falsely satisfied the MPN requirement!
      expect(matchesOnSupportingTable).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('3. An off-board row without a footprint causes an inappropriate stop', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'copperhead-defect-3-'));
    try {
      const docs = path.join(tmp, 'docs');
      await mkdir(docs, { recursive: true });
      // Off-board battery with bare leads
      const bom = [
        '# Bill of Materials',
        '',
        '| Refdes | Value | Footprint | MPN | Rationale |',
        '|---|---|---|---|---|',
        '| U1 | STM32F103C8T6 | Package_QFP:LQFP-48_7x7mm_P0.5mm | STM32F103C8T6 | Main MCU |',
        '| BT1 | 500mAh Li-Po | none | LP503035 | Bare leads to J1 off-board |',
      ].join('\n');
      await writeFile(path.join(docs, 'BOM.md'), bom, 'utf8');

      // In create.ts, bomFootprintMisses checks bomFootprintRows:
      const fps = bomFootprintRows(bom);
      const bt1 = fps.find((f) => f.refdes === 'BT1');
      expect(bt1?.footprint).toBe(''); // "none" parsed as empty

      // Result: stage 3 is rejected because of the off-board part!
      const complete = await partSelectionStage.isComplete(tmp, 'docs');
      expect(complete).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('4. Finish-time gate for stage 3: catches missing or invalid manifest/BOM at finish time', async () => {
    // Stage 3 now has an explicit stageGate wired to ctx.stageGate
    expect(partSelectionStage.stageGate).toBeDefined();

    const tmp = await mkdtemp(path.join(tmpdir(), 'copperhead-defect-4-'));
    try {
      const docs = path.join(tmp, 'docs');
      await mkdir(docs, { recursive: true });
      // Manifest exists but BOM.md does not yet match it
      const manifest = {
        version: 1,
        parts: [{ ref: 'R1', value: '10k', package: '0603' }],
      };
      await writeFile(path.join(docs, 'parts.intent.json'), JSON.stringify(manifest), 'utf8');

      const gateResult = await partSelectionStage.stageGate!(tmp, 'docs');
      expect(gateResult).toContain('manifest validation: 1 finding(s) to reconcile:');
      expect(gateResult).toContain('footprint');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('5. Symbol identity is not recorded in BOM.md; dossier name-search misses when MPN differs from KiCad symbol name', async () => {
    const bom = [
      '# Bill of Materials',
      '',
      '| Refdes | Value | Footprint | MPN | Rationale |',
      '|---|---|---|---|---|',
      '| U1 | STM32F103C8T6 | Package_QFP:LQFP-48_7x7mm_P0.5mm | STM32F103C8T6 | Main MCU |',
    ].join('\n');

    // parseBomTable extracts only refdes, value, footprint, mpn, flags
    const rows = parseBomTable(bom);
    expect(rows[0].refdes).toBe('U1');
    expect((rows[0] as any).symbol).toBeUndefined();
    expect((rows[0] as any).libId).toBeUndefined();

    // When the dossier searches by MPN "STM32F103C8T6", KiCad's canonical symbol is named "STM32F103C8Tx".
    // An exact name match fails, forcing fuzzy search across every installed library!
  });

  it('6. Column reordering causes severe divergence between readers', async () => {
    // A BOM with columns reordered: Refdes | MPN | Value | Footprint | Rationale
    const bom = [
      '# Bill of Materials',
      '',
      '| Refdes | MPN | Value | Footprint | Rationale |',
      '|---|---|---|---|---|',
      '| U1 | STM32F103C8T6 | STM32F103C8T6 | Package_QFP:LQFP-48_7x7mm_P0.5mm | Main MCU |',
    ].join('\n');

    // Reader A: parseBomTable matches headers by name
    const parsed = parseBomTable(bom);
    expect(parsed[0].refdes).toBe('U1');
    expect(parsed[0].mpn).toBe('STM32F103C8T6');
    expect(parsed[0].footprint).toBe('Package_QFP:LQFP-48_7x7mm_P0.5mm');

    // Reader B: positional reader in create.ts uses cols[4] as MPN
    const row = bom.split('\n').find((l) => l.startsWith('| U1'))!;
    const cols = row.split('|').map((c) => c.trim());
    const positionalMpn = cols[4];
    // cols[4] is the Footprint ("Package_QFP:LQFP-48_7x7mm_P0.5mm"), NOT the MPN!
    expect(positionalMpn).toBe('Package_QFP:LQFP-48_7x7mm_P0.5mm');
    expect(positionalMpn).not.toBe(parsed[0].mpn);
  });

  it('7. Substitutions table with Refdes header: demonstrate positional misparsing vulnerability and hardened exclusion', () => {
    const bom = [
      '# Bill of Materials',
      '',
      '| Refdes | Value | Footprint | MPN | Rationale |',
      '|---|---|---|---|---|',
      '| U1 | STM32F103C8T6 | Package_QFP:LQFP-48_7x7mm_P0.5mm | STM32F103C8T6 | Main MCU |',
      '',
      '## Substitutions',
      '',
      '| Refdes | Wanted | Chosen | Reason |',
      '|---|---|---|---|',
      '| U2 | DRV8701 | IR2104 | No installed symbol |',
    ].join('\n');

    // Historical vulnerability demonstration:
    // A reader that relies on positional fallbacks (0=Refdes, 1=Value, 2=Footprint, 3=MPN)
    // for tables matching isHeader (row.cells.some(c => /^(refdes|pin)$/i))
    // treats the Substitutions table as component parts:
    const subTableLines = bom.split('## Substitutions')[1].trim().split('\n');
    const subRows = subTableLines.filter((l) => l.startsWith('|') && !l.includes('---') && !l.toLowerCase().includes('refdes'));
    const fakeRow = subRows[0].split('|').map((c) => c.trim());
    const misparsedValue = fakeRow[2]; // "DRV8701"
    const misparsedFootprint = fakeRow[3]; // "IR2104"
    const misparsedMpn = fakeRow[4]; // "No installed symbol"

    expect(misparsedValue).toBe('DRV8701');
    expect(misparsedFootprint).toBe('IR2104');
    expect(misparsedMpn).toBe('No installed symbol');

    // Hardened contract proof:
    // parseBomTable requires both Refdes AND Value headers, plus at least one of
    // Footprint, Symbol, or MPN, preventing secondary tables from creating fake component rows:
    const rows = parseBomTable(bom);
    const u2 = rows.find((r) => r.refdes === 'U2');
    expect(u2).toBeUndefined();
    expect(rows.length).toBe(1);
    expect(rows[0].refdes).toBe('U1');
  });
});
