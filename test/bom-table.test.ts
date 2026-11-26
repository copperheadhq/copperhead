import { describe, it, expect } from 'vitest';
import {
  parseMarkdownTables,
  isHeader,
  parseBomTable,
  parseCanonicalRows,
  parsePinoutRows,
  normalizeValue,
  normalizeFootprint,
  pinoutColumnReport,
} from '../src/memory/bom-table.js';

describe('parseMarkdownTables', () => {
  it('parses a well-formed table, skipping the separator row', () => {
    const md = [
      '# Bill of Materials',
      '',
      '| Refdes | Value | Footprint | MPN | Rationale |',
      '|---|---|---|---|---|',
      '| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic |',
      '| U1 | ATmega328 | Package_QFP:TQFP-32 | ATMEGA328-AU | extracted from schematic |',
    ].join('\n');
    const rows = parseMarkdownTables(md);
    // header + 2 data rows; separator is dropped
    expect(rows).toHaveLength(3);
    expect(rows[1]!.cells[0]).toBe('R1');
    expect(rows[2]!.cells[0]).toBe('U1');
  });

  it('parses multiple tables in one document', () => {
    const md = [
      '| Refdes | Value |',
      '|---|---|',
      '| R1 | 10k |',
      '',
      '| Refdes | Pin | Name | Net | Notes |',
      '|---|---|---|---|---|',
      '| U1 | 5 | GPIO14 | KEY_DAH | |',
    ].join('\n');
    const rows = parseMarkdownTables(md);
    expect(rows).toHaveLength(4);
  });

  it('ignores prose lines that do not start with a pipe', () => {
    const md = 'Every part: refdes, MPN, value, package.\n\n| Refdes | Value |\n|---|---|\n| R1 | 10k |\n';
    const rows = parseMarkdownTables(md);
    expect(rows).toHaveLength(2); // header + one data row
  });

  it('returns an empty array for a document with no tables', () => {
    expect(parseMarkdownTables('# Just prose\n\nNo tables here.\n')).toEqual([]);
  });

  it('does not throw on a malformed / ragged table', () => {
    const md = [
      '| Refdes | Value | Footprint | MPN | Rationale |',
      '|---|---|---|---|---|',
      '| R1 | 10k |', // short row, missing trailing cells
      '| | 47k | Resistor_SMD:R_0603_1608Metric | | |', // missing refdes
      '||||', // degenerate row
    ].join('\n');
    expect(() => parseMarkdownTables(md)).not.toThrow();
    const rows = parseMarkdownTables(md);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('parseCanonicalRows (I5: ignore auxiliary tables)', () => {
  it('returns only the Refdes-headed parts table, ignoring a second summary table', () => {
    const md = [
      '# BOM',
      '',
      '| Refdes | Value | Footprint | MPN | Rationale |',
      '|--------|-------|-----------|-----|-----------|',
      '| R1 | 5.1k | R_0603 | UNVERIFIED | Rd |',
      '| D1 | Red | LED_0603 | UNVERIFIED | indicator |',
      '',
      '## Quiescent-current roll-up',
      '',
      '| Item | Current |',
      '|------|---------|',
      '| LED branch | 0.9 mA |',
      '| Total | 0.9 mA |',
    ].join('\n');
    const rows = parseCanonicalRows(md);
    // Only R1 and D1 — NOT "LED branch"/"Total" from the roll-up table.
    expect(rows.map((r) => r.cells[0])).toEqual(['R1', 'D1']);
  });

  it('returns only the Pin-headed table for PINOUT with a net-legend table', () => {
    const md = [
      '| Refdes | Pin | Name | Net | Notes |',
      '|--------|-----|------|-----|-------|',
      '| J1 | A5 | CC1 | CC1 | |',
      '',
      '| Net | Meaning |',
      '|-----|---------|',
      '| VBUS | 5V input |',
    ].join('\n');
    const rows = parseCanonicalRows(md);
    expect(rows.map((r) => r.cells[0])).toEqual(['J1']);
  });

  it('ignores a document whose only table has no Refdes/Pin header', () => {
    const md = '| Item | Current |\n|------|---------|\n| Total | 1 mA |\n';
    expect(parseCanonicalRows(md)).toEqual([]);
  });

  it('concatenates two parts tables that both carry a Refdes header', () => {
    const md = [
      '| Refdes | Value |',
      '|--------|-------|',
      '| R1 | 5.1k |',
      '',
      '| Refdes | Value |',
      '|--------|-------|',
      '| C1 | 10uF |',
    ].join('\n');
    expect(parseCanonicalRows(md).map((r) => r.cells[0])).toEqual(['R1', 'C1']);
  });
});

describe('isHeader', () => {
  it('recognizes a BOM header row (Refdes)', () => {
    expect(isHeader({ cells: ['Refdes', 'Value', 'Footprint', 'MPN', 'Rationale'] })).toBe(true);
  });

  it('recognizes a PINOUT header row (Pin)', () => {
    expect(isHeader({ cells: ['Refdes', 'Pin', 'Name', 'Net', 'Notes'] })).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isHeader({ cells: ['REFDES', 'Value'] })).toBe(true);
  });

  it('returns false for a data row', () => {
    expect(isHeader({ cells: ['R1', '10k', 'Resistor_SMD:R_0603_1608Metric', 'UNVERIFIED', ''] })).toBe(false);
  });
});

describe('parseBomTable', () => {
  const header = '| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|';

  it('parses a well-formed BOM into typed rows', () => {
    const md = `${header}\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic |\n`;
    const rows = parseBomTable(md);
    expect(rows).toEqual([
      {
        refdes: 'R1',
        value: '10k',
        footprint: 'Resistor_SMD:R_0603_1608Metric',
        mpn: 'UNVERIFIED',
        flags: ['UNVERIFIED'],
      },
    ]);
  });

  it('flags a row with a real MPN as unflagged', () => {
    const md = `${header}\n| U1 | ATmega328 | Package_QFP:TQFP-32 | ATMEGA328-AU | verified against datasheet |\n`;
    const rows = parseBomTable(md);
    expect(rows[0]!.flags).toEqual([]);
    expect(rows[0]!.mpn).toBe('ATMEGA328-AU');
  });

  it('flags a row with no MPN column value as MISSING_MPN', () => {
    const md = `${header}\n| R2 | 4k7 | Resistor_SMD:R_0603_1608Metric | | |\n`;
    const rows = parseBomTable(md);
    expect(rows[0]!.flags).toEqual(['MISSING_MPN']);
    expect(rows[0]!.mpn).toBeUndefined();
  });

  it('drops rows with no refdes rather than throwing', () => {
    const md = `${header}\n|  | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | |\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | |\n`;
    const rows = parseBomTable(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refdes).toBe('R1');
  });

  it('handles a short/ragged row without throwing', () => {
    const md = `${header}\n| R3 | 1k |\n`;
    expect(() => parseBomTable(md)).not.toThrow();
    const rows = parseBomTable(md);
    expect(rows[0]).toEqual({
      refdes: 'R3',
      value: '1k',
      footprint: undefined,
      mpn: undefined,
      flags: ['MISSING_MPN'],
    });
  });

  it('returns an empty array for a BOM with header only, no data rows', () => {
    expect(parseBomTable(header)).toEqual([]);
  });

  it('ignores a Refdes-headed table with no Value column, keeping the real row (#321)', () => {
    const md = [
      '| Refdes | Value | Footprint | MPN | Rationale |',
      '|---|---|---|---|---|',
      '| C1 | 4700uF | Capacitor_THT:CP_Radial_D12.5mm_P5.00mm | UNVERIFIED | reservoir |',
      '',
      '## Symbol availability audit',
      '',
      '| Refdes | Symbol `lib_id` | Symbol exists? | Pins read back from the installed symbol |',
      '|---|---|---|---|',
      '| C1 | `Device:C_Polarized` | Yes | 2 pins, both passive |',
    ].join('\n');
    const rows = parseBomTable(md);
    expect(rows.map((r) => r.refdes)).toEqual(['C1']);
    expect(rows[0]!.value).toBe('4700uF');
  });

  it('does not let a quiescent-current or lib_id table override a real value (#321)', () => {
    const md = [
      '| Refdes | Value | Footprint | MPN | Rationale |',
      '|---|---|---|---|---|',
      '| J1 | USB-C 6P | Connector_USB:USB_C_Receptacle_USB2.0 | UNVERIFIED | power in |',
      '',
      '## Quiescent-current roll-up',
      '',
      '| Refdes | Leakage / quiescent contribution | Basis |',
      '|---|---|---|',
      '| J1 | 0 mA | none |',
      '',
      '## Symbol availability',
      '',
      '| Refdes | Symbol `lib_id` |',
      '|---|---|',
      '| J1 | `Connector:USB_C_Receptacle_USB2.0` |',
    ].join('\n');
    const rows = parseBomTable(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refdes: 'J1', value: 'USB-C 6P' });
  });

  it('still parses a normal Refdes|Value|Footprint|MPN|Rationale BOM unchanged', () => {
    const md = `${header}\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | Rd |\n`;
    expect(parseBomTable(md)).toEqual([
      {
        refdes: 'R1',
        value: '10k',
        footprint: 'Resistor_SMD:R_0603_1608Metric',
        mpn: 'UNVERIFIED',
        flags: ['UNVERIFIED'],
      },
    ]);
  });

  it('parses a BOM with extra appended columns (Manufacturer, LCSC)', () => {
    const md = [
      '| Refdes | Value | Footprint | MPN | Rationale | Manufacturer | LCSC |',
      '|---|---|---|---|---|---|---|',
      '| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | Rd | Yageo | C25804 |',
    ].join('\n');
    const rows = parseBomTable(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      refdes: 'R1',
      value: '10k',
      footprint: 'Resistor_SMD:R_0603_1608Metric',
      mpn: 'UNVERIFIED',
    });
  });

  it('ignores a pin-headed table (no Value column) rather than reading it as a BOM', () => {
    const md = '| Refdes | Pin | Net |\n|---|---|---|\n| J1 | A4 | VBUS |\n';
    expect(parseBomTable(md)).toEqual([]);
  });
});

describe('normalizeValue (#I11 — semantic value equality, not byte-exact)', () => {
  const eq = (a: string, b: string): boolean => normalizeValue(a) === normalizeValue(b);

  it('folds ≥/>= and ≤/<= so they are not drift', () => {
    expect(eq('Ihold≥3A, Vmax≥6V', 'Ihold>=3A, Vmax>=6V')).toBe(true);
    expect(eq('Iout≤1A', 'Iout<=1A')).toBe(true);
  });

  it('treats the inch mark " as equivalent to in', () => {
    expect(eq('2x2 0.1" header', '2x2 0.1in header')).toBe(true);
  });

  it('folds the ohm sign and the micro sign', () => {
    expect(eq('5.1kΩ', '5.1kohm')).toBe(true);
    expect(eq('10µF', '10uF')).toBe(true);
    expect(eq('10μF', '10uF')).toBe(true); // greek mu vs micro sign
  });

  it('is case- and space-insensitive', () => {
    expect(eq('10 K', '10k')).toBe(true);
    expect(eq('4K7', '4k7')).toBe(true);
  });

  it('still flags a genuinely different value', () => {
    expect(eq('10k', '4k7')).toBe(false);
    expect(eq('Ihold≥3A', 'Ihold≥5A')).toBe(false);
  });
});

describe('normalizeFootprint (F6 — encoding/space folded, case preserved)', () => {
  const eq = (a: string, b: string): boolean => normalizeFootprint(a) === normalizeFootprint(b);

  it('folds spacing but is case-sensitive (a footprint library id is case-significant)', () => {
    expect(eq('Resistor_SMD:R_0603_1608Metric', 'Resistor_SMD:R_0603_1608Metric ')).toBe(true);
    // Unlike normalizeValue, case differences are NOT folded away.
    expect(eq('Resistor_SMD:R_0603', 'resistor_smd:r_0603')).toBe(false);
    expect(normalizeValue('Resistor_SMD:R_0603')).toBe(normalizeValue('resistor_smd:r_0603'));
  });
});

describe('parsePinoutRows (#I12 — header-name column resolution)', () => {
  it('resolves the Net column on a 3-column Refdes|Pin|Net table', () => {
    const md = `| Refdes | Pin | Net |\n|---|---|---|\n| J1 | A4 | \`VBUS\` |\n| J1 | A1 | \`GND\` |\n`;
    // The old fixed-index reader took net from column 3 (absent here) and
    // reported every pin as "NC"; by header name the net is column 2.
    expect(parsePinoutRows(md)).toEqual([
      { ref: 'J1', pin: 'A4', net: 'VBUS' },
      { ref: 'J1', pin: 'A1', net: 'GND' },
    ]);
  });

  it('resolves the Net column on the 5-column scaffold table too', () => {
    const md = `| Refdes | Pin | Name | Net | Notes |\n|---|---|---|---|---|\n| F1 | 1 | IN | VBUS | fuse in |\n`;
    expect(parsePinoutRows(md)).toEqual([{ ref: 'F1', pin: '1', net: 'VBUS' }]);
  });

  it('strips markdown backticks so `VBUS` matches the schematic net VBUS', () => {
    const md = `| Refdes | Pin | Net |\n|---|---|---|\n| C1 | 2 | \`GND\` |\n`;
    expect(parsePinoutRows(md)[0]!.net).toBe('GND');
  });

  it('ignores a supporting Net|Role legend table (no Pin column)', () => {
    const md =
      `| Net | Role |\n|---|---|\n| VBUS | raw 5V |\n\n` +
      `| Refdes | Pin | Net |\n|---|---|---|\n| J1 | A4 | VBUS |\n`;
    expect(parsePinoutRows(md)).toEqual([{ ref: 'J1', pin: 'A4', net: 'VBUS' }]);
  });
});

describe('pinoutColumnReport (#I12 — explicit missing-column signal)', () => {
  it('reports a full Refdes|Pin|Net table as complete', () => {
    const r = pinoutColumnReport('| Refdes | Pin | Net |\n|---|---|---|\n| J1 | A4 | VBUS |\n');
    expect(r).toEqual({ hasTable: true, pin: true, net: true, refdes: true });
  });

  it('flags a pin table that omits the Net column (the false-NC case)', () => {
    // A Refdes|Pin table with no Net column: drift should say so once, not report
    // every pin as a false NC mismatch.
    const r = pinoutColumnReport('| Refdes | Pin |\n|---|---|\n| J1 | A4 |\n');
    expect(r.hasTable).toBe(true);
    expect(r.pin).toBe(true);
    expect(r.net).toBe(false);
  });

  it('reports no canonical table for a doc with only a legend table', () => {
    const r = pinoutColumnReport('| Net | Role |\n|---|---|\n| VBUS | raw 5V |\n');
    expect(r.hasTable).toBe(false);
    expect(r.net).toBe(false);
  });
});
describe('optional outer pipes (GitHub-flavored markdown)', () => {
  const pinout = [
    '# Pinout',
    '',
    'Refdes | Pin | Net',
    '--- | --- | ---',
    'U1 | 1 | 3V3',
    'U1 | 5 | KEY_DAH',
  ].join('\n');

  const bom = [
    '# Bill of Materials',
    '',
    'Refdes | Value | Footprint | MPN | Rationale',
    '--- | --- | --- | --- | ---',
    'R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | from schematic',
  ].join('\n');

  it('reads a pin table written without the outer pipes', () => {
    const rows = parsePinoutRows(pinout);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ ref: 'U1', pin: '1', net: '3V3' });
    expect(rows[1]).toEqual({ ref: 'U1', pin: '5', net: 'KEY_DAH' });
  });

  it('reports the columns of a pin table written without the outer pipes', () => {
    expect(pinoutColumnReport(pinout)).toEqual({ hasTable: true, pin: true, net: true, refdes: true });
  });

  it('reads a BOM table written without the outer pipes', () => {
    const rows = parseBomTable(bom);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refdes).toBe('R1');
    expect(rows[0]!.value).toBe('10k');
    expect(rows[0]!.footprint).toBe('Resistor_SMD:R_0603_1608Metric');
  });

  it('still reads the piped form, and both forms agree', () => {
    const piped = [
      '| Refdes | Pin | Net |',
      '| --- | --- | --- |',
      '| U1 | 1 | 3V3 |',
      '| U1 | 5 | KEY_DAH |',
    ].join('\n');
    expect(parsePinoutRows(piped)).toEqual(parsePinoutRows(pinout));
  });

  it('a prose line carrying a pipe below a table is not read as a pin', () => {
    const md = [
      '| Refdes | Pin | Net |',
      '|---|---|---|',
      '| U1 | 1 | 3V3 |',
      'Legend: A | B',
    ].join('\n');
    expect(parsePinoutRows(md)).toEqual([{ ref: 'U1', pin: '1', net: '3V3' }]);
  });

  it('a prose line carrying a pipe below an un-piped table is not read as a part', () => {
    const md = [bom, 'Legend: UNVERIFIED | needs a datasheet check'].join('\n');
    expect(parseBomTable(md).map((r) => r.refdes)).toEqual(['R1']);
  });

  it('the export reader does not read a pipe-bearing prose line as a part either', () => {
    const md = [bom, 'Legend: UNVERIFIED | needs a datasheet check'].join('\n');
    const flat = parseMarkdownTables(md).filter((r) => !isHeader(r));
    expect(flat.map((r) => r.cells[0])).toEqual(['R1']);
  });

  it('the export reader ignores a prose line whose cell count matches the header', () => {
    // The quiet variant: a matching cell count puts a real value in the MPN
    // column, so the phantom row reaches the ordering CSV without a warning.
    const md = [bom, '', 'Second-source options: Yageo | Vishay | KOA | Panasonic'].join('\n');
    const flat = parseMarkdownTables(md).filter((r) => !isHeader(r));
    expect(flat.map((r) => r.cells[0])).toEqual(['R1']);
  });

  it('a prose line carrying a pipe does not hide the table under it', () => {
    const md = ['Nets are named `A | B` in the legend.', '| Refdes | Pin | Net |', '|---|---|---|', '| U1 | 1 | 3V3 |'].join('\n');
    expect(parsePinoutRows(md)).toEqual([{ ref: 'U1', pin: '1', net: '3V3' }]);
  });

  it('ignores a pipe-free document', () => {
    expect(parseCanonicalRows('# Just prose\n\nNo tables here.\n')).toEqual([]);
  });
  it('does not read an example table inside a fenced code block', () => {
    const md = [
      '| Refdes | Pin | Net |',
      '|---|---|---|',
      '| U1 | 1 | 3V3 |',
      '',
      '```markdown',
      'Refdes | Pin | Net',
      '--- | --- | ---',
      'U9 | 42 | EXAMPLE_NET',
      '```',
    ].join('\n');
    expect(parsePinoutRows(md)).toEqual([{ ref: 'U1', pin: '1', net: '3V3' }]);
  });

  it('the check reader and the export reader agree on an un-piped BOM', () => {
    const checked = parseBomTable(bom);
    const flat = parseMarkdownTables(bom).filter((r) => !isHeader(r));
    expect(checked.map((r) => r.refdes)).toEqual(flat.map((r) => r.cells[0]));
    expect(checked.map((r) => r.refdes)).toEqual(['R1']);
  });

  it('a shorter or different fence inside a block does not end it early', () => {
    const b3 = '`'.repeat(3);
    const b4 = '`'.repeat(4);
    const md = [
      '| Refdes | Pin | Net |',
      '|---|---|---|',
      '| U1 | 1 | 3V3 |',
      '',
      b4 + 'markdown',
      'Example, do not parse:',
      b3,
      'Refdes | Pin | Net',
      '--- | --- | ---',
      'U9 | 42 | LEAKED',
      '',
      b4,
    ].join('\n');
    expect(parsePinoutRows(md).map((r) => r.ref)).toEqual(['U1']);
  });

  it('an over-indented delimiter inside a block is content, not a closer', () => {
    const b3 = '`'.repeat(3);
    const md = [
      '| Refdes | Pin | Net |',
      '|---|---|---|',
      '| U1 | 1 | 3V3 |',
      '',
      b3 + 'markdown',
      '    ' + b3,
      'Refdes | Pin | Net',
      '--- | --- | ---',
      'U9 | 42 | LEAKED',
      '',
      b3,
    ].join('\n');
    expect(parsePinoutRows(md).map((r) => r.ref)).toEqual(['U1']);
    // The export reader has no header filter, so it must be checked separately.
    expect(parseMarkdownTables(md).filter((r) => !isHeader(r)).map((r) => r.cells[0])).toEqual(['U1']);
  });

  it('still treats a legally indented fence as a fence', () => {
    const b3 = '`'.repeat(3);
    const md = [
      '| Refdes | Pin | Net |',
      '|---|---|---|',
      '| U1 | 1 | 3V3 |',
      '',
      '  ' + b3 + 'markdown',
      'Refdes | Pin | Net',
      '--- | --- | ---',
      'U5 | 5 | EXAMPLE',
      '',
      '  ' + b3,
    ].join('\n');
    expect(parsePinoutRows(md).map((r) => r.ref)).toEqual(['U1']);
  });

  it('handles CRLF documents', () => {
    const b3 = '`'.repeat(3);
    const md = [
      '| Refdes | Pin | Net |',
      '|---|---|---|',
      '| U1 | 1 | 3V3 |',
      '',
      b3 + 'markdown',
      'Refdes | Pin | Net',
      '--- | --- | ---',
      'U9 | 42 | LEAKED',
      '',
      b3,
    ].join('\r\n');
    expect(parsePinoutRows(md).map((r) => r.ref)).toEqual(['U1']);
  });

  it('a tilde fence does not close a backtick fence', () => {
    const b3 = '`'.repeat(3);
    const md = [
      '| Refdes | Pin | Net |',
      '|---|---|---|',
      '| U1 | 1 | 3V3 |',
      '',
      b3 + 'markdown',
      '~~~',
      'Refdes | Pin | Net',
      '--- | --- | ---',
      'U8 | 99 | LEAKED',
      '',
      b3,
    ].join('\n');
    expect(parsePinoutRows(md).map((r) => r.ref)).toEqual(['U1']);
  });
});
