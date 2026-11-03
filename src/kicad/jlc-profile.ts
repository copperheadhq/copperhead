import { child, children, isList, parseSexp, type SexpNode } from './sexp.js';

/** Settings profile only, never manufacturer approval or fabrication release. */
export const JLC_PROFILE = 'jlcpcb-kicad9-2026-09-24';
export const JLC_DRILL_ARGS = ['--format', 'excellon', '--drill-origin', 'absolute', '--excellon-units', 'mm',
  '--excellon-zeros-format', 'decimal', '--excellon-oval-format', 'alternate', '--excellon-separate-th'];

export interface JlcProfile { layers: string[]; functions: string[] }
export function jlcProfile(board: string): JlcProfile {
  const root = parseSexp(board)[0];
  if (!isList(root ?? '') || root![0] !== 'kicad_pcb') throw new Error('JLC profile requires a KiCad board');
  const layerRows = child(root!, 'layers');
  const copper = (layerRows ?? []).filter(isList).map(row => row[1]).filter((name): name is string =>
    typeof name === 'string' && /^(F|B|In\d+)\.Cu$/.test(name));
  const inner = copper.filter(n => n.startsWith('In')).sort((a,b) => Number(a.slice(2,-3))-Number(b.slice(2,-3)));
  if (!copper.includes('F.Cu') || !copper.includes('B.Cu') || copper.length !== inner.length+2 ||
      inner.some((name,i) => name !== `In${i+1}.Cu`)) throw new Error('JLC profile requires an unambiguous contiguous copper stack');
  function checkZones(node: SexpNode): void {
    if (!isList(node)) return;
    // Rule-area/keepout zones have no copper fill. Real zones (including zones
    // inside footprints) require fill validation unavailable in this KiCad 9 CLI.
    if (node[0] === 'zone' && !child(node, 'keepout')) {
      throw new Error('JLC profile blocked: copper zone fill cannot be verified by KiCad 9 CLI; validate/refill through a supported workflow first (no override supplied)');
    }
    for (const sub of node) checkZones(sub);
  }
  checkZones(root!);
  const ordered = ['F.Cu', ...inner, 'B.Cu'];
  const functions = ordered.map((_,i)=>`Copper,L${i+1},${i===0?'Top':i===ordered.length-1?'Bot':'Inr'}`);
  return {
    layers: [...ordered, 'F.Mask', 'B.Mask', 'F.SilkS', 'B.SilkS', 'Edge.Cuts', 'F.Paste', 'B.Paste'],
    functions: [...functions, 'Soldermask,Top', 'Soldermask,Bot', 'Legend,Top', 'Legend,Bot', 'Profile,NP', 'Paste,Top', 'Paste,Bot'],
  };
}

/** Include child sheets in freshness evidence; no schematic content is edited. */
export function childSheetFiles(schematic: string): string[] {
  const root = parseSexp(schematic)[0];
  if (!root || !isList(root) || root[0] !== 'kicad_sch') throw new Error('expected a KiCad schematic');
  return children(root, 'sheet').map(sheet => {
    const field = children(sheet, 'property').find(p => p[1] === 'Sheetfile' || p[1] === 'Sheet file');
    if (typeof field?.[2] !== 'string' || !field[2]) throw new Error('schematic sheet has no file');
    return field[2];
  });
}
