/**
 * The intent language (RFC 11 §7.3, implementation spec §7.3): the YAML a
 * user or the compiler writes, addressed by refdes, turned into registry
 * entries with the layout fields. Unknown keys are reported, not ignored:
 * the caller turns them into HOLD.
 */
import { parse as parseYaml } from 'yaml';
import type { Constraint } from '../../memory/constraints.js';

export interface IntentEntry extends Constraint {
  key: string;
}

export interface ParsedIntent {
  entries: IntentEntry[];
  /** Keys the language does not define; the run holds on them. */
  unknown: string[];
  /** Entries that could not be formed (missing fields), with the reason. */
  errors: string[];
}

const EDGES = ['north', 'south', 'east', 'west'];
const mm = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => !!x) : []);

export function parseIntent(text: string, source = 'intent'): ParsedIntent {
  const doc = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const entries: IntentEntry[] = [];
  const unknown: string[] = [];
  const errors: string[] = [];
  const base = (cls: Constraint['class'], severity: Constraint['severity'], refs: string[], parameters: Constraint['parameters'], priority = 50): Omit<Constraint, 'source' | 'affects'> => ({ class: cls, severity, scope: { refs }, parameters: parameters ?? {}, priority, confidence: 1, approvedBy: 'user' });
  const push = (key: string, c: Omit<Constraint, 'source' | 'affects'>) => entries.push({ key, source, affects: ['board'], ...c });
  for (const top of Object.keys(doc)) if (!['placement', 'routing', 'electrical'].includes(top)) unknown.push(top);
  const placement = (doc.placement ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(placement)) if (!['fixed', 'attachments', 'groups', 'separation', 'keepouts', ...PLACEMENT_INTENT_KEYS].includes(k)) unknown.push(`placement.${k}`);
  parsePlacementIntent(placement, (doc.electrical ?? {}) as Record<string, unknown>, { push, base, unknown, errors });
  for (const [i, f] of ((placement.fixed as unknown[]) ?? []).entries()) {
    const o = (f ?? {}) as Record<string, unknown>;
    const ref = str(o.component);
    if (!ref) {
      errors.push(`placement.fixed[${i}]: no component`);
      continue;
    }
    for (const k of Object.keys(o)) if (!['component', 'edge', 'orientation', 'at', 'rotation_deg'].includes(k)) unknown.push(`placement.fixed[${i}].${k}`);
    if (o.edge !== undefined) {
      const edge = str(o.edge);
      if (!edge || !EDGES.includes(edge)) {
        errors.push(`placement.fixed[${i}]: edge must be one of ${EDGES.join(', ')}`);
        continue;
      }
      const orientation = str(o.orientation);
      push(`layout.mechanical.edge.${ref}`, base('mechanical', 'hard', [ref], { edge, ...(orientation ? { orientation } : {}) }, 90));
    }
    if (Array.isArray(o.at) && o.at.length === 2) {
      const x = mm(o.at[0]), y = mm(o.at[1]);
      if (x === null || y === null) {
        errors.push(`placement.fixed[${i}]: at must be [x_mm, y_mm]`);
        continue;
      }
      push(`layout.mechanical.fixed.${ref}`, base('mechanical', 'hard', [ref], { x_nm: x, y_nm: y, ...(typeof o.rotation_deg === 'number' ? { rotation_mdeg: Math.round(o.rotation_deg * 1000) } : {}) }, 100));
    }
    if (o.edge === undefined && o.at === undefined) errors.push(`placement.fixed[${i}]: ${ref} needs an edge or an at`);
  }
  for (const [i, a] of ((placement.attachments as unknown[]) ?? []).entries()) {
    const o = (a ?? {}) as Record<string, unknown>;
    const ref = str(o.component);
    const target = (o.target ?? {}) as Record<string, unknown>;
    const to = str(target.component);
    const max = mm(o.max_distance_mm);
    if (!ref || !to || max === null) {
      errors.push(`placement.attachments[${i}]: needs component, target.component, and max_distance_mm`);
      continue;
    }
    for (const k of Object.keys(o)) if (!['component', 'target', 'max_distance_mm', 'priority'].includes(k)) unknown.push(`placement.attachments[${i}].${k}`);
    const priority = str(o.priority) ?? 'normal';
    push(`layout.relative.attached.${ref}`, base('relative', priority === 'critical' ? 'hard' : 'soft', [ref, to], { target: to, pins: list(target.pins), max_distance_nm: max, priority }, priority === 'critical' ? 80 : 40));
  }
  for (const [i, g] of ((placement.groups as unknown[]) ?? []).entries()) {
    const o = (g ?? {}) as Record<string, unknown>;
    const id = str(o.id);
    const members = list(o.components);
    if (!id || !members.length) {
      errors.push(`placement.groups[${i}]: needs id and components`);
      continue;
    }
    for (const k of Object.keys(o)) if (!['id', 'components', 'topology', 'max_spread_mm', 'region'].includes(k)) unknown.push(`placement.groups[${i}].${k}`);
    const spread = mm(o.max_spread_mm);
    // `region: [x, y, w, h]` in board millimetres. Until now a group could say
    // which parts belong together and how far they may spread, but not where
    // they go: a floorplan had to be smuggled in as a pinned anchor plus a
    // spread budget, which is a disc, not a rectangle. Stored the way
    // `blocksToConstraints` stores a derived region, so the intent checker and
    // the legalizer read one shape whatever produced it.
    let region: string | undefined;
    if (o.region !== undefined) {
      const r = Array.isArray(o.region) ? o.region.map((v) => mm(v)) : [];
      if (r.length !== 4 || r.some((v) => v === null)) errors.push(`placement.groups[${i}]: region must be [x_mm, y_mm, w_mm, h_mm]`);
      else {
        const [x, y, w, h] = r as number[];
        if (w! <= 0 || h! <= 0) errors.push(`placement.groups[${i}]: region needs a positive width and height`);
        else region = JSON.stringify([[x, y], [x! + w!, y], [x! + w!, y! + h!], [x, y! + h!]]);
      }
    }
    push(`layout.functional.group.${id}`, base('functional', region ? 'hard' : 'soft', members, { members, ...(str(o.topology) ? { topology: str(o.topology)! } : {}), ...(spread !== null ? { spread_budget_nm: spread } : {}), ...(region ? { region } : {}) }, region ? 70 : 50));
  }
  for (const [i, s] of ((placement.separation as unknown[]) ?? []).entries()) {
    const o = (s ?? {}) as Record<string, unknown>;
    const groups = list(o.groups);
    const min = mm(o.minimum_mm);
    if (groups.length !== 2 || min === null) {
      errors.push(`placement.separation[${i}]: needs two groups and minimum_mm`);
      continue;
    }
    push(`layout.functional.separation.${groups[0]}-${groups[1]}`, base('functional', 'hard', [], { groups, min_nm: min }, 60));
  }
  for (const [i, k] of ((placement.keepouts as unknown[]) ?? []).entries()) {
    const o = (k ?? {}) as Record<string, unknown>;
    const region = str(o.region);
    if (!region) {
      errors.push(`placement.keepouts[${i}]: needs region`);
      continue;
    }
    const radius = mm(o.radius_mm);
    push(`layout.manufacturing.keepout.${region}`, base('manufacturing', 'hard', [], { region, prohibit: list(o.prohibit).length ? list(o.prohibit) : ['components', 'copper'], ...(radius !== null ? { radius_nm: radius } : {}) }, 90));
  }
  const routing = (doc.routing ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(routing)) if (!['priorities', 'layers', 'widths', 'currents'].includes(k)) unknown.push(`routing.${k}`);
  for (const [i, w] of ((routing.widths as unknown[]) ?? []).entries()) {
    const o = (w ?? {}) as Record<string, unknown>;
    const net = str(o.net);
    const min = mm(o.min_width_mm);
    if (!net || min === null) {
      errors.push(`routing.widths[${i}]: needs net and min_width_mm`);
      continue;
    }
    push(`layout.routing.width.${net}`, base('routing', 'hard', [], { min_width_nm: min, net }, 70));
    entries[entries.length - 1]!.scope = { nets: [net] };
  }
  for (const [i, c] of ((routing.currents as unknown[]) ?? []).entries()) {
    const o = (c ?? {}) as Record<string, unknown>;
    const net = str(o.net);
    const amps = typeof o.amps === 'number' ? o.amps : null;
    if (!net || amps === null) {
      errors.push(`routing.currents[${i}]: needs net and amps`);
      continue;
    }
    // the physics compiler turns this into a width; kept as a requirement so the report can cite it
    push(`layout.electrical-layout.current.${net}`, base('electrical-layout', 'hard', [], { amps, net, ...(typeof o.rise_c === 'number' ? { rise_c: o.rise_c } : {}) }, 70));
    entries[entries.length - 1]!.scope = { nets: [net] };
  }
  if (Array.isArray(routing.priorities)) {
    const order = (routing.priorities as unknown[]).map((tier) => list(tier));
    push('layout.routing.priority', base('routing', 'soft', order.flat().filter((n) => n !== 'remaining'), { order: JSON.stringify(order) }));
  }
  return { entries, unknown: [...new Set(unknown)], errors };
}

