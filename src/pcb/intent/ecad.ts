/**
 * ECAD-parsed constraints (RFC 11 §7.5, implementation spec §7.2): what the
 * board already states, re-derived on every import with `source: ecad_rules`.
 * Net classes become routing constraints, locked footprints become fixed
 * positions, keepout rule areas become keepouts. A hand-written entry that
 * contradicts one is left untouched and reported so the run can HOLD.
 */
import type { PcbDesign } from '../ir/types.js';
import type { Constraint } from '../../memory/constraints.js';

export const ECAD_SOURCE = 'ecad_rules';

export function ecadConstraints(design: PcbDesign): Record<string, Constraint> {
  const out: Record<string, Constraint> = {};
  const rules = design.board.rules;
  const cls = (name: string, c: Partial<Record<'clearanceNm' | 'trackWidthNm' | 'viaDiameterNm' | 'viaDrillNm', number | undefined>>, nets: string[]) => {
    const pairs: [string, string, number | undefined][] = [['width', 'width_nm', c.trackWidthNm], ['clearance', 'clearance_nm', c.clearanceNm], ['via_size', 'via_size_nm', c.viaDiameterNm], ['via_drill', 'via_drill_nm', c.viaDrillNm]];
    for (const [suffix, param, v] of pairs) {
      if (v === undefined) continue;
      out[`layout.routing.class.${name}.${suffix}`] = { source: ECAD_SOURCE, affects: ['board'], class: 'routing', severity: 'hard', scope: { nets }, parameters: { [param]: v, class: name }, priority: 70, confidence: 1, approvedBy: ECAD_SOURCE };
    }
  };
  cls('Default', { trackWidthNm: rules.trackWidthNm, clearanceNm: rules.clearanceNm, viaDiameterNm: rules.viaDiameterNm, viaDrillNm: rules.viaDrillNm }, design.nets.filter((n) => n.netClass === 'Default' || !n.netClass).map((n) => n.name));
  for (const [name, c] of Object.entries(rules.netClasses)) {
    if (name === 'Default') continue;
    cls(name, c, c.nets ?? design.nets.filter((n) => n.netClass === name).map((n) => n.name));
  }
  for (const c of design.components) {
    if (!c.attributes.locked) continue;
    out[`layout.mechanical.fixed.${c.reference}`] = { source: ECAD_SOURCE, affects: ['board'], class: 'mechanical', severity: 'hard', scope: { refs: [c.reference] }, parameters: { x_nm: c.at.x, y_nm: c.at.y, rotation_mdeg: c.rotation, side: c.attributes.side }, priority: 100, confidence: 1, approvedBy: ECAD_SOURCE };
  }
  for (const k of design.board.keepouts) {
    out[`layout.manufacturing.keepout.${k.id}`] = { source: ECAD_SOURCE, affects: ['board'], class: 'manufacturing', severity: 'hard', scope: {}, parameters: { region: k.id, polygon: JSON.stringify(k.polygon.outer.map((p) => [p.x, p.y])), layers: k.layers, prohibit: k.prohibits }, priority: 90, confidence: 1, approvedBy: ECAD_SOURCE };
  }
  return out;
}

/** Merge ECAD entries over an existing registry: ECAD-sourced keys are replaced wholesale; a differently sourced entry under an ECAD key is a contradiction. */
export function mergeEcad(registry: Record<string, Constraint>, ecad: Record<string, Constraint>): { registry: Record<string, Constraint>; contradictions: { key: string; theirs: string }[] } {
  const out: Record<string, Constraint> = {};
  const contradictions: { key: string; theirs: string }[] = [];
  for (const [k, v] of Object.entries(registry)) if (v.source !== ECAD_SOURCE) out[k] = v;
  for (const [k, v] of Object.entries(ecad)) {
    const other = out[k];
    if (other && JSON.stringify(other.parameters) !== JSON.stringify(v.parameters)) {
      contradictions.push({ key: k, theirs: other.source });
      continue; // the human's entry stands; the run holds
    }
    out[k] = v;
  }
  return { registry: out, contradictions };
}
