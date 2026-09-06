import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeReport, formatViolations } from '../src/kicad/report.js';
import { REPORTS } from './helpers.js';

const load = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(REPORTS, name), 'utf8'));

describe('report normalizer', () => {
  it('normalizes a clean ERC report', async () => {
    const r = normalizeReport(await load('erc-clean.json'), 'erc');
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('normalizes a clean DRC report', async () => {
    const r = normalizeReport(await load('drc-clean.json'), 'drc');
    expect(r.ok).toBe(true);
  });

  it('carries type, severity, and location for violations (AC-2.2 source)', async () => {
    const r = normalizeReport(await load('erc-unconnected-pin.json'), 'erc');
    expect(r.ok).toBe(false);
    const pin = r.violations.find((v) => v.type === 'pin_not_connected');
    expect(pin).toBeDefined();
    expect(pin!.severity).toBe('error');
    expect(pin!.sheet).toBe('/');
    expect(pin!.items[0]!.x).toBeTypeOf('number');
  });

  it('tolerates unknown shapes', () => {
    expect(normalizeReport({}, 'erc').ok).toBe(true);
    expect(normalizeReport({ violations: [{}] }, 'drc').violations).toHaveLength(1);
  });

  // Regression coverage for a real bug: `ok` is deliberately severity-aware
  // (warnings don't block it, see the comment above normalizeReport's return),
  // but formatViolations() and src/commands/check.ts both used to key their
  // "clean" display off `ok` too. That silently hid warnings from a
  // warning-only report behind "ERC ✓" / "DRC ✓" / "clean" — exactly
  // contradicting the reason `violations` still carries them. The display
  // decision must be `violations.length === 0`, a question independent of
  // the error-severity pass/fail gate.
  it('is ok but still reports non-empty violations for a warning-only ERC report', async () => {
    const r = normalizeReport(await load('erc-warning-only.json'), 'erc');
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.severity).toBe('warning');
  });

  it('is ok but still reports non-empty violations for a warning-only DRC report', async () => {
    const r = normalizeReport(await load('drc-warning-only.json'), 'drc');
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.severity).toBe('warning');
  });
});

describe('formatViolations', () => {
  it('reports "clean" only when there are truly zero violations, not just ok', async () => {
    const clean = normalizeReport(await load('erc-clean.json'), 'erc');
    expect(formatViolations(clean)).toBe('ERC: clean');
  });

  it('lists a warning-only report\'s violations instead of "clean", even though ok is true', async () => {
    const warningOnly = normalizeReport(await load('erc-warning-only.json'), 'erc');
    expect(warningOnly.ok).toBe(true);
    const formatted = formatViolations(warningOnly);
    expect(formatted).not.toContain('clean');
    expect(formatted).toContain('lib_symbol_issues');
    expect(formatted).toContain('warning');
  });

  it('lists a warning-only DRC report\'s violations instead of "clean"', async () => {
    const warningOnly = normalizeReport(await load('drc-warning-only.json'), 'drc');
    expect(warningOnly.ok).toBe(true);
    const formatted = formatViolations(warningOnly);
    expect(formatted).not.toContain('clean');
    expect(formatted).toContain('lib_footprint_issues');
  });

  it('still lists violations for a genuinely failing (error-severity) report', async () => {
    const broken = normalizeReport(await load('erc-unconnected-pin.json'), 'erc');
    expect(broken.ok).toBe(false);
    const formatted = formatViolations(broken);
    expect(formatted).not.toContain('clean');
    expect(formatted).toContain('pin_not_connected');
  });
});
