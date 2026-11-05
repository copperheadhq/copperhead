import { describe, it, expect } from 'vitest';
import { renderBomMarkdown, escapeCell } from '../src/kicad/parts/bom-renderer.js';
import { parseBomTable } from '../src/memory/bom-table.js';
import type { ExpandedPart, SubstitutionEntry } from '../src/kicad/parts/manifest.js';

describe('Phase 4 — Deterministic BOM Renderer', () => {
  const parts: ExpandedPart[] = [
    {
      ref: 'U1',
      value: 'STM32F103C8T6',
      libId: 'MCU_ST_STM32F1:STM32F103C8Tx',
      footprint: 'Package_QFP:LQFP-48_7x7mm_P0.5mm',
      mpn: 'STM32F103C8T6',
      group: 'MCU',
      rationale: 'Main controller',
      offBoard: false,
      verified: false,
    },
    {
      ref: 'C10',
      value: '10uF',
      libId: 'Device:C',
      footprint: 'Capacitor_SMD:C_0805_2012Metric',
      mpn: '',
      group: 'Power',
      rationale: 'Bulk decoupling',
      offBoard: false,
      verified: false,
    },
    {
      ref: 'C2',
      value: '100nF',
      libId: 'Device:C',
      footprint: 'Capacitor_SMD:C_0603_1608Metric',
      mpn: '',
      group: 'Power',
      rationale: 'Bypass capacitor',
      offBoard: false,
      verified: false,
    },
    {
      ref: 'BT1',
      value: '500mAh Li-Po',
      libId: '(off-board)',
      footprint: '(off-board)',
      mpn: 'LP503035',
      group: 'Power',
      rationale: 'Bare leads to J1',
      offBoard: true,
      verified: false,
    },
  ];

  const substitutions: SubstitutionEntry[] = [
    {
      ref: 'U2',
      wanted: 'DRV8701',
      chosen: 'IR2104',
      reason: 'No installed KiCad symbol for DRV8701',
    },
  ];

  it('renders stable LF line endings and deterministic natural refdes order', () => {
    const rendered = renderBomMarkdown(parts, substitutions);
    expect(rendered).not.toContain('\r');
    expect(rendered.endsWith('\n')).toBe(true);

    // Natural order: BT1, C2, C10, U1 (C2 before C10!)
    const mainTableLines = rendered.split('## Substitutions')[0].split('\n');
    const partRows = mainTableLines.filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('Refdes'));
    const renderedRefs = partRows.map((r) => r.split('|')[1].trim());

    expect(renderedRefs).toEqual(['BT1', 'C2', 'C10', 'U1']);
  });

  it('is completely idempotent (double render is byte-identical)', () => {
    const render1 = renderBomMarkdown(parts, substitutions);
    const render2 = renderBomMarkdown(parts, substitutions);
    expect(render1).toBe(render2);
  });

  it('correctly annotates off-board and unverified parts', () => {
    const rendered = renderBomMarkdown(parts);
    expect(rendered).toContain('| BT1 | 500mAh Li-Po | (off-board) | (off-board) | UNVERIFIED LP503035 | (off-board) Bare leads to J1 |');
    expect(rendered).toContain('| U1 | STM32F103C8T6 | MCU_ST_STM32F1:STM32F103C8Tx | Package_QFP:LQFP-48_7x7mm_P0.5mm | UNVERIFIED STM32F103C8T6 | Main controller |');
  });

  it('escapes pipes in table cells safely', () => {
    const escaped = escapeCell('10k | 1% tolerance');
    expect(escaped).toBe('10k \\| 1% tolerance');
  });

  it('round-trips through parseBomTable with semantic fidelity', () => {
    const rendered = renderBomMarkdown(parts, substitutions);
    const parsed = parseBomTable(rendered);

    // Substitutions table MUST NOT be parsed into component BOM rows
    expect(parsed.length).toBe(4);
    expect(parsed.some((r) => r.refdes === 'U2')).toBe(false);

    // Check U1
    const u1 = parsed.find((r) => r.refdes === 'U1')!;
    expect(u1.value).toBe('STM32F103C8T6');
    expect(u1.symbol).toBe('MCU_ST_STM32F1:STM32F103C8Tx');
    expect(u1.footprint).toBe('Package_QFP:LQFP-48_7x7mm_P0.5mm');
    expect(u1.mpn).toBe('UNVERIFIED STM32F103C8T6');
    expect(u1.flags).toContain('UNVERIFIED');
    expect(u1.offBoard).toBeUndefined();

    // Check BT1 (off-board)
    const bt1 = parsed.find((r) => r.refdes === 'BT1')!;
    expect(bt1.value).toBe('500mAh Li-Po');
    expect(bt1.symbol).toBe('(off-board)');
    expect(bt1.footprint).toBe('(off-board)');
    expect(bt1.offBoard).toBe(true);

    // Check C2
    const c2 = parsed.find((r) => r.refdes === 'C2')!;
    expect(c2.value).toBe('100nF');
    expect(c2.symbol).toBe('Device:C');
    expect(c2.footprint).toBe('Capacitor_SMD:C_0603_1608Metric');
  });
});
