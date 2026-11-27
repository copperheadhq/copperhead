/**
 * Copper emission for export (implementation spec §4.4): KiCad's own record
 * layout for segments, arcs, and vias, with UUIDv5 ids derived from semantic
 * paths so the same candidate lowers to the same bytes.
 */
import { uuidv5 } from '../../../kicad/emit.js';
import { nmToMm } from '../units.js';
import type { TrackSegment, TrackArc, Via, NetDefinition } from '../types.js';

export interface CopperNames {
  /** net id -> net code and name, from the design the copper belongs to. */
  nets: Map<string, Pick<NetDefinition, 'code' | 'name'>>;
  /** Namespace for the derived uuids (the design id). */
  namespace: string;
  /** The source file's net dialect: `(net N)` codes or `(net "name")` (KiCad 10.0.4's 20260206 format). */
  dialect: 'code' | 'name';
}

const netName = (names: CopperNames, netId: string): string => names.nets.get(netId)?.name ?? '';
const netRecord = (names: CopperNames, netId: string): string =>
  names.dialect === 'name' ? `(net "${netName(names, netId)}")` : `(net ${names.nets.get(netId)?.code ?? 0})`;

export function emitSegment(s: TrackSegment, names: CopperNames, ordinal: number): string {
  const id = s.id || uuidv5(`copper/${netName(names, s.netId)}/${s.layer}/segment/${ordinal}`, names.namespace);
  return `\t(segment\n\t\t(start ${nmToMm(s.a.x)} ${nmToMm(s.a.y)})\n\t\t(end ${nmToMm(s.b.x)} ${nmToMm(s.b.y)})\n\t\t(width ${nmToMm(s.width)})\n\t\t(layer "${s.layer}")\n\t\t${netRecord(names, s.netId)}\n\t\t(uuid "${id}")\n\t)`;
}

export function emitArc(a: TrackArc, names: CopperNames, ordinal: number): string {
  const id = a.id || uuidv5(`copper/${netName(names, a.netId)}/${a.layer}/arc/${ordinal}`, names.namespace);
  return `\t(arc\n\t\t(start ${nmToMm(a.a.x)} ${nmToMm(a.a.y)})\n\t\t(mid ${nmToMm(a.mid.x)} ${nmToMm(a.mid.y)})\n\t\t(end ${nmToMm(a.b.x)} ${nmToMm(a.b.y)})\n\t\t(width ${nmToMm(a.width)})\n\t\t(layer "${a.layer}")\n\t\t${netRecord(names, a.netId)}\n\t\t(uuid "${id}")\n\t)`;
}

export function emitVia(v: Via, names: CopperNames, ordinal: number): string {
  const id = v.id || uuidv5(`copper/${netName(names, v.netId)}/via/${ordinal}`, names.namespace);
  return `\t(via\n\t\t(at ${nmToMm(v.at.x)} ${nmToMm(v.at.y)})\n\t\t(size ${nmToMm(v.size)})\n\t\t(drill ${nmToMm(v.drill)})\n\t\t(layers "${v.layers[0]}" "${v.layers[1]}")\n\t\t${netRecord(names, v.netId)}\n\t\t(uuid "${id}")\n\t)`;
}

/** Emit a whole routing set in a stable order: segments, arcs, vias, each in the order given. */
export function emitCopper(routing: { segments: TrackSegment[]; arcs?: TrackArc[]; vias: Via[] }, names: CopperNames): string {
  const out: string[] = [];
  routing.segments.forEach((s, i) => out.push(emitSegment(s, names, i)));
  (routing.arcs ?? []).forEach((a, i) => out.push(emitArc(a, names, i)));
  routing.vias.forEach((v, i) => out.push(emitVia(v, names, i)));
  return out.join('\n');
}
