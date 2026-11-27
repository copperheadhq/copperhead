/**
 * KiCad DRC as a checker (RFC 11 §10.2: the authority for configured board
 * rules). Consumes the normalized report `src/kicad/report.ts` already
 * produces; `unconnected_items` become completion counts, never violations.
 */
import type { CheckReport, Violation } from '../../../kicad/report.js';
import { rect } from '../../ir/geometry.js';
import { mmToNm } from '../../ir/units.js';
import type { FabricationProfile } from '../profiles/index.js';
import { make, statusOf, type CheckResult, type Diagnostic } from '../diagnostic.js';

export const KICAD_DRC_CHECKER = { id: 'kicad-drc', version: 'kicad-cli' };

/**
 * KiCad 10 DRC keys a placement alone can violate (add-placement-benchmark,
 * cascade stage V5). Fixed, whatever the profile, and counted across error and
 * warning severities as `drc_placement_critical_count`.
 */
export const PLACEMENT_CRITICAL_DRC: readonly string[] = ['courtyards_overlap', 'pth_inside_courtyard', 'npth_inside_courtyard', 'items_not_allowed', 'copper_edge_clearance', 'hole_to_hole', 'invalid_outline'];

function regionOf(v: Violation) {
  const item = v.items.find((i) => i.x !== undefined && i.y !== undefined);
  return item ? rect(mmToNm(item.x!), mmToNm(item.y!), mmToNm(0.1), mmToNm(0.1)) : undefined;
}

const refsOf = (v: Violation): string[] => {
  const out = new Set<string>();
  for (const i of v.items) {
    for (const m of i.description.matchAll(/\[([^\]]+)\]/g)) out.add(m[1]!);
    const net = /on ([^\s,]+)$/.exec(i.description)?.[1];
    if (net) out.add(net);
  }
  return [...out];
};

export function fromDrcReport(report: CheckReport, profile: FabricationProfile, kicadVersion = 'kicad-cli'): CheckResult {
  const checker = { id: KICAD_DRC_CHECKER.id, version: kicadVersion };
  const d: Diagnostic[] = [];
  // The normalized report blocks on every severity; this checker blocks on
  // errors only. A warning, or a finding inside one library footprint that no
  // placement can move (the report's `intrinsic`), is advisory here.
  const errors = report.violations.filter((v) => v.severity === 'error');
  const warned = report.violations.filter((v) => v.severity !== 'error');
  const warnings = [...warned, ...(report.intrinsic ?? [])];
  const unroutedItems = report.unroutedItems ?? [];
  for (const v of errors) {
    const region = regionOf(v);
    d.push(make(checker, `drc.${v.type}`, { severity: 'error', entityIds: [], entityReferences: refsOf(v), ...(region ? { region } : {}), message: `${v.description}${v.items.length ? ': ' + v.items.map((i) => i.description).join('; ') : ''}`, suggestedActions: profile.criticalDrc.includes(v.type) ? ['rip-up-nets', 'move-group'] : [] }));
  }
  for (const v of warnings) {
    const region = regionOf(v);
    d.push(make(checker, `drc.${v.type}`, { severity: 'warning', entityIds: [], entityReferences: refsOf(v), ...(region ? { region } : {}), message: v.description, suggestedActions: [] }));
  }
  const unrouted = report.unrouted ?? unroutedItems.length;
  if (unrouted) {
    d.push(make(checker, 'conn.unrouted', { severity: 'info', entityIds: [], entityReferences: [...new Set(unroutedItems.flatMap(refsOf))], measured: { value: unrouted, unit: 'count' }, allowed: { value: 0, unit: 'count', relation: '==' }, message: `KiCad reports ${unrouted} unconnected item(s)`, suggestedActions: ['select-router'] }));
  }
  // critical by key across both severities: KiCad's default severity for some critical types
  // (e.g. pth_inside_courtyard) is warning, and a project's rule_severities can demote others.
  // A finding inside one footprint is the library's, never the placement's.
  const reported = [...errors, ...warned];
  const critical = reported.filter((v) => profile.criticalDrc.includes(v.type)).length;
  const placementCritical = reported.filter((v) => PLACEMENT_CRITICAL_DRC.includes(v.type)).length;
  return {
    checker,
    status: statusOf(d),
    diagnostics: d,
    metrics: { drc_error_count: errors.length, drc_critical_count: critical, drc_placement_critical_count: placementCritical, drc_warning_count: warnings.length, kicad_unconnected: unrouted },
    evidence: [{ kind: 'kicad-drc-report', note: `${errors.length} errors, ${warnings.length} warnings, ${unrouted} unconnected` }],
  };
}
