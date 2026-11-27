/**
 * The copper stack (add-multilayer-layout, design D1): copper layers ordered front to back from their
 * canonical names, F.Cu, In1.Cu … InN.Cu, B.Cu, whichever layer numbers the file carries. KiCad wrote
 * In1.Cu as 1 and B.Cu as 31 for years and writes B.Cu 2, In1.Cu 4, In2.Cu 6 since version 9; the
 * names are what every tool in the chain keys on, so they are what the stack is built from. Every
 * consumer of copper layers reads it from here.
 */
import type { PcbDesign, LayerDefinition, Via } from './types.js';

/** Copper layers a board may have on this change (design D1). */
export const MAX_COPPER_LAYERS = 6;

const INNER = /^In(\d+)\.Cu$/;

/** Stack order of a canonical copper name: 0 for F.Cu, n for In<n>.Cu, a large number for B.Cu, null for a name the stack cannot place. */
function rankOf(id: string): number | null {
  if (id === 'F.Cu') return 0;
  if (id === 'B.Cu') return Number.MAX_SAFE_INTEGER;
  const m = INNER.exec(id);
  return m ? Number(m[1]) : null;
}

/** The copper stack, front to back. Layers the stack cannot place are left out; `stackProblems` names them. */
export function copperStack(design: Pick<PcbDesign, 'board'> | LayerDefinition[]): string[] {
  const layers = Array.isArray(design) ? design : design.board.layers;
  return layers
    .filter((l) => l.kind === 'copper')
    .map((l) => ({ id: l.id, rank: rankOf(l.id) }))
    .filter((x): x is { id: string; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.id);
}

/** Why a board's copper is not a stack this change supports: an unnameable copper layer, too many layers, or a missing outer layer. */
export function stackProblems(design: Pick<PcbDesign, 'board'> | LayerDefinition[]): string[] {
  const layers = Array.isArray(design) ? design : design.board.layers;
  const copper = layers.filter((l) => l.kind === 'copper');
  const out: string[] = [];
  for (const l of copper) if (rankOf(l.id) === null) out.push(`copper layer "${l.id}" is not F.Cu, B.Cu, or In<n>.Cu`);
  if (copper.length > MAX_COPPER_LAYERS) out.push(`${copper.length} copper layers; this release supports up to ${MAX_COPPER_LAYERS}`);
  const stack = copperStack(layers);
  if (copper.length >= 2 && (stack[0] !== 'F.Cu' || stack[stack.length - 1] !== 'B.Cu')) out.push(`the outer copper layers are ${stack[0] ?? '?'} and ${stack[stack.length - 1] ?? '?'}, not F.Cu and B.Cu`);
  const inner = stack.filter((id) => INNER.test(id)).map((id) => Number(INNER.exec(id)![1]));
  for (let i = 0; i < inner.length; i++) if (inner[i] !== i + 1) { out.push(`inner copper layers are ${inner.map((n) => `In${n}.Cu`).join(', ')}, not In1.Cu … In${inner.length}.Cu`); break; }
  return out;
}

/** The fabrication profile id a board defaults to by copper count: `jlcpcb-<n>layer` (the verify layer owns the profiles; the IR owns only the name). */
export function defaultProfileIdFor(copperLayers: number): string {
  return copperLayers === 4 ? 'jlcpcb-4layer' : copperLayers === 6 ? 'jlcpcb-6layer' : 'jlcpcb-2layer';
}

/** The two outer layers: front and back. */
export function outerLayers(design: Pick<PcbDesign, 'board'> | LayerDefinition[]): [string, string] {
  const s = copperStack(design);
  return [s[0] ?? 'F.Cu', s[s.length - 1] ?? 'B.Cu'];
}

/** Every layer a via joins: the stack slice between its two ends, inclusive, in stack order. Ends outside the stack give just the ends. */
export function viaSpan(via: Pick<Via, 'layers'>, stack: string[]): string[] {
  const a = stack.indexOf(via.layers[0]);
  const b = stack.indexOf(via.layers[1]);
  if (a < 0 || b < 0) return [...new Set(via.layers)];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return stack.slice(lo, hi + 1);
}

/** A via is a through via when its ends are the two outer layers. */
export function isThroughVia(via: Pick<Via, 'layers'>, stack: string[]): boolean {
  const ends = new Set(via.layers);
  return stack.length >= 2 && ends.size === 2 && ends.has(stack[0]!) && ends.has(stack[stack.length - 1]!);
}
