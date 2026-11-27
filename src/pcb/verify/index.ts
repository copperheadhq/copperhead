/**
 * Verification entry point: run the built-in checkers over a design (and the
 * KiCad DRC report when the caller has one), record disagreements, and gate.
 * LLM-free and network-free by construction; reachable from `check`.
 */
import type { PcbDesign, ZoneFill } from '../ir/types.js';
import type { CheckReport } from '../../kicad/report.js';
import { loadProfile, type FabricationProfile } from './profiles/index.js';
import { checkGeometry } from './checkers/geometry.js';
import { checkConnectivity } from './checkers/connectivity.js';
import { fromDrcReport } from './checkers/kicad-drc.js';
import { checkPreflight, type PreflightInputs } from './checkers/preflight.js';
import { checkReturnPath } from './checkers/returnpath.js';
import { checkIntent } from './checkers/intent.js';
import { checkPlacementIntent } from './checkers/placement-intent.js';
import type { Constraint } from '../../memory/constraints.js';
import { preflightGate, placementGate, routingGate, type GateResult } from './gates.js';
import type { CheckResult, Diagnostic } from './diagnostic.js';

export interface VerifyInput {
  design: PcbDesign;
  profile?: FabricationProfile | string;
  fills?: ZoneFill[];
  drc?: CheckReport;
  kicadVersion?: string;
  preflight?: PreflightInputs;
  /** Layout constraints (intent + ECAD-derived) for the intent checker; entries without `class` are ignored. */
  constraints?: Record<string, Constraint>;
}

export interface Disagreement {
  code: string;
  entityReferences: string[];
  a: { checker: string; says: string };
  b: { checker: string; says: string };
}

export interface VerifyResult {
  profile: FabricationProfile;
  results: CheckResult[];
  diagnostics: Diagnostic[];
  metrics: Record<string, number>;
  gates: { preflight: GateResult; placement: GateResult; routing: GateResult };
  disagreements: Disagreement[];
}

export function verifyDesign(input: VerifyInput): VerifyResult {
  const profile = typeof input.profile === 'string' ? loadProfile(input.profile) : (input.profile ?? loadProfile(input.design.board.fabricationProfile));
  const results: CheckResult[] = [
    checkPreflight(input.design, profile, input.preflight ?? {}),
    checkGeometry(input.design, profile),
    checkConnectivity(input.design, input.fills ?? []),
    checkReturnPath(input.design, input.fills ?? []),
  ];
  if (input.drc) results.push(fromDrcReport(input.drc, profile, input.kicadVersion));
  if (input.constraints && Object.keys(input.constraints).length) {
    results.push(checkIntent(input.design, input.constraints));
    results.push(checkPlacementIntent(input.design, input.constraints));
  }
  const diagnostics = results.flatMap((r) => r.diagnostics);
  const metrics: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.metrics)) metrics[k] = v;
  const disagreements: Disagreement[] = [];
  // shorts: copperhead says short, KiCad has no shorting_items (or vice versa)
  const ourShort = diagnostics.filter((d) => d.code === 'conn.short');
  if (input.drc) {
    const kicadShorts = input.drc.violations.filter((v) => v.type === 'shorting_items').length;
    if (ourShort.length && !kicadShorts) disagreements.push({ code: 'conn.short', entityReferences: ourShort.flatMap((d) => d.entityReferences), a: { checker: 'copperhead-connectivity', says: `${ourShort.length} short(s)` }, b: { checker: 'kicad-drc', says: 'no shorting_items' } });
    if (!ourShort.length && kicadShorts) disagreements.push({ code: 'conn.short', entityReferences: [], a: { checker: 'copperhead-connectivity', says: 'no shorts' }, b: { checker: 'kicad-drc', says: `${kicadShorts} shorting_items` } });
    const ours = metrics.unrouted_count ?? 0;
    const theirs = input.drc.unrouted ?? 0;
    if (ours !== theirs) disagreements.push({ code: 'conn.unrouted', entityReferences: [], a: { checker: 'copperhead-connectivity', says: `${ours} unrouted` }, b: { checker: 'kicad-drc', says: `${theirs} unconnected items` } });
  }
  return {
    profile,
    results,
    diagnostics,
    metrics,
    gates: { preflight: preflightGate(diagnostics), placement: placementGate(diagnostics, profile), routing: routingGate(diagnostics, profile) },
    disagreements,
  };
}
