import { describe, it, expect } from 'vitest';
import {
  expandPatternToBomRows,
  expandPatternToBom,
  resolvePatternsInBomText,
  loadPatternDefinition,
} from '../src/kicad/patterns/expandToBom.js';
import { parseBomTable } from '../src/memory/bom-table.js';

describe('pattern-bom-expansion', () => {
  describe('expandPatternToBomRows', () => {
    it('expands voltage-regulator-ams1117 into 3 valid BOM rows with pattern rationale', () => {
      const rows = expandPatternToBomRows('voltage-regulator-ams1117');
      expect(rows).toHaveLength(3);

      expect(rows[0]).toEqual({
        refdes: 'U1',
        value: 'AMS1117-3.3',
        footprint: 'Package_TO_SOT_SMD:SOT-223-3_TabPin2',
        mpn: 'UNVERIFIED',
        rationale: 'from pattern: voltage-regulator-ams1117',
        flags: ['UNVERIFIED'],
        markdown: '| U1 | AMS1117-3.3 | Package_TO_SOT_SMD:SOT-223-3_TabPin2 | UNVERIFIED | from pattern: voltage-regulator-ams1117 |',
      });

      expect(rows[1]).toEqual({
        refdes: 'C1',
        value: '10u',
        footprint: 'Capacitor_SMD:C_0805_2012Metric',
        mpn: 'UNVERIFIED',
        rationale: 'from pattern: voltage-regulator-ams1117',
        flags: ['UNVERIFIED'],
        markdown: '| C1 | 10u | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | from pattern: voltage-regulator-ams1117 |',
      });

      expect(rows[2]).toEqual({
        refdes: 'C2',
        value: '10u',
        footprint: 'Capacitor_SMD:C_0805_2012Metric',
        mpn: 'UNVERIFIED',
        rationale: 'from pattern: voltage-regulator-ams1117',
        flags: ['UNVERIFIED'],
        markdown: '| C2 | 10u | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | from pattern: voltage-regulator-ams1117 |',
      });
    });

    it('expands usb-c-power-input into 4 valid BOM rows with pattern rationale', () => {
      const rows = expandPatternToBomRows('usb-c-power-input');
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.refdes)).toEqual(['J1', 'R1', 'R2', 'C1']);
      expect(rows.every((r) => r.rationale === 'from pattern: usb-c-power-input')).toBe(true);
      expect(rows.every((r) => r.mpn === 'UNVERIFIED')).toBe(true);
    });

    it('expands crystal-oscillator into 3 valid BOM rows with pattern rationale', () => {
      const rows = expandPatternToBomRows('crystal-oscillator');
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.refdes)).toEqual(['Y1', 'C1', 'C2']);
      expect(rows.every((r) => r.rationale === 'from pattern: crystal-oscillator')).toBe(true);
    });

    it('throws a descriptive error when requesting an unknown pattern name', () => {
      expect(() => expandPatternToBomRows('nonexistent-circuit-pattern')).toThrow(
        /Pattern "nonexistent-circuit-pattern" not found/,
      );
    });
  });

  describe('expandPatternToBom', () => {
    it('returns full expansion result with headerLine', () => {
      const result = expandPatternToBom('voltage-regulator-ams1117');
      expect(result.patternName).toBe('voltage-regulator-ams1117');
      expect(result.sourceFile).toBe('src/kicad/patterns/voltage-regulator-ams1117.json');
      expect(result.headerLine).toBe(
        '| Pattern: voltage-regulator-ams1117 | source: src/kicad/patterns/voltage-regulator-ams1117.json |',
      );
      expect(result.rows).toHaveLength(3);
      expect(result.markdownRows).toHaveLength(3);
    });
  });

  describe('compatibility with parseBomTable', () => {
    it('expanded rows are parsed by parseBomTable identically to hand-written rows', () => {
      const expansion = expandPatternToBom('voltage-regulator-ams1117');
      const bomMd = [
        '# Bill of Materials',
        '',
        '| Refdes | Value | Footprint | MPN | Rationale |',
        '|---|---|---|---|---|',
        '| U2 | ESP32-WROOM-32 | RF_Module:ESP32-WROOM-32 | ESP32-WROOM-32D | Main MCU |',
        ...expansion.markdownRows,
      ].join('\n');

      const parsed = parseBomTable(bomMd);
      expect(parsed).toHaveLength(4);
      expect(parsed[0]?.refdes).toBe('U2');
      expect(parsed[0]?.value).toBe('ESP32-WROOM-32');
      expect(parsed[0]?.mpn).toBe('ESP32-WROOM-32D');

      expect(parsed[1]?.refdes).toBe('U1');
      expect(parsed[1]?.value).toBe('AMS1117-3.3');
      expect(parsed[1]?.footprint).toBe('Package_TO_SOT_SMD:SOT-223-3_TabPin2');
      expect(parsed[1]?.mpn).toBe('UNVERIFIED');

      expect(parsed[2]?.refdes).toBe('C1');
      expect(parsed[3]?.refdes).toBe('C2');
    });

    it('manual enumerate-parts path works unchanged when no pattern is referenced', () => {
      const manualBom = [
        '# Bill of Materials',
        '',
        '| Refdes | Value | Footprint | MPN | Rationale |',
        '|---|---|---|---|---|',
        '| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | Pull-up |',
        '| C1 | 100n | Capacitor_SMD:C_0603_1608Metric | CC0603KRX7R9BB104 | Decoupling |',
      ].join('\n');

      const { text: resolvedText, resolved } = resolvePatternsInBomText(manualBom);
      expect(resolved).toHaveLength(0);
      expect(resolvedText).toBe(manualBom);

      const parsed = parseBomTable(resolvedText);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.refdes).toBe('R1');
      expect(parsed[1]?.refdes).toBe('C1');
    });
  });

  describe('resolvePatternsInBomText', () => {
    it('replaces "use pattern: <name>" in BOM text with expanded rows and header', () => {
      const input = [
        '# Bill of Materials',
        '',
        '| Refdes | Value | Footprint | MPN | Rationale |',
        '|---|---|---|---|---|',
        '| U2 | ESP32-WROOM-32 | RF_Module:ESP32-WROOM-32 | ESP32-WROOM-32D | Main MCU |',
        'use pattern: voltage-regulator-ams1117',
      ].join('\n');

      const onResolvedCalls: Array<{ name: string; count: number }> = [];
      const { text: output, resolved } = resolvePatternsInBomText(input, {
        onResolved: (name, count) => onResolvedCalls.push({ name, count }),
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toEqual({ patternName: 'voltage-regulator-ams1117', partCount: 3 });
      expect(onResolvedCalls).toEqual([{ name: 'voltage-regulator-ams1117', count: 3 }]);

      expect(output).toContain('| Pattern: voltage-regulator-ams1117 | source: src/kicad/patterns/voltage-regulator-ams1117.json |');
      expect(output).toContain('| U1 | AMS1117-3.3 | Package_TO_SOT_SMD:SOT-223-3_TabPin2 | UNVERIFIED | from pattern: voltage-regulator-ams1117 |');
      expect(output).toContain('| C1 | 10u | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | from pattern: voltage-regulator-ams1117 |');
      expect(output).toContain('| C2 | 10u | Capacitor_SMD:C_0805_2012Metric | UNVERIFIED | from pattern: voltage-regulator-ams1117 |');
    });

    it('replaces piped "| use pattern: <name> |" style declarations', () => {
      const input = [
        '| Refdes | Value | Footprint | MPN | Rationale |',
        '|---|---|---|---|---|',
        '| use pattern: crystal-oscillator |',
      ].join('\n');

      const { text: output, resolved } = resolvePatternsInBomText(input);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.patternName).toBe('crystal-oscillator');
      expect(output).toContain('| Y1 | 16MHz |');
      expect(output).toContain('from pattern: crystal-oscillator');
    });
  });
});
