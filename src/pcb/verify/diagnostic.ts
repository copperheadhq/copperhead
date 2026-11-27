/**
 * Normalized diagnostics (RFC 11 §10.3, implementation spec §5.1): every
 * checker emits this shape, the repair planner reads only this shape, and the
 * code registry below is the single list of what the harness can say.
 */
import type { Polygon } from '../ir/geometry.js';

export type DiagnosticCategory = 'geometry' | 'connectivity' | 'drc' | 'intent' | 'quality' | 'preflight';
export type Severity = 'error' | 'warning' | 'info';

export type RepairActionType =
  | 'continue-routing'
  | 'change-net-priority'
  | 'select-router'
  | 'tune-router'
  | 'rip-up-nets'
  | 'move-group'
  | 'resize-region'
  | 'rotate-component'
  | 'use-ranked-candidate'
  | 'request-user-action';

export interface Quantity {
  value: number;
  unit: 'nm' | 'mdeg' | 'count' | 'ratio' | 'nm2';
}

export interface Diagnostic {
  code: string;
  category: DiagnosticCategory;
  severity: Severity;
  entityIds: string[];
  entityReferences: string[];
  region?: Polygon;
  measured?: Quantity;
  allowed?: Quantity & { relation: '<=' | '>=' | '==' | '!=' };
  message: string;
  suggestedActions: RepairActionType[];
  sourceChecker: { id: string; version: string };
}

/** RFC 6 §5.4 check result states. */
export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'BLOCKED';

export interface CheckResult {
  checker: { id: string; version: string };
  status: CheckStatus;
  diagnostics: Diagnostic[];
  metrics: Record<string, number>;
  evidence: { kind: string; path?: string; note?: string }[];
}

export interface CodeInfo {
  category: DiagnosticCategory;
  severity: Severity;
  /** Which gate the code feeds when it is an error (implementation spec §5.5). */
  gate: 'placement' | 'routing' | 'preflight' | 'none';
  summary: string;
}

