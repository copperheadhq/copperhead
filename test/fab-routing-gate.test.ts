import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeReport } from '../src/kicad/report.js';
import { checkRoutingCompleteness } from '../src/kicad/fab.js';
import { REPORTS } from './helpers.js';

const load = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(REPORTS, name), 'utf8'));

describe('fab routing-completeness gate', () => {
  it('passes on a fully-routed board (zero unconnected items)', async () => {
    const drc = normalizeReport(await load('drc-clean.json'), 'drc');
    const r = checkRoutingCompleteness(drc);
    expect(r.status).toBe('pass');
    expect(r.violations).toEqual([]);
  });

  it('fails naming every unrouted net and its location', async () => {
    const drc = normalizeReport(await load('drc-unrouted.json'), 'drc');
    const r = checkRoutingCompleteness(drc);
    expect(r.status).toBe('fail');
    expect(r.violations).toHaveLength(2);
    expect(r.violations.map((v) => v.actual)).toEqual(['KEY_DAH', 'VCC']);
    expect(r.violations[0]!.claim).toBe('fully-routed');
    expect(r.violations[0]!.location).toBe('(12.7, 5.08)');
  });

  it('passes vacuously when there is no board (no DRC report)', () => {
    expect(checkRoutingCompleteness(null)).toEqual({ status: 'pass', violations: [] });
  });
});
