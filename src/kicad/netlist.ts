/**
 * Schematic netlist: `kicad-cli sch export netlist --format kicadsexpr` plus a
 * minimal parser. This is the input that seeds a `.kicad_pcb` with real parts
 * and nets (issue #252 board population), so the board never has to be authored
 * from memory.
 */

import { parseSexp, isList, children, child, type SexpNode } from './sexp.js';
import { exportNetlist } from './cli.js';

/** One component from the netlist `(comp …)` record. */
export interface NetlistComponent {
  ref: string;
  value: string;
  footprint: string;
}

/** One pin of a net (`(node (ref …) (pin …))`). */
export interface NetlistNode {
  ref: string;
  pin: string;
}

export interface NetlistNet {
  name: string;
  nodes: NetlistNode[];
}

export interface Netlist {
  components: NetlistComponent[];
  nets: NetlistNet[];
}

const atom = (n: SexpNode[] | undefined, i: number): string | undefined => {
  const v = n?.[i];
  return typeof v === 'string' ? v : undefined;
};

export function parseNetlist(text: string): Netlist {
  const root = parseSexp(text).find(isList);
  if (!root) return { components: [], nets: [] };

  const components: NetlistComponent[] = [];
  for (const comp of children(child(root, 'components') ?? [], 'comp')) {
    const ref = atom(child(comp, 'ref'), 1);
    const value = atom(child(comp, 'value'), 1) ?? '';
    const footprint = atom(child(comp, 'footprint'), 1) ?? '';
    if (ref) components.push({ ref, value, footprint });
  }

  const nets: NetlistNet[] = [];
  for (const net of children(child(root, 'nets') ?? [], 'net')) {
    const name = atom(child(net, 'name'), 1);
    if (!name) continue;
    const nodes: NetlistNode[] = [];
    for (const node of children(net, 'node')) {
      const ref = atom(child(node, 'ref'), 1);
      const pin = atom(child(node, 'pin'), 1);
      if (ref && pin) nodes.push({ ref, pin });
    }
    nets.push({ name, nodes });
  }

  return { components, nets };
}

/** Export + parse the netlist for a schematic in one step. */
export async function readNetlist(schPath: string): Promise<Netlist> {
  return parseNetlist(await exportNetlist(schPath));
}
