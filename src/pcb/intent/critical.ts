/**
 * Critical relationships (add-reuse-placer, RFC 14 §6.6): how physically
 * important each connection or set of parts is. A class decides the phase that
 * places its parts, the weight of its nets in packing, the check that verifies
 * it, and the ranking tier it counts toward. Rules here are soft and read pin
 * functions first, net names second, reference prefixes and footprint names
 * third; user intent and cited datasheet facts outrank them in the registry.
 * Weights are the provisional defaults of RFC 14 Appendix C.
 */
import type { PcbDesign, ComponentInstance, PadDefinition } from '../ir/types.js';
import type { Constraint } from '../../memory/constraints.js';
import { isConnector } from './blocks.js';
import { GROUND_NET, POWER_NET } from './subsystems.js';

export type CriticalClass =
  | 'mechanical' | 'rf-keepout' | 'supply-decoupling' | 'bootstrap' | 'config' | 'crystal'
  | 'hot-loop' | 'output-chain' | 'aggressor' | 'sensitive' | 'channel' | 'thermal' | 'signal' | 'low';

export type PhaseKind = 'mechanical' | 'regions' | 'anchors' | 'support' | 'loops' | 'separation' | 'remaining';
export const PHASE_ORDER: PhaseKind[] = ['mechanical', 'regions', 'anchors', 'support', 'loops', 'separation', 'remaining'];

export const CLASS_WEIGHT: Record<CriticalClass, number> = {
  mechanical: 1, 'rf-keepout': 1, 'supply-decoupling': 6, bootstrap: 4, config: 4, crystal: 4,
  'hot-loop': 8, 'output-chain': 4, aggressor: 1, sensitive: 1, channel: 1, thermal: 1, signal: 1, low: 0.5,
};

/** The phase a non-anchor member of a relationship of this class is placed in. */
export const CLASS_PHASE: Record<CriticalClass, PhaseKind> = {
  mechanical: 'mechanical', 'rf-keepout': 'mechanical', 'supply-decoupling': 'support', bootstrap: 'support', config: 'support', crystal: 'support',
  'hot-loop': 'loops', 'output-chain': 'support', aggressor: 'remaining', sensitive: 'remaining', channel: 'remaining', thermal: 'remaining', signal: 'remaining', low: 'remaining',
};

export interface CriticalRelation {
  id: string;
  class: CriticalClass;
  /** Reference designators involved. */
  refs: string[];
  /** Named pins, `REF.PAD`, where the class names pins. */
  pins?: string[];
  /** Chain or loop order, where applicable. */
  order?: string[];
  /** The other side of an isolation or channel relationship. */
  against?: string[];
  kind?: 'switching' | 'supply' | 'output';
  maxMm?: number;
  maxLoopAreaMm2?: number;
  minMm?: number;
  severity: 'hard' | 'soft' | 'advisory';
  source: 'user' | 'datasheet' | 'rule' | 'model';
  confidence: number;
  cite?: string;
}

export interface Classification {
  relations: CriticalRelation[];
  /** Classes per reference designator. */
  partClasses: Map<string, Set<CriticalClass>>;
  /** Packing weight per net name: the highest weight of the classes the net belongs to; ground 0, power 0.25, else 1. */
  netWeights: Map<string, number>;
  /** Reference designators of anchor ICs (integrated circuits and modules). */
  ics: Set<string>;
}

