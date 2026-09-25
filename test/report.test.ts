import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeReport } from '../src/kicad/report.js';
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
    expect(r.unrouted).toEqual([]);
  });

  it('keeps unconnected_items in a distinct unrouted bucket (DRC)', async () => {
    const r = normalizeReport(await load('drc-unrouted.json'), 'drc');
    // Unrouted nets still count against `ok` (a board with ratsnest is not
    // DRC-clean), but the gate can name them distinctly.
    expect(r.ok).toBe(false);
    expect(r.unrouted).toHaveLength(1);
    expect(r.unrouted[0]!.items.map((i) => i.description)).toEqual(['Net "KEY_DAH"', 'Net "VCC"']);
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
});
