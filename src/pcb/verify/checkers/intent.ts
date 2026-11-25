/**
 * Intent checker (RFC 11 §10.2, implementation spec §5.3): one evaluator per
 * constraint class, each producing `intent.<class>.<parameter>` diagnostics
 * with measured and allowed values. `hard` → error, `soft` → warning,
 * `advisory` → info. Refdes in scopes resolve to components here.
 */
import type { PcbDesign, ComponentInstance } from '../../ir/types.js';
import type { Polygon } from '../../ir/geometry.js';
import { bbox, bboxOf, centroid, contains, distance as polyDistance, intersects, circle } from '../../ir/geometry.js';
import type { Constraint } from '../../../memory/constraints.js';
import { make, statusOf, type Diagnostic, type Severity, type CheckResult } from '../diagnostic.js';

export const INTENT_CHECKER = { id: 'intent', version: '1' };

const sev = (c: Constraint): Severity => (c.severity === 'hard' ? 'error' : c.severity === 'soft' ? 'warning' : 'info');
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

function extent(c: ComponentInstance): Polygon | null {
  if (c.footprint.courtyard) return c.footprint.courtyard;
  if (!c.pads.length) return null;
  const b = bboxOf(c.pads.map((p) => p.copper));
  return { outer: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], holes: [] };
}

