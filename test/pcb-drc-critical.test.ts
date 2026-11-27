/**
 * Critical DRC by fixed KiCad 10 key across severities (add-placement-benchmark
 * tasks 1.1, 1.2; delta spec pcb-verification) and the probe's net subset
 * (add-reuse-placer, "Routability probe on a net subset"). Synthetic reports,
 * no KiCad; the router is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckReport, Violation } from '../src/kicad/report.js';
import { fromDrcReport, PLACEMENT_CRITICAL_DRC } from '../src/pcb/verify/checkers/kicad-drc.js';
import { JLCPCB_2LAYER, JLCPCB_4LAYER, JLCPCB_6LAYER } from '../src/pcb/verify/profiles/index.js';

vi.mock('../src/pcb/engines/route.js', () => ({
  routeBoard: vi.fn(async () => ({
    ranking: { selected: 'router-mock' },
    candidates: [{ engineId: 'router-mock', verify: { metrics: { completion_rate: 0.5, drc_error_count: 3, drc_critical_count: 2 } } }],
  })),
}));

import { routeBoard } from '../src/pcb/engines/route.js';
import { routabilityProbe, probeRouteOptions, type ProbeOptions } from '../src/pcb/engines/probe.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES = path.join(HERE, '..', 'src', 'pcb', 'verify', 'profiles');

const item = (type: string, severity: 'error' | 'warning'): Violation => ({ severity, type, description: type, items: [] });
// The normalized report holds every severity in violations, as KiCad wrote it.
const report = (errors: string[], warnings: string[] = []): CheckReport => ({
  ok: errors.length === 0 && warnings.length === 0,
  source: 'drc',
  violations: [...errors.map((t) => item(t, 'error')), ...warnings.map((t) => item(t, 'warning'))],
  unrouted: 0,
});

describe('profiles name KiCad 10 keys', () => {
  it('hole_to_hole replaces hole_near_hole in every JLCPCB profile, typed and JSON alike', async () => {
    for (const [profile, file] of [[JLCPCB_2LAYER, 'jlcpcb-2layer.json'], [JLCPCB_4LAYER, 'jlcpcb-4layer.json'], [JLCPCB_6LAYER, 'jlcpcb-6layer.json']] as const) {
      const json = JSON.parse(await readFile(path.join(PROFILES, file), 'utf8')) as { criticalDrc: string[] };
      expect(profile.criticalDrc, profile.id).toContain('hole_to_hole');
      expect(profile.criticalDrc, profile.id).not.toContain('hole_near_hole');
      expect(json.criticalDrc, file).toEqual(profile.criticalDrc);
    }
  });
});

describe('critical DRC counts across severities', () => {
  it('a pth_inside_courtyard warning counts as critical under jlcpcb-2layer', () => {
    const m = fromDrcReport(report([], ['pth_inside_courtyard']), JLCPCB_2LAYER).metrics;
    expect(m.drc_critical_count).toBe(1);
    expect(m.drc_placement_critical_count).toBe(1);
    expect(m.drc_error_count).toBe(0);
    expect(m.drc_warning_count).toBe(1);
  });

  it('a hole_to_hole error counts as critical, and so does a hole_to_hole warning', () => {
    const e = fromDrcReport(report(['hole_to_hole']), JLCPCB_2LAYER).metrics;
    expect(e.drc_critical_count).toBe(1);
    expect(e.drc_placement_critical_count).toBe(1);
    expect(e.drc_error_count).toBe(1);
    const w = fromDrcReport(report([], ['hole_to_hole']), JLCPCB_2LAYER).metrics;
    expect(w.drc_critical_count).toBe(1);
  });

  it('advisory types count in neither critical metric; drc_error_count stays the error bucket only', () => {
    const m = fromDrcReport(report(['silk_overlap', 'lib_footprint_mismatch'], ['solder_mask_bridge', 'hole_near_hole']), JLCPCB_2LAYER).metrics;
    expect(m.drc_critical_count).toBe(0);
    expect(m.drc_placement_critical_count).toBe(0);
    expect(m.drc_error_count).toBe(2);
    expect(m.drc_warning_count).toBe(2);
  });

  it('the placement-critical count counts only the placement list, across both buckets', () => {
    expect([...PLACEMENT_CRITICAL_DRC].sort()).toEqual(['copper_edge_clearance', 'courtyards_overlap', 'hole_to_hole', 'invalid_outline', 'items_not_allowed', 'npth_inside_courtyard', 'pth_inside_courtyard']);
    for (const type of PLACEMENT_CRITICAL_DRC) {
      expect(fromDrcReport(report([type]), JLCPCB_2LAYER).metrics.drc_placement_critical_count, `${type} error`).toBe(1);
      expect(fromDrcReport(report([], [type]), JLCPCB_2LAYER).metrics.drc_placement_critical_count, `${type} warning`).toBe(1);
    }
    const m = fromDrcReport(
      report(['clearance', 'courtyards_overlap', 'shorting_items', 'npth_inside_courtyard'], ['pth_inside_courtyard', 'silk_overlap', 'invalid_outline', 'isolated_copper']),
      JLCPCB_2LAYER,
    ).metrics;
    // courtyards_overlap, npth_inside_courtyard, pth_inside_courtyard, invalid_outline
    expect(m.drc_placement_critical_count).toBe(4);
    // clearance, courtyards_overlap, shorting_items, pth_inside_courtyard, invalid_outline, isolated_copper (npth_inside_courtyard is not in the profile list)
    expect(m.drc_critical_count).toBe(6);
    expect(m.drc_error_count).toBe(4);
  });
});

describe('routability probe', () => {
  const base: ProbeOptions = { repoRoot: '/nonexistent', pcbPath: '/nonexistent/cand.kicad_pcb', workDir: '/nonexistent/work' };

  beforeEach(() => {
    vi.mocked(routeBoard).mockClear();
  });

  it('passes netNames through to the router options, and omits them when not given', () => {
    const opts: ProbeOptions = { ...base, netNames: ['VCC', 'SDA'] };
    expect(probeRouteOptions(opts).netNames).toEqual(['VCC', 'SDA']);
    expect('netNames' in probeRouteOptions(base)).toBe(false);
    expect(probeRouteOptions(base).routers).toEqual(['router-freerouting']);
  });

  it('routes only the named nets and reports routability_drc_critical beside routability_drc_errors', async () => {
    const p = await routabilityProbe({ ...base, netNames: ['VCC', 'SDA'] });
    expect(vi.mocked(routeBoard)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(routeBoard).mock.calls[0]![0].netNames).toEqual(['VCC', 'SDA']);
    expect(p).toEqual({ routability_completion: 0.5, routability_drc_errors: 3, routability_drc_critical: 2, probe_engine: 'router-mock' });
  });

  it('reports zeros when the router returns no candidate', async () => {
    vi.mocked(routeBoard).mockResolvedValueOnce({ ranking: {}, candidates: [] } as never);
    expect(await routabilityProbe(base)).toEqual({ routability_completion: 0, routability_drc_errors: 0, routability_drc_critical: 0 });
  });
});