/** Every code the built-in checkers can emit. Adding one is a row here plus a golden case. */
export const CODES: Record<string, CodeInfo> = {
  'geom.outside-board': { category: 'geometry', severity: 'error', gate: 'placement', summary: 'copper or a footprint lies outside the board outline' },
  'geom.overhang': { category: 'geometry', severity: 'warning', gate: 'none', summary: 'a courtyard extends past the outline while its copper stays inside (edge connectors)' },
  'geom.courtyard-overlap': { category: 'geometry', severity: 'error', gate: 'placement', summary: 'two courtyards on the same side overlap' },
  'geom.degenerate': { category: 'geometry', severity: 'error', gate: 'routing', summary: 'zero-length track or zero-size copper' },
  'geom.width': { category: 'geometry', severity: 'error', gate: 'routing', summary: 'track narrower than the profile minimum' },
  'geom.via-layers': { category: 'geometry', severity: 'error', gate: 'routing', summary: 'via does not span two copper layers' },
  'geom.unknown-layer': { category: 'geometry', severity: 'error', gate: 'routing', summary: 'object on a layer the board does not have' },
  'geom.in-cutout': { category: 'geometry', severity: 'error', gate: 'placement', summary: 'copper or a footprint lies inside a board cutout' },
  'conn.short': { category: 'connectivity', severity: 'error', gate: 'routing', summary: 'copper joins two nets' },
  // an owed connection is completion (PARTIAL), never a gate, until a net is declared mandatory (RFC 11 §10.5, Phase 4)
  'conn.open': { category: 'connectivity', severity: 'warning', gate: 'none', summary: 'a net with copper is not fully connected' },
  'conn.unrouted': { category: 'connectivity', severity: 'info', gate: 'none', summary: 'connections a net still owes (completion, not a violation)' },
  'conn.dangling': { category: 'connectivity', severity: 'warning', gate: 'none', summary: 'track or via touches nothing else' },
  'drc.*': { category: 'drc', severity: 'error', gate: 'routing', summary: 'a KiCad DRC violation, gated by the profile\'s critical list' },
  'drc.kct.*': { category: 'drc', severity: 'warning', gate: 'none', summary: 'a kicad-tools check finding, advisory beside KiCad' },
  // a warning by default (KiCad's own default for missing_courtyard is ignore): overlap falls back to pad extents; a project's rule_severities can raise it
  'preflight.courtyard': { category: 'preflight', severity: 'warning', gate: 'preflight', summary: 'a footprint has no courtyard, so overlap is checked on pad extents only' },
  'preflight.outline': { category: 'preflight', severity: 'error', gate: 'preflight', summary: 'the board has no single closed outline' },
  'preflight.annular': { category: 'preflight', severity: 'error', gate: 'preflight', summary: 'through-hole pad annular ring below the profile minimum' },
  'preflight.parity': { category: 'preflight', severity: 'error', gate: 'preflight', summary: 'board and schematic disagree' },
  'preflight.pad-count': { category: 'preflight', severity: 'error', gate: 'preflight', summary: 'footprint pad count differs from the symbol pin count' },
  'preflight.unconnected-pin': { category: 'preflight', severity: 'error', gate: 'preflight', summary: 'a pin with no net and no no-connect flag' },
  'preflight.stack': { category: 'preflight', severity: 'error', gate: 'preflight', summary: 'the copper layers are not a stack this release supports (F.Cu, In1..InN.Cu, B.Cu; up to six)' },
  'preflight.profile': { category: 'preflight', severity: 'error', gate: 'preflight', summary: 'the configured fabrication profile is for a different layer count than the board' },
  'preflight.utilisation': { category: 'preflight', severity: 'warning', gate: 'preflight', summary: 'courtyard area against board area is above what designers build (warn) or cannot be placed at all (error)' },
  'intent.mechanical.fixed': { category: 'intent', severity: 'error', gate: 'placement', summary: 'a part is not at its fixed position' },
  'intent.mechanical.edge': { category: 'intent', severity: 'error', gate: 'placement', summary: 'a part constrained to a board edge is not on it' },
  'intent.mechanical.orientation': { category: 'intent', severity: 'info', gate: 'none', summary: 'orientation is declared but not evaluated in this release' },
  'intent.relative.attached': { category: 'intent', severity: 'error', gate: 'placement', summary: 'a part is farther from the pins it attaches to than allowed' },
  'intent.functional.group.spread': { category: 'intent', severity: 'warning', gate: 'none', summary: 'a block is spread beyond its budget' },
  'intent.functional.group.region': { category: 'intent', severity: 'error', gate: 'placement', summary: 'a block member is outside the region its subsystem was given' },
  'intent.functional.separation': { category: 'intent', severity: 'error', gate: 'placement', summary: 'two blocks are closer than their minimum separation' },
  'intent.manufacturing.keepout': { category: 'intent', severity: 'error', gate: 'placement', summary: 'a part lies in a keepout' },
  'intent.routing.width': { category: 'intent', severity: 'error', gate: 'routing', summary: 'a net is routed narrower than its required width' },
  // placement intent (add-reuse-placer): measured on every placement; a declared number makes the constraint hard, and a hard one gates
  'intent.emc.hot-loop': { category: 'intent', severity: 'warning', gate: 'none', summary: 'a switching or supply current loop encloses more area than allowed' },
  'intent.emc.isolation': { category: 'intent', severity: 'warning', gate: 'none', summary: 'a sensitive part is closer to a noisy one than allowed' },
  'intent.emc.channel': { category: 'intent', severity: 'warning', gate: 'none', summary: 'two channels are closer than their minimum separation' },
  'intent.emc.edge-distance': { category: 'intent', severity: 'warning', gate: 'none', summary: 'a part is closer to the board edge or a connector than allowed' },
  'intent.rf.edge': { category: 'intent', severity: 'warning', gate: 'none', summary: 'a radio module or antenna is not at a board edge' },
  'intent.rf.clearance': { category: 'intent', severity: 'warning', gate: 'none', summary: 'a part sits inside a radio module\'s keepout' },
  'intent.relative.chain.order': { category: 'intent', severity: 'warning', gate: 'none', summary: 'a part is out of order along a declared chain' },
  'intent.relative.chain.length': { category: 'intent', severity: 'error', gate: 'placement', summary: 'a declared chain is longer than allowed' },
  'intent.functional.group.intrusion': { category: 'intent', severity: 'warning', gate: 'none', summary: 'a part from another subsystem sits inside a subsystem\'s hull' },
  'intent.*': { category: 'intent', severity: 'error', gate: 'placement', summary: 'a declared layout constraint is violated' },
  'quality.*': { category: 'quality', severity: 'info', gate: 'none', summary: 'a scored quality signal' },
};

export function codeInfo(code: string): CodeInfo | undefined {
  if (CODES[code]) return CODES[code];
  const prefix = code.split('.').slice(0, code.startsWith('drc.kct.') ? 2 : 1).join('.') + '.*';
  return CODES[prefix];
}

export function make(
  checker: { id: string; version: string },
  code: string,
  fields: Omit<Diagnostic, 'code' | 'category' | 'severity' | 'sourceChecker' | 'suggestedActions'> & { severity?: Severity; suggestedActions?: RepairActionType[] },
): Diagnostic {
  const info = codeInfo(code);
  return {
    code,
    category: info?.category ?? 'quality',
    severity: fields.severity ?? info?.severity ?? 'info',
    entityIds: fields.entityIds,
    entityReferences: fields.entityReferences,
    ...(fields.region ? { region: fields.region } : {}),
    ...(fields.measured ? { measured: fields.measured } : {}),
    ...(fields.allowed ? { allowed: fields.allowed } : {}),
    message: fields.message,
    suggestedActions: fields.suggestedActions ?? [],
    sourceChecker: checker,
  };
}

export function statusOf(diags: Diagnostic[]): CheckStatus {
  if (diags.some((d) => d.severity === 'error')) return 'FAIL';
  if (diags.some((d) => d.severity === 'warning')) return 'WARN';
  return 'PASS';
}