export function checkIntent(design: PcbDesign, registry: Record<string, Constraint>): CheckResult {
  const d: Diagnostic[] = [];
  const byRef = new Map(design.components.map((c) => [c.reference, c]));
  const ob = bbox(design.board.outline);
  const groups = new Map<string, Constraint>();
  for (const [key, c] of Object.entries(registry)) {
    if (!c.class) continue;
    const p = c.parameters ?? {};
    const refs = c.scope?.refs ?? [];
    const ids = refs.map((r) => byRef.get(r)?.id).filter((x): x is string => !!x);
    if (c.class === 'mechanical' && key.startsWith('layout.mechanical.fixed.')) {
      const comp = byRef.get(refs[0] ?? '');
      if (!comp) continue;
      const dx = comp.at.x - num(p.x_nm), dy = comp.at.y - num(p.y_nm);
      const off = Math.round(Math.hypot(dx, dy));
      const rot = p.rotation_mdeg !== undefined && comp.rotation !== num(p.rotation_mdeg);
      if (off > 10_000 || rot) d.push(make(INTENT_CHECKER, 'intent.mechanical.fixed', { severity: sev(c), entityIds: [comp.id], entityReferences: [comp.reference], measured: { value: off, unit: 'nm' }, allowed: { value: 10_000, unit: 'nm', relation: '<=' }, message: `${comp.reference} is fixed at (${(num(p.x_nm) / 1e6).toFixed(2)}, ${(num(p.y_nm) / 1e6).toFixed(2)}) mm${p.rotation_mdeg !== undefined ? ` rot ${num(p.rotation_mdeg) / 1000}°` : ''} but sits ${(off / 1e6).toFixed(2)} mm away${rot ? ' at another rotation' : ''}`, suggestedActions: ['move-group'], ...(c.source ? { sourceRef: c.source } : {}) }));
    } else if (c.class === 'mechanical' && key.startsWith('layout.mechanical.edge.')) {
      const comp = byRef.get(refs[0] ?? '');
      const e = comp ? extent(comp) : null;
      if (!comp || !e) continue;
      const eb = bbox(e);
      const edge = String(p.edge);
      const tol = num(p.edge_tolerance_nm, 3_000_000);
      const gap = edge === 'west' ? eb.minX - ob.minX : edge === 'east' ? ob.maxX - eb.maxX : edge === 'north' ? eb.minY - ob.minY : ob.maxY - eb.maxY;
      if (gap > tol) d.push(make(INTENT_CHECKER, 'intent.mechanical.edge', { severity: sev(c), entityIds: [comp.id], entityReferences: [comp.reference], region: e, measured: { value: Math.round(gap), unit: 'nm' }, allowed: { value: tol, unit: 'nm', relation: '<=' }, message: `${comp.reference} must sit on the ${edge} edge but is ${(gap / 1e6).toFixed(1)} mm from it`, suggestedActions: ['move-group'] }));
      if (p.orientation) d.push(make(INTENT_CHECKER, 'intent.mechanical.orientation', { severity: 'info', entityIds: [comp.id], entityReferences: [comp.reference], message: `${comp.reference}: orientation "${String(p.orientation)}" is declared but not evaluated in this release (footprint-specific)`, suggestedActions: [] }));
    } else if (c.class === 'relative' && key.startsWith('layout.relative.attached.')) {
      const comp = byRef.get(refs[0] ?? '');
      const target = byRef.get(String(p.target ?? refs[1] ?? ''));
      if (!comp || !target) continue;
      const pins = strs(p.pins);
      const targetPads = target.pads.filter((x) => !pins.length || pins.includes(x.number));
      const use = targetPads.length ? targetPads : target.pads;
      let best = Number.POSITIVE_INFINITY;
      for (const a of comp.pads) for (const b of use) best = Math.min(best, polyDistance(a.copper, b.copper));
      const max = num(p.max_distance_nm, 2_000_000);
      if (best > max) d.push(make(INTENT_CHECKER, 'intent.relative.attached', { severity: sev(c), entityIds: [comp.id, target.id], entityReferences: [comp.reference, target.reference], region: extent(comp) ?? undefined, measured: { value: Math.round(best), unit: 'nm' }, allowed: { value: max, unit: 'nm', relation: '<=' }, message: `${comp.reference} must sit within ${(max / 1e6).toFixed(1)} mm of ${target.reference}${pins.length ? ` pins ${pins.join(', ')}` : ''} but is ${(best / 1e6).toFixed(1)} mm away`, suggestedActions: ['move-group'] }));
    } else if (c.class === 'functional' && key.startsWith('layout.functional.group.')) {
      groups.set(key.slice('layout.functional.group.'.length), c);
      const members = strs(p.members).map((r) => byRef.get(r)).filter((x): x is ComponentInstance => !!x);
      if (members.length < 2) continue;
      const anchor = byRef.get(String(p.anchor ?? '')) ?? members[0]!;
      const ac = anchor.at;
      const spreads = members.map((m) => ({ m, s: Math.hypot(m.at.x - ac.x, m.at.y - ac.y) }));
      const worst = spreads.reduce((a, b) => (b.s > a.s ? b : a));
      const budget = num(p.spread_budget_nm, 0);
      if (budget > 0 && worst.s > budget) d.push(make(INTENT_CHECKER, 'intent.functional.group.spread', { severity: sev(c), entityIds: members.map((m) => m.id), entityReferences: members.map((m) => m.reference), measured: { value: Math.round(worst.s), unit: 'nm' }, allowed: { value: budget, unit: 'nm', relation: '<=' }, message: `block ${key.slice('layout.functional.group.'.length)}: ${worst.m.reference} is ${(worst.s / 1e6).toFixed(1)} mm from the anchor ${anchor.reference}, budget ${(budget / 1e6).toFixed(1)} mm`, suggestedActions: ['move-group'] }));
      if (typeof p.region === 'string' && p.region) {
        try {
          const pts = JSON.parse(p.region) as [number, number][];
          const region: Polygon = { outer: pts.map(([x, y]) => ({ x, y })), holes: [] };
          const outside = members.filter((m) => !contains(region, m.at));
          if (outside.length) d.push(make(INTENT_CHECKER, 'intent.functional.group.region', { severity: sev(c), entityIds: outside.map((m) => m.id), entityReferences: outside.map((m) => m.reference), region, measured: { value: outside.length, unit: 'count' }, allowed: { value: 0, unit: 'count', relation: '<=' }, message: `block ${key.slice('layout.functional.group.'.length)}: ${outside.map((m) => m.reference).join(', ')} outside its signal-flow region`, suggestedActions: ['move-group'] }));
        } catch {
          // an unreadable region is the compiler's problem; the spread check still ran
        }
      }
    } else if (c.class === 'functional' && key.startsWith('layout.functional.separation.')) {
      const [ga, gb] = strs(p.groups);
      const membersOf = (g: string | undefined) => strs(registry[`layout.functional.group.${g ?? ''}`]?.parameters?.members).map((r) => byRef.get(r)).filter((x): x is ComponentInstance => !!x);
      const a = membersOf(ga), b = membersOf(gb);
      if (!a.length || !b.length) continue;
      let best = Number.POSITIVE_INFINITY, pair: [ComponentInstance, ComponentInstance] | null = null;
      for (const x of a) for (const y of b) {
        const ex = extent(x), ey = extent(y);
        if (!ex || !ey) continue;
        const dd = polyDistance(ex, ey);
        if (dd < best) {
          best = dd;
          pair = [x, y];
        }
      }
      const min = num(p.min_nm, 0);
      if (pair && best < min) d.push(make(INTENT_CHECKER, 'intent.functional.separation', { severity: sev(c), entityIds: pair.map((x) => x.id), entityReferences: pair.map((x) => x.reference), measured: { value: Math.round(best), unit: 'nm' }, allowed: { value: min, unit: 'nm', relation: '>=' }, message: `${ga} and ${gb} must stay ${(min / 1e6).toFixed(1)} mm apart; ${pair[0].reference} and ${pair[1].reference} are ${(best / 1e6).toFixed(1)} mm apart`, suggestedActions: ['move-group'] }));
    } else if (c.class === 'routing' && key.startsWith('layout.routing.width.')) {
      const netName = String(p.net ?? c.scope?.nets?.[0] ?? '');
      const net = design.nets.find((n) => n.name === netName);
      const min = num(p.min_width_nm, 0);
      if (!net || !min) continue;
      const thin = design.routing.segments.filter((s) => s.netId === net.id && s.width < min);
      if (thin.length) {
        const worst = Math.min(...thin.map((s) => s.width));
        d.push(make(INTENT_CHECKER, 'intent.routing.width', { severity: sev(c), entityIds: thin.map((s) => s.id), entityReferences: [netName], measured: { value: worst, unit: 'nm' }, allowed: { value: min, unit: 'nm', relation: '>=' }, message: `${netName}: ${thin.length} segment(s) narrower than ${(min / 1e6).toFixed(2)} mm (narrowest ${(worst / 1e6).toFixed(2)} mm)`, suggestedActions: ['rip-up-nets'] }));
      }
    } else if (c.class === 'manufacturing' && key.startsWith('layout.manufacturing.keepout.')) {
      const prohibit = strs(p.prohibit);
      const forbidsParts = !prohibit.length || prohibit.some((x) => ['components', 'footprints', 'pads'].includes(x));
      if (!forbidsParts) continue;
      let zones: Polygon[] = [];
      if (typeof p.polygon === 'string' && p.polygon) {
        try {
          zones = [{ outer: (JSON.parse(p.polygon) as [number, number][]).map(([x, y]) => ({ x, y })), holes: [] }];
        } catch {
          zones = [];
        }
      } else if (String(p.region) === 'mounting_hole_ring') {
        const r = num(p.radius_nm, 2_000_000);
        for (const comp of design.components) for (const pad of comp.pads) if (pad.type === 'np_thru_hole' || /^H\d/.test(comp.reference)) zones.push(circle(pad.at.x, pad.at.y, (pad.drill?.d ?? 0) + 2 * r));
      }
      for (const z of zones) {
        for (const comp of design.components) {
          if (comp.pads.every((pad) => pad.type === 'np_thru_hole') || /^H\d/.test(comp.reference)) continue;
          const e = extent(comp);
          if (!e || !intersects(e, z)) continue;
          d.push(make(INTENT_CHECKER, 'intent.manufacturing.keepout', { severity: sev(c), entityIds: [comp.id], entityReferences: [comp.reference], region: z, measured: { value: 1, unit: 'count' }, allowed: { value: 0, unit: 'count', relation: '<=' }, message: `${comp.reference} lies in keepout ${String(p.region ?? key)}`, suggestedActions: ['move-group'] }));
        }
      }
    }
    void ids;
  }
  // applicable = entries this checker evaluates (routing classes and dru rules are KiCad DRC's; stackup is not checked)
  const evaluated = (k: string, c: Constraint) => (c.class === 'mechanical' || c.class === 'relative' || c.class === 'functional' || (c.class === 'manufacturing' && k.startsWith('layout.manufacturing.keepout.')) || (c.class === 'routing' && k.startsWith('layout.routing.width.')));
  const hard = Object.entries(registry).filter(([k, c]) => c.severity === 'hard' && evaluated(k, c)).length;
  const violatedHard = new Set(d.filter((x) => x.severity === 'error').map((x) => x.code)).size;
  const soft = Object.entries(registry).filter(([k, c]) => c.severity === 'soft' && evaluated(k, c)).length;
  return { checker: INTENT_CHECKER, status: statusOf(d), evidence: [], diagnostics: d, metrics: { intent_hard_violations: d.filter((x) => x.severity === 'error').length, intent_soft_violations: d.filter((x) => x.severity === 'warning').length, intent_hard_total: hard, intent_soft_total: soft, intent_compliance: hard + soft ? 1 - (d.filter((x) => x.severity === 'error').length + 0.5 * d.filter((x) => x.severity === 'warning').length) / (hard + soft) : 1, intent_codes: violatedHard } };
}
