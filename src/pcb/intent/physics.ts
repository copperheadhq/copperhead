/**
 * Physics compiler (RFC 11 §7.6, implementation spec §7.5): trace width for a
 * current from a vendored IPC-2221 table (the IPC-2152 tables are not
 * redistributable; the generic-chart formula is the conservative one).
 * Hard only when copper weight, temperature rise, and layer are all known;
 * advisory otherwise. Impedance always holds: no validated stackup exists.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Constraint } from '../../memory/constraints.js';

interface Row {
  amps: number;
  copperOzFt2: number;
  riseC: number;
  layer: 'external' | 'internal';
  widthMm: number;
}

let table: { source: string; rows: Row[] } | null = null;
function load(): { source: string; rows: Row[] } {
  if (!table) {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'vendor', 'ipc', 'current-width.json');
    table = JSON.parse(readFileSync(p, 'utf8')) as { source: string; rows: Row[] };
  }
  return table;
}

/** IPC-2221 generic formula: I = k · ΔT^0.44 · A^0.725, A in mil², k = 0.048 external, 0.024 internal. */
export function widthForCurrent(amps: number, copperOzFt2: number, riseC: number, layer: 'external' | 'internal'): { widthNm: number; method: string } {
  const k = layer === 'external' ? 0.048 : 0.024;
  const areaMil2 = Math.pow(amps / (k * Math.pow(riseC, 0.44)), 1 / 0.725);
  const thicknessMil = 1.378 * copperOzFt2;
  const widthMm = (areaMil2 / thicknessMil) * 0.0254;
  return { widthNm: Math.round(widthMm * 1e6), method: 'physics/ipc2221' };
}

export interface CurrentRequirement {
  net: string;
  amps: number;
  /** Known from the profile or the stackup; undefined makes the result advisory. */
  copperOzFt2?: number;
  riseC?: number;
  layer?: 'external' | 'internal';
}

/** The routing-width entry for a current requirement: hard when fully specified, advisory with the assumptions stated otherwise. */
export function widthConstraint(req: CurrentRequirement, source = 'physics'): { key: string; constraint: Constraint } {
  const known = req.copperOzFt2 !== undefined && req.riseC !== undefined && req.layer !== undefined;
  const oz = req.copperOzFt2 ?? 1, rise = req.riseC ?? 10, layer = req.layer ?? 'external';
  const w = widthForCurrent(req.amps, oz, rise, layer);
  return {
    key: `layout.routing.width.${req.net}`,
    constraint: {
      source,
      affects: ['board'],
      class: 'routing',
      severity: known ? 'hard' : 'advisory',
      scope: { nets: [req.net] },
      parameters: { min_width_nm: w.widthNm, amps: req.amps, copper_oz_ft2: oz, rise_c: rise, layer, derived_by: w.method, ...(known ? {} : { assumed: `copper ${oz} oz, rise ${rise} C, ${layer} layer` }) },
      priority: known ? 80 : 20,
      confidence: known ? 0.9 : 0.5,
      approvedBy: source,
    },
  };
}

/** Impedance targets need a validated stackup class instance; none exists in this change (RFC 11 §7.2 stackup). */
export function impedance(_req: { net: string; ohms: number }): { status: 'HOLD'; reason: string } {
  return { status: 'HOLD', reason: 'impedance needs a validated stackup (dielectric, thickness, copper weight per layer); the first release pins one two-layer profile without one' };
}

export function tableSource(): string {
  return load().source;
}