/** Placement intent keys (add-reuse-placer, pcb-placement-intent): critical relationships and the checks that measure them. */
export const PLACEMENT_INTENT_KEYS = ['critical', 'hot_loops', 'chains', 'isolation', 'channels', 'rf', 'edge_distance', 'thermal', 'exposed_pads', 'matched'];

type Push = (key: string, c: Omit<Constraint, 'source' | 'affects'>) => void;
type Base = (cls: Constraint['class'], severity: Constraint['severity'], refs: string[], parameters: Constraint['parameters'], priority?: number) => Omit<Constraint, 'source' | 'affects'>;

function parsePlacementIntent(placement: Record<string, unknown>, electrical: Record<string, unknown>, io: { push: Push; base: Base; unknown: string[]; errors: string[] }): void {
  const { push, base, unknown, errors } = io;
  const items = (k: string) => ((Array.isArray(placement[k]) ? placement[k] : []) as unknown[]).map((x) => (x ?? {}) as Record<string, unknown>);
  const known = (path: string, o: Record<string, unknown>, keys: string[]) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) unknown.push(`${path}.${k}`);
  };
  // a number from the user makes the check hard; without one it is a measured, soft relationship
  const sev = (limit: number | null): Constraint['severity'] => (limit === null ? 'soft' : 'hard');
  const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
  for (const [i, o] of items('hot_loops').entries()) {
    known(`placement.hot_loops[${i}]`, o, ['kind', 'parts', 'max_area_mm2']);
    const parts = list(o.parts);
    if (parts.length < 2) {
      errors.push(`placement.hot_loops[${i}]: needs at least two parts`);
      continue;
    }
    const area = typeof o.max_area_mm2 === 'number' ? Math.round(o.max_area_mm2 * 1e12) : null;
    push(`layout.emc.hot-loop.${slug(parts.join('-'))}`, base('emc', sev(area), parts, { kind: str(o.kind) ?? 'switching', parts, ...(area !== null ? { max_area_nm2: area } : {}) }, 70));
  }
  for (const [i, o] of items('chains').entries()) {
    known(`placement.chains[${i}]`, o, ['order', 'max_length_mm']);
    const order = list(o.order);
    if (order.length < 3) {
      errors.push(`placement.chains[${i}]: needs an order of at least three parts`);
      continue;
    }
    const len = mm(o.max_length_mm);
    push(`layout.relative.chain.${slug(order.join('-'))}`, base('relative', 'hard', order, { order, ...(len !== null ? { max_length_nm: len } : {}) }, 60));
  }
  for (const [i, o] of items('isolation').entries()) {
    known(`placement.isolation[${i}]`, o, ['noisy', 'sensitive', 'min_mm']);
    const noisy = list(o.noisy), sensitive = list(o.sensitive), min = mm(o.min_mm);
    if (!noisy.length || !sensitive.length) {
      errors.push(`placement.isolation[${i}]: needs noisy and sensitive parts`);
      continue;
    }
    push(`layout.emc.isolation.${i}`, base('emc', sev(min), [...noisy, ...sensitive], { noisy, sensitive, ...(min !== null ? { min_nm: min } : {}) }, 60));
  }
  for (const [i, o] of items('channels').entries()) {
    known(`placement.channels[${i}]`, o, ['left', 'right', 'min_mm']);
    const left = list(o.left), right = list(o.right), min = mm(o.min_mm);
    if (!left.length || !right.length) {
      errors.push(`placement.channels[${i}]: needs left and right parts`);
      continue;
    }
    push(`layout.emc.channel.${i}`, base('emc', sev(min), [...left, ...right], { left, right, ...(min !== null ? { min_nm: min } : {}) }, 50));
  }
  for (const [i, o] of items('rf').entries()) {
    known(`placement.rf[${i}]`, o, ['ref', 'edge', 'clearance_mm']);
    const ref = str(o.ref), clr = mm(o.clearance_mm);
    if (!ref) {
      errors.push(`placement.rf[${i}]: needs ref`);
      continue;
    }
    push(`layout.rf.edge.${ref}`, base('emc', 'hard', [ref], { ...(str(o.edge) ? { edge: str(o.edge)! } : {}), ...(clr !== null ? { clearance_nm: clr } : {}) }, 80));
  }
  for (const [i, o] of items('edge_distance').entries()) {
    known(`placement.edge_distance[${i}]`, o, ['ref', 'min_mm']);
    const ref = str(o.ref), min = mm(o.min_mm);
    if (!ref || min === null) {
      errors.push(`placement.edge_distance[${i}]: needs ref and min_mm`);
      continue;
    }
    push(`layout.emc.edge-distance.${ref}`, base('emc', 'hard', [ref], { min_nm: min }, 60));
  }
  for (const [i, o] of items('critical').entries()) {
    known(`placement.critical[${i}]`, o, ['class', 'refs', 'pins', 'max_mm', 'min_mm', 'order']);
    const cls = str(o.class), refs = list(o.refs), max = mm(o.max_mm);
    if (!cls || refs.length < 1) {
      errors.push(`placement.critical[${i}]: needs class and refs`);
      continue;
    }
    if (['supply-decoupling', 'bootstrap', 'config', 'crystal'].includes(cls) && refs.length >= 2) {
      const pins = list(o.pins).map((p) => p.split('.').slice(1).join('.'));
      push(`layout.relative.attached.${refs[0]}`, base('relative', max === null ? 'soft' : 'hard', [refs[0]!, refs[1]!], { target: refs[1]!, pins, max_distance_nm: max ?? 2_000_000, priority: 'normal', relation: cls }, 70));
    } else if (cls === 'output-chain' && list(o.order).length >= 3) {
      push(`layout.relative.chain.${slug(list(o.order).join('-'))}`, base('relative', 'hard', list(o.order), { order: list(o.order) }, 60));
    } else {
      push(`layout.critical.${slug(cls)}.${slug(refs.join('-'))}`, base('functional', 'advisory', refs, { class: cls, refs }, 20));
    }
  }
  for (const [i, o] of items('thermal').entries()) {
    known(`placement.thermal[${i}]`, o, ['hot', 'protect', 'min_mm']);
    const hot = list(o.hot), protect = list(o.protect), min = mm(o.min_mm);
    if (!hot.length || !protect.length || min === null) {
      errors.push(`placement.thermal[${i}]: needs hot, protect, and min_mm`);
      continue;
    }
    push(`layout.thermal.distance.${i}`, base('thermal', 'hard', [...hot, ...protect], { hot, protect, min_nm: min }, 50));
  }
  for (const ref of list(placement.exposed_pads)) push(`layout.thermal.exposed-pad.${ref}`, base('thermal', 'soft', [ref], {}, 30));
  for (const [i, o] of items('matched').entries()) {
    known(`placement.matched[${i}]`, o, ['pairs', 'max_offset_mm']);
    const pairs = (Array.isArray(o.pairs) ? o.pairs : []).map((p) => list(p)).filter((p) => p.length === 2);
    if (!pairs.length) {
      errors.push(`placement.matched[${i}]: needs pairs`);
      continue;
    }
    const off = mm(o.max_offset_mm);
    push(`layout.electrical-layout.matched.${i}`, base('electrical-layout', 'soft', pairs.flat(), { pairs: JSON.stringify(pairs), ...(off !== null ? { max_offset_nm: off } : {}) }, 40));
  }
  const voltages = (electrical.voltages ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(electrical)) if (k !== 'voltages') unknown.push(`electrical.${k}`);
  for (const [net, v] of Object.entries(voltages)) {
    const volts = typeof v === 'number' ? v : typeof v === 'object' && v && typeof (v as { volts?: unknown }).volts === 'number' ? (v as { volts: number }).volts : null;
    if (volts === null) {
      errors.push(`electrical.voltages.${net}: needs a number of volts`);
      continue;
    }
    const kind = typeof v === 'object' && v ? str((v as { kind?: unknown }).kind) ?? 'dc' : 'dc';
    push(`layout.electrical-layout.voltage.${net}`, { ...base('electrical-layout', 'hard', [], { net, volts: Math.round(volts * 1000), kind }, 80), scope: { nets: [net] } });
  }
}

export function intentToRegistry(parsed: ParsedIntent): Record<string, Constraint> {
  const out: Record<string, Constraint> = {};
  for (const { key, ...c } of parsed.entries) out[key] = c;
  return out;
}