const SUPPLY_PIN = /^(P?VDD|P?VCC|AVDD|DVDD|GVDD|PVDD|PVCC|VIN|PVIN|VBAT|VS|VCCIO|VDDIO|VDDA|VREG|V\+|VBUS)/i;
const SW = /(^|[_\-/])(SW|LX|PH)(\d|[_\-/]|$)/i;
const BST = /(^|[_\-/])(BST|BOOT|CB|BS)(\d|[_\-/A-Z]{0,2}$|[_\-/])/i;
const OUT = /(^|[_\-/])(OUT[PN]?|OUT_?[ABLR]|SPK[PN+-]?|OUT[LR])(\d|[_\-/]|$)/i;
const CONFIG = /(^|[_\-/])(FB|GAIN|SEL|MODE|SD|EN|ADJ|RT|COMP|ILIM|SS|PG|PLIMIT|MUTE|FAULT)(\d|[_\-/]|$)/i;
const XTAL_NET = /XTAL|XIN|XOUT|OSC|XI$|XO$|X1$|X2$|32K|OSC32/i;
const SENSITIVE_NET = /(^|[_\-/])(AIN\d*|ADC\d*|INP|INN|IN[+-]|SENSE[PN+-]?|VREF|REF|MIC[PN+-]?|AUDIO_?IN|LINE_?IN|FB)(\d|[_\-/]|$)/i;
const VIN_NET = /(^|[_\-/])(VIN|PVIN|VBUS|VDC|\+?1[2-9]V|\+?2[0-9]V|\+?5V|VBAT)(\d|[_\-/]|$)/i;
const AMP_PART = /TPA3|TAS5|TDA7|MAX98|PAM8|SSM2|CS35|Amplifier_Audio/i;
const OPAMP_PART = /OPA\d|LM358|LM324|MCP60|TL07|TL08|AD8\d|OP\d|Amplifier_Operational/i;
const RF_PART = /RF_Module|ESP32|WROOM|WROVER|nRF5|Bluetooth|BLE|CC26|RN4|HC-0|Antenna|RFM\d|SX12/i;

