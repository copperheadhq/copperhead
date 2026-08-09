import type { PlacementModel } from '../emit.js';
import type { ValidatedIntent } from './ir.js';

/**
 * circuit-json serializer (capability circuit-json-export): a derived
 * READ-ONLY view of a drafted sheet, built from the validated intent (source
 * layer) and the engine's placement model (schematic layer). Pure function,
 * no I/O, and never reachable from any mutation path — the constraint from
 * issue #178 is that circuit-json is only ever a derived view.
 *
 * Emits plain JSON objects whose shapes are pinned by the `circuit-json`
 * devDependency's Zod schemas in tests; the package is not a runtime import.
 * Determinism discipline matches emit.ts: canonical sort orders, ordinal ids,
 * no wall clock, no randomness — identical intent yields identical bytes.
 */

/** KiCad sheet space is mm with +y down; circuit-json is mm with +y up. The
 * y-negation lives here and nowhere else. */
const toCj = (x: number, y: number): { x: number; y: number } => ({ x: n4(x), y: n4(-y) });

/** Trim float noise the same way knum does, but numerically. */
const n4 = (v: number): number => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
};

/** Natural refdes order: R2 before R10, C1 before R1. */
const compareRef = (a: string, b: string): number => {
  const ma = /^([A-Za-z#]+)(\d*)$/.exec(a);
  const mb = /^([A-Za-z#]+)(\d*)$/.exec(b);
  if (ma && mb && ma[1] !== mb[1]) return ma[1]! < mb[1]! ? -1 : 1;
  if (ma && mb) return Number(ma[2] || 0) - Number(mb[2] || 0);
  return a < b ? -1 : a > b ? 1 : 0;
};

export type CircuitJsonElement = Record<string, unknown>;

export function buildCircuitJson(validated: ValidatedIntent, model: PlacementModel): CircuitJsonElement[] {
  const parts = [...validated.intent.parts].sort((a, b) => compareRef(a.ref, b.ref));
  const nets = [...validated.intent.nets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // A multi-unit part places several instances under one ref (an opamp's
  // units); each instance carries only its own unit's pinNumbers.
  const instancesByRef = new Map<string, typeof model.symbols>();
  for (const s of model.symbols) {
    const list = instancesByRef.get(s.ref);
    if (list) list.push(s);
    else instancesByRef.set(s.ref, [s]);
  }

  const sourceComponents: CircuitJsonElement[] = [];
  const sourcePorts: CircuitJsonElement[] = [];
  const schematicComponents: CircuitJsonElement[] = [];
  const schematicPorts: CircuitJsonElement[] = [];
  /** `REF.PIN` → source_port id, for trace endpoints. */
  const portId = new Map<string, string>();

  parts.forEach((part, ci) => {
    const componentId = `source_component_${ci}`;
    // Every ftype except simple_chip demands parsed electrical values
    // (resistance, capacitance, …) the intent's free-text value cannot promise;
    // simple_chip carries any part faithfully with the value as display text.
    sourceComponents.push({
      type: 'source_component',
      source_component_id: componentId,
      ftype: 'simple_chip',
      name: part.ref,
      display_value: part.value,
    });

    const sym = validated.symbols.get(part.ref)!;
    const instances = [...(instancesByRef.get(part.ref) ?? [])].sort((a, b) => (a.unit ?? 1) - (b.unit ?? 1));
    /** The unit view backing a placed instance, when the symbol is multi-unit. */
    const viewOf = (unit: number | undefined) => sym.units?.find((u) => u.unit === (unit ?? 1));
    for (const inst of instances) {
      // Symbol space is +y up; a rot-0 placement maps (px, py) → (x + px, y - py)
      // (engine pinAt), so body extents flip sign in y before centering.
      const b = viewOf(inst.unit)?.body ?? sym.body;
      const center = b
        ? toCj(inst.at.x + (b.minX + b.maxX) / 2, inst.at.y - (b.minY + b.maxY) / 2)
        : toCj(inst.at.x, inst.at.y);
      const size = b
        ? { width: n4(b.maxX - b.minX), height: n4(b.maxY - b.minY) }
        : { width: 2.54, height: 2.54 };
      schematicComponents.push({
        type: 'schematic_component',
        schematic_component_id: `schematic_component_${schematicComponents.length}`,
        source_component_id: componentId,
        center,
        size,
        symbol_display_value: part.value,
      });
    }

    const seen = new Set<string>();
    const pins = sym.pins
      .filter((p) => !seen.has(p.number) && seen.add(p.number))
      .sort((a, b) => compareRef(`P${a.number}`, `P${b.number}`));
    for (const pin of pins) {
      const id = `source_port_${sourcePorts.length}`;
      portId.set(`${part.ref}.${pin.number}`, id);
      const pinNumber = /^\d+$/.test(pin.number) ? Number(pin.number) : undefined;
      sourcePorts.push({
        type: 'source_port',
        source_port_id: id,
        source_component_id: componentId,
        name: pin.number,
        ...(pinNumber === undefined ? {} : { pin_number: pinNumber }),
      });
      // The instance that draws this pin: for multi-unit parts, the placed
      // unit whose pinNumbers carry it (a common-unit pin is drawn on every
      // unit; the lowest one is the canonical anchor).
      const inst = instances.find((s) => s.pinNumbers.includes(pin.number));
      if (inst) {
        const local = viewOf(inst.unit)?.pins.find((p) => p.number === pin.number) ?? pin;
        schematicPorts.push({
          type: 'schematic_port',
          schematic_port_id: `schematic_port_${schematicPorts.length}`,
          source_port_id: id,
          center: toCj(inst.at.x + local.x, inst.at.y - local.y),
        });
      }
    }
  });

  const sourceNets: CircuitJsonElement[] = [];
  const sourceTraces: CircuitJsonElement[] = [];
  const schematicTraces: CircuitJsonElement[] = [];
  const netId = new Map<string, string>();
  nets.forEach((net, ni) => {
    const id = `source_net_${ni}`;
    netId.set(net.name, id);
    sourceNets.push({ type: 'source_net', source_net_id: id, name: net.name, member_source_group_ids: [] });
    const traceId = `source_trace_${ni}`;
    sourceTraces.push({
      type: 'source_trace',
      source_trace_id: traceId,
      connected_source_port_ids: [...net.pins].sort(compareRef).map((p) => portId.get(p)!),
      connected_source_net_ids: [id],
    });
    // One schematic_trace per CONTIGUOUS wire chain, not per net: renderers
    // (circuit-to-svg, circuitjson.com) draw a trace's edges as one connected
    // route, so a net's disjoint branches must be separate traces or they
    // render as phantom diagonals between branch endpoints.
    const wires = model.wires.filter((w) => w.net === net.name).sort((a, b) => a.index - b.index);
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r)!;
      for (let c = k; c !== r; ) {
        const next = parent.get(c)!;
        parent.set(c, r);
        c = next;
      }
      return r;
    };
    const union = (a: string, b: string) => {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      parent.set(find(a), find(b));
    };
    const endKey = (x: number, y: number) => `${n4(x)},${n4(y)}`;
    for (const w of wires) union(endKey(w.x1, w.y1), endKey(w.x2, w.y2));
    const chains = new Map<string, typeof wires>();
    for (const w of wires) {
      const root = find(endKey(w.x1, w.y1));
      const list = chains.get(root);
      if (list) list.push(w);
      else chains.set(root, [w]);
    }
    for (const chain of [...chains.values()].sort((a, b) => a[0]!.index - b[0]!.index)) {
      schematicTraces.push({
        type: 'schematic_trace',
        schematic_trace_id: `schematic_trace_${schematicTraces.length}`,
        source_trace_id: traceId,
        edges: chain.map((w) => ({ from: toCj(w.x1, w.y1), to: toCj(w.x2, w.y2) })),
        junctions: [],
      });
    }
  });

  const labels = [...model.labels]
    .filter((l) => netId.has(l.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.x - b.x || a.y - b.y);
  const netLabels: CircuitJsonElement[] = labels.map((l, i) => ({
    type: 'schematic_net_label',
    schematic_net_label_id: `schematic_net_label_${i}`,
    source_net_id: netId.get(l.name)!,
    text: l.name,
    center: toCj(l.x, l.y),
    anchor_position: toCj(l.x, l.y),
    // A rot-0 KiCad label extends rightward from its anchor; 180 extends left.
    anchor_side: l.rot === 180 ? 'right' : 'left',
  }));

  return [
    ...sourceComponents,
    ...sourcePorts,
    ...sourceNets,
    ...sourceTraces,
    ...schematicComponents,
    ...schematicPorts,
    ...schematicTraces,
    ...netLabels,
  ];
}

/** Canonical file bytes: 2-space indent, trailing newline. */
export function serializeCircuitJson(elements: CircuitJsonElement[]): string {
  return JSON.stringify(elements, null, 2) + '\n';
}
