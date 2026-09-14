import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandPatternRef } from '../src/kicad/draft/patternExpand.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const REPO_ROOT = path.resolve(HERE, '..');

describe('expandPatternRef: static pattern expansion', () => {
  it('expands voltage-regulator-ams1117 with default references', () => {
    const res = expandPatternRef('voltage-regulator-ams1117');
    expect(res.parts).toHaveLength(3);
    expect(res.parts.map((p) => p.ref)).toEqual(['U1', 'C1', 'C2']);
    expect(res.parts[0]!.libId).toBe('Regulator_Linear:AMS1117-3.3');
    expect(res.parts[0]!.value).toBe('AMS1117-3.3');

    expect(res.nets).toHaveLength(3);
    const vinNet = res.nets.find((n) => n.name === 'VIN');
    expect(vinNet).toBeDefined();
    expect(vinNet!.pins).toEqual(['U1.3', 'C1.1']);
    expect(vinNet!.kind).toBe('power');

    const gndNet = res.nets.find((n) => n.name === 'GND');
    expect(gndNet).toBeDefined();
    expect(gndNet!.pins).toEqual(['U1.1', 'C1.2', 'C2.2']);
    expect(gndNet!.kind).toBe('ground');
  });

  it('expands voltage-regulator-ams1117 with a refPrefix and custom group', () => {
    const res = expandPatternRef('voltage-regulator-ams1117', {
      refPrefix: 'REG1_',
      group: 'Primary Power',
    });

    expect(res.parts.map((p) => p.ref)).toEqual(['REG1_U1', 'REG1_C1', 'REG1_C2']);
    expect(res.parts.every((p) => p.group === 'Primary Power')).toBe(true);

    const vinNet = res.nets.find((n) => n.name === 'VIN');
    expect(vinNet!.pins).toEqual(['REG1_U1.3', 'REG1_C1.1']);

    const outNet = res.nets.find((n) => n.name === '+3V3');
    expect(outNet!.pins).toEqual(['REG1_U1.2', 'REG1_C2.1']);

    const gndNet = res.nets.find((n) => n.name === 'GND');
    expect(gndNet!.pins).toEqual(['REG1_U1.1', 'REG1_C1.2', 'REG1_C2.2']);
  });

  it('expands usb-c-power-input with an instanceId', () => {
    const res = expandPatternRef('usb-c-power-input', { instanceId: 'AUX' });
    expect(res.parts).toHaveLength(4);
    expect(res.parts.map((p) => p.ref)).toEqual(['J1_AUX', 'R1_AUX', 'R2_AUX', 'C1_AUX']);

    const vbus = res.nets.find((n) => n.name === 'VBUS');
    expect(vbus).toBeDefined();
    expect(vbus!.pins).toEqual(['J1_AUX.A4', 'J1_AUX.B4', 'C1_AUX.1']);

    const cc1 = res.nets.find((n) => n.name === 'CC1');
    expect(cc1!.pins).toEqual(['J1_AUX.A5', 'R1_AUX.1']);

    const gnd = res.nets.find((n) => n.name === 'GND');
    expect(gnd!.pins).toEqual(['J1_AUX.A1', 'J1_AUX.B1', 'J1_AUX.SH', 'R1_AUX.2', 'R2_AUX.2', 'C1_AUX.2']);
  });

  it('expands crystal-oscillator with prefix', () => {
    const res = expandPatternRef('crystal-oscillator', { refPrefix: 'MCU_' });
    expect(res.parts).toHaveLength(3);
    expect(res.parts.map((p) => p.ref)).toEqual(['MCU_Y1', 'MCU_C1', 'MCU_C2']);

    const xtal1 = res.nets.find((n) => n.name === 'XTAL1');
    expect(xtal1!.pins).toEqual(['MCU_Y1.1', 'MCU_C1.1']);

    const xtal2 = res.nets.find((n) => n.name === 'XTAL2');
    expect(xtal2!.pins).toEqual(['MCU_Y1.2', 'MCU_C2.1']);

    const gnd = res.nets.find((n) => n.name === 'GND');
    expect(gnd!.pins).toEqual(['MCU_C1.2', 'MCU_C2.2']);
  });

  it('expanded output conforms to SchematicIntent and passes structural validation', async () => {
    const expanded = expandPatternRef('voltage-regulator-ams1117', { refPrefix: 'MAIN_' });

    const intent: SchematicIntent = {
      version: 1,
      parts: expanded.parts,
      nets: expanded.nets,
    };

    // Structural validation without docs cross-check (docsDir = null)
    const symsource = new SymbolSource(REPO_ROOT, [SYMLIB]);
    const validation = await validateIntent(intent, symsource, null);

    // Structural checks: valid JSON, types, endpoint shapes, and pin integrity
    expect(validation.findings.filter((f) => f.detail.includes('needs string') || f.detail.includes('not of the form'))).toEqual([]);
    expect(validation.findings.filter((f) => f.detail.includes('unknown part'))).toEqual([]);
  });

  it('throws descriptive error on unknown pattern name', () => {
    expect(() => expandPatternRef('non-existent-circuit-block')).toThrow(
      /pattern "non-existent-circuit-block" not found/,
    );
  });

  it('throws descriptive error on empty pattern name', () => {
    expect(() => expandPatternRef('')).toThrow(
      /patternName must be a non-empty string/,
    );
  });
});
