/**
 * Hard gates (RFC 11 §10.4, §10.5, ADR 0006): which diagnostics make a
 * candidate ineligible. Unrouted connections never gate; they are completion.
 */
import type { Diagnostic } from './diagnostic.js';
import { codeInfo } from './diagnostic.js';
import type { FabricationProfile } from './profiles/index.js';

export interface GateResult {
  passed: boolean;
  failures: Diagnostic[];
}

const isCriticalDrc = (d: Diagnostic, profile: FabricationProfile): boolean => d.code.startsWith('drc.') && !d.code.startsWith('drc.kct.') && profile.criticalDrc.includes(d.code.slice(4));

export function preflightGate(diags: Diagnostic[]): GateResult {
  const failures = diags.filter((d) => d.severity === 'error' && d.category === 'preflight');
  return { passed: failures.length === 0, failures };
}

export function placementGate(diags: Diagnostic[], profile: FabricationProfile): GateResult {
  const failures = diags.filter((d) => {
    if (d.severity !== 'error') return false;
    const info = codeInfo(d.code);
    if (info?.gate === 'placement' || info?.gate === 'preflight') return true;
    // A hard intent constraint is a gate (RFC 15 Section 11.1): an error from
    // any placement intent, hot loops, isolation, and RF clearance included,
    // makes the candidate ineligible. Routing intent gates routing.
    if (d.code.startsWith('intent.') && !d.code.startsWith('intent.routing.')) return true;
    return isCriticalDrc(d, profile) && ['courtyards_overlap', 'pth_inside_courtyard', 'copper_edge_clearance', 'items_not_allowed', 'invalid_outline'].includes(d.code.slice(4));
  });
  return { passed: failures.length === 0, failures };
}

export function routingGate(diags: Diagnostic[], profile: FabricationProfile): GateResult {
  const failures = diags.filter((d) => {
    if (d.severity !== 'error') return false;
    const info = codeInfo(d.code);
    if (d.code === 'conn.unrouted') return false;
    if (info?.gate === 'routing' || info?.gate === 'placement' || info?.gate === 'preflight') return true;
    if (d.code.startsWith('intent.routing.width')) return true;
    return isCriticalDrc(d, profile);
  });
  return { passed: failures.length === 0, failures };
}
