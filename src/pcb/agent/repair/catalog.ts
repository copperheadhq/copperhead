/**
 * Repair catalog (RFC 11 §12, implementation spec §9.1): the actions the
 * closed loop may take, each with a parameter shape and a cost estimate. A
 * hard-constraint relaxation is not an action: it can only surface as
 * `request-user-action`, which ends the run in HOLD.
 */
import type { RepairActionType } from '../../verify/diagnostic.js';

export interface RepairAction {
  type: RepairActionType;
  /** Why this action, in one sentence, for the run record. */
  reason: string;
  parameters: Record<string, string | number | boolean | string[]>;
}

export interface CatalogEntry {
  type: RepairActionType;
  summary: string;
  parameters: Record<string, string>;
  /** Which stage the action re-runs; 'routing-owed' routes only the owed nets over the copper kept. */
  reruns: 'placement' | 'routing' | 'routing-owed' | 'none';
  /** Diagnostic code prefixes the action is a plausible answer to. */
  answers: string[];
}

export const CATALOG: CatalogEntry[] = [
  { type: 'continue-routing', summary: 'keep the copper routed so far and route only the owed nets with what is left of the budget', parameters: { nets: 'string[]' }, reruns: 'routing-owed', answers: ['conn.unrouted'] },
  { type: 'change-net-priority', summary: 'route the named nets first (or last) on the next routing pass', parameters: { nets: 'string[]', first: 'boolean' }, reruns: 'routing', answers: ['conn.unrouted', 'conn.open', 'intent.routing.width'] },
  { type: 'select-router', summary: 'route with a different registered engine', parameters: { routerId: 'string' }, reruns: 'routing', answers: ['conn.unrouted', 'drc.', 'conn.short'] },
  { type: 'tune-router', summary: 'change an engine knob (passes, strategy) and route again', parameters: { passes: 'number', strategy: 'string' }, reruns: 'routing', answers: ['conn.unrouted', 'drc.clearance', 'drc.track_width'] },
  { type: 'rip-up-nets', summary: 'remove the named nets\' copper and route them again', parameters: { nets: 'string[]' }, reruns: 'routing', answers: ['conn.short', 'drc.', 'intent.routing.width'] },
  { type: 'move-group', summary: 'move the named parts by a vector, or a block to a slot, then place the rest again', parameters: { refs: 'string[]', dx_mm: 'number', dy_mm: 'number' }, reruns: 'placement', answers: ['geom.courtyard-overlap', 'geom.outside-board', 'intent.mechanical.', 'intent.relative.', 'intent.functional.', 'intent.manufacturing.keepout', 'quality.congestion'] },
  { type: 'resize-region', summary: 'widen or narrow a block\'s signal-flow region and place again', parameters: { block: 'string', scale: 'number' }, reruns: 'placement', answers: ['intent.functional.group.', 'quality.congestion'] },
  { type: 'rotate-component', summary: 'rotate a part and place the rest again', parameters: { ref: 'string', degrees: 'number' }, reruns: 'placement', answers: ['intent.mechanical.orientation', 'quality.congestion', 'conn.unrouted'] },
  { type: 'use-ranked-candidate', summary: 'take the next eligible candidate from the last ranking instead of the selected one', parameters: { rank: 'number' }, reruns: 'none', answers: ['drc.', 'quality.'] },
  { type: 'request-user-action', summary: 'stop and ask: a hard constraint cannot be met by any action here (HOLD)', parameters: { question: 'string' }, reruns: 'none', answers: ['intent.', 'preflight.'] },
];

export function catalogEntry(type: RepairActionType): CatalogEntry | undefined {
  return CATALOG.find((c) => c.type === type);
}

/** Cost estimate: a routing rerun costs what the last routing run cost, routing only the owed nets half of it; a placement action costs a placement plus a routing rerun. */
export function estimate(action: RepairAction, last: { routingSeconds: number; placementSeconds: number }): { engineSeconds: number; wallSeconds: number } {
  const entry = catalogEntry(action.type);
  const routing = Math.max(5, last.routingSeconds);
  const placement = Math.max(2, last.placementSeconds);
  if (!entry || entry.reruns === 'none') return { engineSeconds: 0, wallSeconds: 1 };
  if (entry.reruns === 'routing') return { engineSeconds: routing, wallSeconds: routing * 1.2 + 5 };
  if (entry.reruns === 'routing-owed') return { engineSeconds: routing / 2, wallSeconds: routing * 0.6 + 5 };
  return { engineSeconds: placement + routing, wallSeconds: (placement + routing) * 1.2 + 10 };
}