const prefixOf = (ref: string) => (ref.match(/^[A-Za-z#_]+/)?.[0] ?? '').toUpperCase();
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

export function partKind(c: ComponentInstance): 'cap' | 'res' | 'ind' | 'diode' | 'led' | 'xtal' | 'ic' | 'rf' | 'connector' | 'switch' | 'hole' | 'testpoint' | 'jumper' | 'transistor' | 'other' {
  const p = prefixOf(c.reference);
  const lib = c.footprint.libId;
  if (/MountingHole/i.test(lib) || p === 'H' || p === 'MH') return 'hole';
  if (/TestPoint/i.test(lib) || p === 'TP') return 'testpoint';
  if (/Jumper|SolderJumper/i.test(lib) || p === 'JP') return 'jumper';
  if (RF_PART.test(lib) || RF_PART.test(c.value) || p === 'ANT' || p === 'AE') return 'rf';
  if (isConnector(c)) return 'connector';
  if (/Button|Switch/i.test(lib) || p === 'SW' || p === 'S') return 'switch';
  if (p === 'Y' || /Crystal|Oscillator|Resonator/i.test(lib)) return 'xtal';
  if (/LED/i.test(lib) || /^LED/i.test(c.value)) return 'led';
  if (p === 'C') return 'cap';
  if (p === 'R' || p === 'RN') return 'res';
  if (p === 'L' || p === 'FB') return 'ind';
  if (p === 'D') return 'diode';
  if (p === 'Q' || p === 'T') return 'transistor';
  if (p === 'U' || p === 'IC' || c.pads.length >= 8) return 'ic';
  return 'other';
}

interface Ctx {
  design: PcbDesign;
  netName: Map<string, string>;
  /** net id -> [component, pad] */
  onNet: Map<string, { c: ComponentInstance; p: PadDefinition }[]>;
  kind: Map<string, ReturnType<typeof partKind>>;
}

function context(design: PcbDesign): Ctx {
  const netName = new Map(design.nets.map((n) => [n.id, n.name]));
  const onNet = new Map<string, { c: ComponentInstance; p: PadDefinition }[]>();
  for (const c of design.components) for (const p of c.pads) if (p.netId) (onNet.get(p.netId) ?? onNet.set(p.netId, []).get(p.netId)!).push({ c, p });
  const kind = new Map(design.components.map((c) => [c.id, partKind(c)]));
  return { design, netName, onNet, kind };
}

const isGround = (ctx: Ctx, netId: string | null | undefined) => !!netId && GROUND_NET.test(ctx.netName.get(netId) ?? '');
const isPower = (ctx: Ctx, netId: string | null | undefined) => !!netId && POWER_NET.test(ctx.netName.get(netId) ?? '');
/** A pad's label: its pin function, else its net name. */
const label = (ctx: Ctx, p: PadDefinition) => p.pinFunction || (p.netId ? ctx.netName.get(p.netId) ?? '' : '');
const icLike = (ctx: Ctx, c: ComponentInstance) => ['ic', 'rf'].includes(ctx.kind.get(c.id)!);

function netsOf(c: ComponentInstance): string[] {
  return [...new Set(c.pads.map((p) => p.netId).filter((n): n is string => !!n))];
}

/** ICs with a pad on the net, with those pads. */
function icsOnNet(ctx: Ctx, netId: string, exclude?: string): { c: ComponentInstance; pads: PadDefinition[] }[] {
  const by = new Map<string, { c: ComponentInstance; pads: PadDefinition[] }>();
  for (const { c, p } of ctx.onNet.get(netId) ?? []) {
    if (c.id === exclude || !icLike(ctx, c)) continue;
    (by.get(c.id) ?? by.set(c.id, { c, pads: [] }).get(c.id)!).pads.push(p);
  }
  return [...by.values()].sort((a, b) => b.pads.length - a.pads.length || a.c.reference.localeCompare(b.c.reference));
}

export function classifyCritical(design: PcbDesign): Classification {
  const ctx = context(design);
  const relations: CriticalRelation[] = [];
  const partClasses = new Map<string, Set<CriticalClass>>();
  const tag = (ref: string, cls: CriticalClass) => (partClasses.get(ref) ?? partClasses.set(ref, new Set()).get(ref)!).add(cls);
  const rel = (r: Omit<CriticalRelation, 'id' | 'severity' | 'source' | 'confidence'> & Partial<Pick<CriticalRelation, 'severity' | 'source' | 'confidence'>>) => {
    const full: CriticalRelation = { id: `${r.class}.${slug(r.refs.join('-'))}`, severity: 'soft', source: 'rule', confidence: 0.8, ...r };
    if (relations.some((x) => x.id === full.id)) return;
    relations.push(full);
    for (const ref of full.refs) tag(ref, full.class);
  };
  const ics = new Set(design.components.filter((c) => icLike(ctx, c)).map((c) => c.reference));

  // mechanical and RF
  for (const c of design.components) {
    const k = ctx.kind.get(c.id)!;
    if (k === 'connector' || k === 'switch' || k === 'hole' || c.attributes.locked) tag(c.reference, 'mechanical');
    if (k === 'rf') rel({ class: 'rf-keepout', refs: [c.reference], cite: 'rule:rf-module' });
    if (k === 'testpoint' || k === 'jumper') tag(c.reference, 'low');
    if (/EP|ExposedPad|PowerPAD|HTSSOP|QFN|DFN|TabPin|TO-263|TO-252/i.test(c.footprint.libId) && icLike(ctx, c)) tag(c.reference, 'thermal');
  }

  // switching converters: an IC pin or net labelled SW/LX/PH with an inductor on it
  const switchIcs = new Set<string>();
  for (const c of design.components) {
    if (!icLike(ctx, c)) continue;
    const swPads = c.pads.filter((p) => p.netId && SW.test(label(ctx, p)));
    for (const sp of swPads) {
      const onSw = ctx.onNet.get(sp.netId!) ?? [];
      const inductor = onSw.find(({ c: o }) => ctx.kind.get(o.id) === 'ind');
      if (!inductor) continue;
      switchIcs.add(c.reference);
      const vinNets = [...new Set(c.pads.filter((p) => p.netId && !isGround(ctx, p.netId) && (/^(P?VIN|VCC|VDD)/i.test(p.pinFunction ?? '') || VIN_NET.test(ctx.netName.get(p.netId) ?? ''))).map((p) => p.netId!))];
      const cin = vinNets.flatMap((n) => (ctx.onNet.get(n) ?? []).filter(({ c: o }) => ctx.kind.get(o.id) === 'cap' && netsOf(o).some((m) => isGround(ctx, m))).map(({ c: o }) => o.reference));
      const diode = onSw.find(({ c: o }) => ctx.kind.get(o.id) === 'diode')?.c.reference;
      const refs = [...new Set([...cin, c.reference, ...(diode ? [diode] : []), inductor.c.reference])];
      rel({ class: 'hot-loop', kind: 'switching', refs, order: refs, cite: 'rule:switch-node' });
      for (const r of [c.reference, inductor.c.reference, ...(diode ? [diode] : [])]) tag(r, 'aggressor');
    }
  }

  // a converter built from discrete parts names nothing: the switch node is an inductor's
  // net that also carries a transistor or a diode, and is small enough not to be a rail
  for (const ind of design.components) {
    if (ctx.kind.get(ind.id) !== 'ind') continue;
    const nets = netsOf(ind).filter((n) => !isGround(ctx, n));
    for (const n of nets) {
      const on = ctx.onNet.get(n) ?? [];
      if (POWER_NET.test(ctx.netName.get(n) ?? '') || new Set(on.map((e) => e.c.id)).size > 4) continue;
      const switches = on.filter(({ c: o }) => o.id !== ind.id && ['transistor', 'diode', 'ic'].includes(ctx.kind.get(o.id)!));
      if (!switches.length || switches.every(({ c: o }) => switchIcs.has(o.reference))) continue;
      const capsOn = (rail: string | undefined) => (rail ? (ctx.onNet.get(rail) ?? []).filter(({ c: o }) => ctx.kind.get(o.id) === 'cap' && netsOf(o).some((m) => isGround(ctx, m))).map(({ c: o }) => o.reference) : []);
      const inRail = nets.find((x) => x !== n);
      const diode = switches.find(({ c: o }) => ctx.kind.get(o.id) === 'diode');
      const outRail = diode ? netsOf(diode.c).find((x) => x !== n && !isGround(ctx, x)) : undefined;
      const refs = [...new Set([...capsOn(inRail), ...switches.map(({ c: o }) => o.reference), ind.reference, ...capsOn(outRail)])];
      if (refs.length < 3) continue;
      rel({ class: 'hot-loop', kind: 'switching', refs, order: refs, cite: 'rule:switch-node-topology', confidence: 0.6 });
      for (const s of switches) tag(s.c.reference, 'aggressor');
      tag(ind.reference, 'aggressor');
    }
  }

  // class-D amplifiers: supply loops and output chains
  const ampOutputs: { amp: string; chain: string[] }[] = [];
  for (const c of design.components) {
    if (!icLike(ctx, c)) continue;
    const outPads = c.pads.filter((p) => p.netId && OUT.test(label(ctx, p)));
    const isAmp = AMP_PART.test(c.value) || AMP_PART.test(c.footprint.libId) || (outPads.length >= 2 && c.pads.some((p) => /PVDD|PVCC/i.test(label(ctx, p))));
    if (!isAmp) continue;
    tag(c.reference, 'aggressor');
    const pvddNets = [...new Set(c.pads.filter((p) => p.netId && /PVDD|PVCC/i.test(label(ctx, p))).map((p) => p.netId!))];
    for (const n of pvddNets) {
      const caps = (ctx.onNet.get(n) ?? []).filter(({ c: o }) => ctx.kind.get(o.id) === 'cap' && netsOf(o).some((m) => isGround(ctx, m))).map(({ c: o }) => o.reference);
      if (caps.length) rel({ class: 'hot-loop', kind: 'supply', refs: [...new Set([...caps, c.reference])], order: [...new Set([...caps, c.reference])], cite: 'rule:class-d-supply' });
    }
    for (const op of [...new Set(outPads.map((p) => p.netId!))]) {
      const ind = (ctx.onNet.get(op) ?? []).find(({ c: o }) => ctx.kind.get(o.id) === 'ind');
      if (!ind) continue;
      const far = netsOf(ind.c).find((n) => n !== op);
      const chain = [c.reference, ind.c.reference];
      if (far) {
        const cap = (ctx.onNet.get(far) ?? []).find(({ c: o }) => ctx.kind.get(o.id) === 'cap')?.c.reference;
        const conn = (ctx.onNet.get(far) ?? []).find(({ c: o }) => ctx.kind.get(o.id) === 'connector')?.c.reference;
        if (cap) chain.push(cap);
        if (conn) chain.push(conn);
      }
      rel({ class: 'output-chain', refs: chain, order: chain, cite: 'rule:amplifier-output' });
      tag(ind.c.reference, 'aggressor');
      ampOutputs.push({ amp: c.reference, chain });
    }
  }
  // left and right channels: two or more output chains of one amplifier
  const byAmp = new Map<string, string[][]>();
  for (const o of ampOutputs) (byAmp.get(o.amp) ?? byAmp.set(o.amp, []).get(o.amp)!).push(o.chain.slice(1));
  for (const [, chains] of byAmp) {
    if (chains.length < 2) continue;
    const half = Math.ceil(chains.length / 2);
    const left = [...new Set(chains.slice(0, half).flat())], right = [...new Set(chains.slice(half).flat())];
    rel({ class: 'channel', refs: left, against: right, cite: 'rule:channels' });
  }

  // crystals with their load capacitors
  for (const c of design.components) {
    if (ctx.kind.get(c.id) !== 'xtal') continue;
    const nets = netsOf(c).filter((n) => !isGround(ctx, n));
    const loads = nets.flatMap((n) => (ctx.onNet.get(n) ?? []).filter(({ c: o }) => ctx.kind.get(o.id) === 'cap' && netsOf(o).some((m) => isGround(ctx, m))).map(({ c: o }) => o.reference));
    const ic = nets.flatMap((n) => icsOnNet(ctx, n, c.id))[0]?.c.reference;
    rel({ class: 'crystal', refs: [...new Set([c.reference, ...loads, ...(ic ? [ic] : [])])], maxMm: 3, cite: 'rule:crystal' });
    tag(c.reference, 'aggressor');
  }

  // two-pin passives: decoupling, bootstrap, config, pull-ups, LED resistors
  for (const c of design.components) {
    const k = ctx.kind.get(c.id)!;
    if (k !== 'cap' && k !== 'res') continue;
    const nets = netsOf(c);
    if (nets.length !== 2) continue;
    const [a, b] = nets as [string, string];
    const gndSide = isGround(ctx, a) ? a : isGround(ctx, b) ? b : null;
    const other = gndSide === a ? b : a;
    if (k === 'cap') {
      if (partClasses.get(c.reference)?.has('crystal')) continue;
      if (gndSide) {
        const onRail = icsOnNet(ctx, other, c.id);
        const supplyIcs = onRail.filter((x) => x.pads.some((p) => SUPPLY_PIN.test(p.pinFunction ?? '')) || isPower(ctx, other));
        if (supplyIcs.length) {
          const ic = supplyIcs[0]!;
          rel({ class: 'supply-decoupling', refs: [c.reference, ic.c.reference], pins: ic.pads.map((p) => `${ic.c.reference}.${p.number}`), maxMm: 2, cite: 'rule:decoupling' });
          continue;
        }
        // the board names neither the pin nor the rail (older exports carry no pinfunction):
        // a capacitor to ground on a net that reaches an IC still belongs beside that IC
        if (onRail.length) {
          const ic = onRail[0]!;
          rel({ class: 'supply-decoupling', refs: [c.reference, ic.c.reference], pins: ic.pads.map((p) => `${ic.c.reference}.${p.number}`), maxMm: 2, cite: 'rule:decoupling-unnamed', confidence: 0.5 });
          continue;
        }
        if (/CP_|Polarized|Elec/i.test(c.footprint.libId)) tag(c.reference, 'low');
        continue;
      }
      // bootstrap: between a BST-labelled pin and a switch or output pin of the same IC
      const bstIc = icsOnNet(ctx, a, c.id).concat(icsOnNet(ctx, b, c.id)).find((x) => x.pads.some((p) => BST.test(label(ctx, p))));
      if (bstIc) {
        rel({ class: 'bootstrap', refs: [c.reference, bstIc.c.reference], pins: bstIc.pads.map((p) => `${bstIc.c.reference}.${p.number}`), maxMm: 2, cite: 'rule:bootstrap' });
        continue;
      }
    }
    if (k === 'res') {
      const cfg = [a, b].flatMap((n) => icsOnNet(ctx, n, c.id).filter((x) => x.pads.some((p) => CONFIG.test(label(ctx, p)))))[0];
      if (cfg) {
        rel({ class: 'config', refs: [c.reference, cfg.c.reference], pins: cfg.pads.filter((p) => CONFIG.test(label(ctx, p))).map((p) => `${cfg.c.reference}.${p.number}`), maxMm: 3, cite: 'rule:config' });
        continue;
      }
      const toLed = [a, b].some((n) => (ctx.onNet.get(n) ?? []).some(({ c: o }) => ctx.kind.get(o.id) === 'led'));
      const pull = (isPower(ctx, a) || isPower(ctx, b) || gndSide) && [a, b].some((n) => icsOnNet(ctx, n, c.id).length > 0);
      if (toLed || pull) tag(c.reference, 'low');
    }
  }

  // sensitive parts against the aggressors found above
  const sensitive = new Set<string>();
  for (const c of design.components) {
    const k = ctx.kind.get(c.id)!;
    if (k === 'rf') sensitive.add(c.reference);
    if (OPAMP_PART.test(c.value) || OPAMP_PART.test(c.footprint.libId)) sensitive.add(c.reference);
    if ((k === 'res' || k === 'cap') && netsOf(c).some((n) => SENSITIVE_NET.test(ctx.netName.get(n) ?? '')) && !switchIcs.size) sensitive.add(c.reference);
    if ((k === 'res' || k === 'cap') && netsOf(c).some((n) => /(AIN|ADC|INP|INN|SENSE|VREF|MIC|AUDIO_?IN)/i.test(ctx.netName.get(n) ?? ''))) sensitive.add(c.reference);
  }
  const aggressors = [...partClasses.entries()].filter(([, s]) => s.has('aggressor')).map(([r]) => r);
  for (const r of aggressors) sensitive.delete(r);
  if (sensitive.size && aggressors.length) rel({ class: 'sensitive', refs: [...sensitive].sort(), against: [...aggressors].sort(), cite: 'rule:isolation' });
  for (const r of sensitive) tag(r, 'sensitive');

  // everything else is signal
  for (const c of design.components) if (!partClasses.has(c.reference)) tag(c.reference, 'signal');

  // net weights: the highest class weight among relationships whose parts the net joins
  const netWeights = new Map<string, number>();
  for (const n of design.nets) netWeights.set(n.name, GROUND_NET.test(n.name) ? 0 : POWER_NET.test(n.name) ? 0.25 : 1);
  const refsOfNet = new Map<string, Set<string>>();
  for (const [netId, entries] of ctx.onNet) refsOfNet.set(ctx.netName.get(netId) ?? netId, new Set(entries.map((e) => e.c.reference)));
  for (const r of relations) {
    const w = CLASS_WEIGHT[r.class];
    if (['aggressor', 'sensitive', 'channel', 'rf-keepout', 'mechanical', 'thermal'].includes(r.class)) continue;
    const members = new Set([...r.refs, ...(r.order ?? [])]);
    for (const [name, refs] of refsOfNet) {
      if (GROUND_NET.test(name)) continue;
      const inRel = [...refs].filter((x) => members.has(x)).length;
      if (inRel >= 2 && w > (netWeights.get(name) ?? 1)) netWeights.set(name, w);
    }
  }
  return { relations, partClasses, netWeights, ics };
}

/** The phase a part is placed in: the earliest its classes name; anchor ICs go to `anchors`. */
export function phaseOf(ref: string, classification: Classification, anchors: Set<string>): PhaseKind {
  const classes = classification.partClasses.get(ref) ?? new Set<CriticalClass>(['signal']);
  if (classes.has('mechanical') || classes.has('rf-keepout')) return 'mechanical';
  if (anchors.has(ref)) return 'anchors';
  let best = PHASE_ORDER.length - 1;
  for (const c of classes) {
    // an anchor-less IC in a relationship is placed with its support, not after
    const idx = PHASE_ORDER.indexOf(CLASS_PHASE[c]);
    if (idx < best) best = idx;
  }
  return PHASE_ORDER[best]!;
}

/** Registry entries for the relationships; existing keys (user intent, datasheet facts) are never overwritten. */
export function relationsToConstraints(relations: CriticalRelation[], existing: Record<string, Constraint> = {}): Record<string, Constraint> {
  const out: Record<string, Constraint> = {};
  const put = (key: string, c: Omit<Constraint, 'source' | 'affects'>, r: CriticalRelation) => {
    if (existing[key]) return;
    out[key] = { source: `critical:${r.source}${r.cite ? `:${r.cite}` : ''}`, affects: ['board'], ...c };
  };
  const base = (r: CriticalRelation, cls: NonNullable<Constraint['class']>, parameters: Constraint['parameters'], refs = r.refs): Omit<Constraint, 'source' | 'affects'> => ({ class: cls, severity: r.severity, scope: { refs }, parameters: parameters ?? {}, priority: 30, confidence: r.confidence, approvedBy: r.source === 'user' ? 'user' : 'rule' });
  const mm = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 1e6));
  for (const r of relations) {
    const [part, target] = r.refs;
    switch (r.class) {
      case 'supply-decoupling':
      case 'bootstrap':
      case 'config': {
        if (!part || !target) break;
        const pins = (r.pins ?? []).map((p) => p.split('.').slice(1).join('.'));
        put(`layout.relative.attached.${part}`, base(r, 'relative', { target, pins, max_distance_nm: mm(r.maxMm) ?? 2_000_000, priority: 'normal', relation: r.class }, [part, target]), r);
        break;
      }
      case 'crystal': {
        const xtal = r.refs[0]!;
        const ic = r.refs.find((x, i) => i > 0 && !/^C/i.test(x));
        if (ic) put(`layout.relative.attached.${xtal}`, base(r, 'relative', { target: ic, pins: [], max_distance_nm: mm(r.maxMm) ?? 3_000_000, priority: 'normal', relation: 'crystal' }, [xtal, ic]), r);
        put(`layout.emc.edge-distance.${xtal}`, base(r, 'emc', { ...(r.minMm !== undefined ? { min_nm: mm(r.minMm)! } : {}) }, [xtal]), r);
        break;
      }
      case 'hot-loop':
        put(`layout.emc.hot-loop.${slug(r.refs.join('-'))}`, base(r, 'emc', { kind: r.kind ?? 'switching', parts: r.order ?? r.refs, ...(r.maxLoopAreaMm2 !== undefined ? { max_area_nm2: Math.round(r.maxLoopAreaMm2 * 1e12) } : {}) }), r);
        break;
      case 'output-chain':
        put(`layout.relative.chain.${slug((r.order ?? r.refs).join('-'))}`, base(r, 'relative', { order: r.order ?? r.refs }), r);
        break;
      case 'sensitive':
        put(`layout.emc.isolation.${slug(r.refs[0] ?? 'rule')}`, base(r, 'emc', { noisy: r.against ?? [], sensitive: r.refs, ...(r.minMm !== undefined ? { min_nm: mm(r.minMm)! } : {}) }, [...r.refs, ...(r.against ?? [])]), r);
        break;
      case 'channel':
        put(`layout.emc.channel.${slug(r.refs[0] ?? 'rule')}`, base(r, 'emc', { left: r.refs, right: r.against ?? [], ...(r.minMm !== undefined ? { min_nm: mm(r.minMm)! } : {}) }, [...r.refs, ...(r.against ?? [])]), r);
        break;
      case 'rf-keepout':
        put(`layout.rf.edge.${part}`, base(r, 'emc', { ...(r.minMm !== undefined ? { clearance_nm: mm(r.minMm)! } : {}) }), r);
        break;
      default:
        break;
    }
  }
  return out;
}
