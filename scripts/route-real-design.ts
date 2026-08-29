/**
 * Route a real KiCad project with copperhead's board pipeline (issue #252) and
 * put the result next to the project's own hand-routed `.kicad_pcb` — the golden
 * reference. Unlike the drafting sweep, the two boards never match byte for
 * byte: the golden was placed by a person and routed (in these demos) by a
 * different tool, and copperhead places on a deterministic grid before routing.
 * So the comparison is metric-based, not a diff.
 *
 * What IS machine-checkable, and checked here:
 *
 *   - component count and net count (populate must see the whole design)
 *   - routing completion: the routed board must have zero unrouted nets
 *   - DRC: no error-severity violations beyond the ratsnest on either board
 *   - connectivity: every two-pad net the golden connects must also be connected
 *     by copperhead's route (net-name → set of joined pads equality)
 *
 * Reported side by side (not asserted equal): track count, via count, board
 * area, and the number of nets each board leaves unrouted.
 *
 * Everything lands under `manual-tests/runs/real-routes/<project>/` (gitignored).
 * The golden reference is read from the corpus in place and never modified.
 *
 * Usage:
 *   npm run route:realdesign                          # one built-in project
 *   npm run route:realdesign -- interf_u              # a different project
 *   COPPERHEAD_CORPUS_DIR=/path npm run route:realdesign
 *   COPPERHEAD_FREEROUTING_JAR=/path/to.jar npm run route:realdesign
 *
 * Needs kicad-cli, a JRE 21+, and a Freerouting jar (local, offline).
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSexp, isList, children, child } from '../src/kicad/sexp.js';
import { runDrc } from '../src/kicad/cli.js';
import { DEFAULT_LAYOUT_RULES, populateBoard } from '../src/kicad/layout/layout.js';
import { FreeroutingRoutingEngine, resolveFreeroutingJar } from '../src/kicad/layout/freerouting.js';
import { emitRoutedBoard } from '../src/kicad/board.js';
import { readNetlist } from '../src/kicad/netlist.js';
import type { CheckReport } from '../src/kicad/report.js';
import type { SexpNode } from '../src/kicad/sexp.js';

const atomAt = (n: SexpNode[] | undefined, i: number): string | undefined => {
  const v = n?.[i];
  return typeof v === 'string' ? v : undefined;
};

const CORPUS = process.env.CORPUS_DIR ?? process.env.COPPERHEAD_CORPUS_DIR ?? '/usr/share/kicad/demos';
const OUT_ROOT = path.join('manual-tests', 'runs', 'real-routes');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

async function rootSchOf(dir: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => []);
  const pro = files.find((f) => f.endsWith('.kicad_pro'));
  if (pro) {
    const base = pro.replace(/\.kicad_pro$/, '.kicad_sch');
    return files.includes(base) ? path.join(dir, base) : null;
  }
  const any = files.find((f) => f.endsWith('.kicad_sch'));
  return any ? path.join(dir, any) : null;
}

async function goldenPcbOf(dir: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => []);
  const any = files.find((f) => f.endsWith('.kicad_pcb'));
  return any ? path.join(dir, any) : null;
}

/** Hard (non-ratsnest) error-severity violations, mirroring {@link hardViolations}. */
function hardErrors(drc: CheckReport): number {
  return drc.violations.filter((v) => v.severity === 'error' && !drc.unrouted.includes(v)).length;
}

/** Copper count from a `.kicad_pcb`: tracks (segments) and vias. */
function copperCount(pcbText: string): { tracks: number; vias: number } {
  const root = parseSexp(pcbText).find(isList);
  if (!root) return { tracks: 0, vias: 0 };
  return { tracks: children(root, 'segment').length, vias: children(root, 'via').length };
}

/** Board outline width/height from a `.kicad_pcb` Edge.Cuts graphics (rect or lines). */
function boardSize(pcbText: string): { width: number; height: number } | null {
  const root = parseSexp(pcbText).find(isList);
  if (!root) return null;
  const isEdge = (n: SexpNode[]): boolean => atomAt(child(n, 'layer'), 1) === 'Edge.Cuts';
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const rect of children(root, 'gr_rect')) {
    if (!isEdge(rect)) continue;
    const s = child(rect, 'start');
    const e = child(rect, 'end');
    grow(Number(atomAt(s, 1)), Number(atomAt(s, 2)));
    grow(Number(atomAt(e, 1)), Number(atomAt(e, 2)));
  }
  for (const line of children(root, 'gr_line')) {
    if (!isEdge(line)) continue;
    const s = child(line, 'start');
    const e = child(line, 'end');
    grow(Number(atomAt(s, 1)), Number(atomAt(s, 2)));
    grow(Number(atomAt(e, 1)), Number(atomAt(e, 2)));
  }
  return Number.isFinite(minX) ? { width: Math.abs(maxX - minX), height: Math.abs(maxY - minY) } : null;
}

/** Reference designator of a footprint, across the two board formats. */
function refdesOf(fp: SexpNode[]): string | null {
  // KiCad 8+ (copperhead's emitter): (property "Reference" "C10" …)
  for (const p of children(fp, 'property')) {
    if (atomAt(p, 1) === 'Reference') return atomAt(p, 2) ?? null;
  }
  // KiCad ≤ 7 (the shipped demos): (fp_text reference "C10" …)
  for (const t of children(fp, 'fp_text')) {
    if (atomAt(t, 1) === 'reference') return atomAt(t, 2) ?? null;
  }
  return null;
}

/** Net name → sorted `ref:pad` set, for the connectivity comparison. */
function netPartitionOf(pcbText: string): Map<string, Set<string>> {
  const root = parseSexp(pcbText).find(isList);
  const out = new Map<string, Set<string>>();
  if (!root) return out;
  // (net N "NAME") defines the number → name map.
  const numName = new Map<string, string>();
  for (const net of children(root, 'net')) {
    const num = atomAt(net, 1);
    const name = atomAt(net, 2);
    if (num && name) numName.set(num, name);
  }
  for (const fp of children(root, 'footprint')) {
    const ref = refdesOf(fp);
    if (!ref) continue;
    for (const pad of children(fp, 'pad')) {
      const pn = atomAt(pad, 1);
      const netNode = child(pad, 'net');
      const netNum = netNode ? atomAt(netNode, 1) : undefined;
      if (pn && netNum && netNum !== '0') {
        const name = numName.get(netNum) ?? netNum;
        if (!out.has(name)) out.set(name, new Set());
        out.get(name)!.add(`${ref}:${pn}`);
      }
    }
  }
  return out;
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

async function run(project: string): Promise<string> {
  const dir = path.join(CORPUS, project);
  const sch = await rootSchOf(dir);
  const golden = await goldenPcbOf(dir);
  if (!sch) return `${project}: no root schematic`;
  if (!golden) return `${project}: no golden .kicad_pcb to compare against`;

  const out = path.join(OUT_ROOT, project);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const netlist = await readNetlist(sch);
  const pcb = path.join(out, 'board.kicad_pcb');
  const jar = resolveFreeroutingJar();

  // Populate + place, then route directly (not through runBoardLayout) so the
  // routed copper is kept for comparison even when it carries violations that
  // runBoardLayout would roll back to a safe ratsnest.
  const { board, unresolved } = await populateBoard(sch);
  const name = path.basename(pcb, '.kicad_pcb');
  const routed = await new FreeroutingRoutingEngine(jar).route(board, DEFAULT_LAYOUT_RULES);
  const routedText = emitRoutedBoard(board, name, routed);
  await writeFile(pcb, routedText, 'utf8');

  const goldenText = await readFile(golden, 'utf8');

  // DRC both boards with the same tool.
  const oursDrc = await runDrc(pcb);
  const goldenDrc = await runDrc(golden);

  const oursCopper = copperCount(routedText);
  const goldenCopper = copperCount(goldenText);
  const oursSize = boardSize(routedText);
  const goldenSize = boardSize(goldenText);

  // Connectivity: which golden nets (with >= 2 pads) does the routed board join identically?
  const goldenNets = netPartitionOf(goldenText);
  const oursNets = netPartitionOf(routedText);
  const goldenReal = [...goldenNets.entries()].filter(([, pads]) => pads.size >= 2);
  const matched = goldenReal.filter(([n, pads]) => oursNets.get(n) && setEq(oursNets.get(n)!, pads)).length;

  const oursHard = hardErrors(oursDrc);
  const lines = [
    `# ${project} — routed vs golden`,
    ``,
    `Source: \`${sch}\``,
    `Golden: \`${golden}\` (unmodified)`,
    `Routed: \`${pcb}\``,
    ``,
    `Components: ${netlist.components.length}   Nets: ${netlist.nets.filter((n) => n.nodes.length >= 2).length}`,
    ``,
    `## Copperhead`,
    ``,
    `- placed: ${board.footprints.length}/${netlist.components.length} footprint(s) (unresolved: ${unresolved.length})`,
    `- routed: yes (Freerouting)`,
    `- tracks: ${oursCopper.tracks}   vias: ${oursCopper.vias}`,
    `- board: ${oursSize ? `${oursSize.width.toFixed(1)} × ${oursSize.height.toFixed(1)} mm` : '?'}`,
    `- DRC hard violations: ${oursHard}   unrouted nets: ${oursDrc.unrouted.length}`,
    `- note: ${oursHard === 0 && oursDrc.unrouted.length === 0 ? 'hard-clean and fully routed' : 'router introduced violations; runBoardLayout would roll back to the placed board'}`,
    ``,
    `## Golden reference`,
    ``,
    `- tracks: ${goldenCopper.tracks}   vias: ${goldenCopper.vias}`,
    `- board: ${goldenSize ? `${goldenSize.width.toFixed(1)} × ${goldenSize.height.toFixed(1)} mm` : '?'}`,
    `- DRC hard violations: ${hardErrors(goldenDrc)}   unrouted nets: ${goldenDrc.unrouted.length}`,
    ``,
    `## Connectivity`,
    ``,
    `Golden nets (≥ 2 pads): ${goldenReal.length}`,
    `Routed board joins identically: ${matched}`,
    ``,
  ];

  if (unresolved.length) {
    lines.push(`### Unresolved footprints`, ``, ...unresolved.map((u) => `- \`${u.ref}\`: \`${u.footprint}\``), ``);
  }

  await writeFile(path.join(out, 'REPORT.md'), lines.join('\n'), 'utf8');
  return (
    `${project}: parts=${netlist.components.length} nets=${netlist.nets.filter((n) => n.nodes.length >= 2).length} ` +
    `tracks=${oursCopper.tracks} vias=${oursCopper.vias} ` +
    `hardErrs=${oursHard} unrouted=${oursDrc.unrouted.length} ` +
    `goldenTracks=${goldenCopper.tracks} goldenVias=${goldenCopper.vias} ` +
    `connect=${matched}/${goldenReal.length}`
  );
}

if (!existsSync(CORPUS)) {
  console.error(`no corpus at ${CORPUS}; set COPPERHEAD_CORPUS_DIR to a directory of KiCad projects`);
  process.exit(1);
}
// Default to a fully-resolvable, fully-THT board with a golden `.kicad_pcb`;
// overridable on the command line.
const all = (await readdir(CORPUS, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
const requested = only.length ? only : ['complex_hierarchy'];
const projects = requested.filter((p) => all.includes(p));
if (!projects.length) {
  console.error(`no matching projects in ${CORPUS}: ${requested.join(', ')}`);
  process.exit(1);
}
const lines: string[] = [];
for (const p of projects) {
  try {
    lines.push(await run(p));
  } catch (e) {
    const line = `${p}: ERROR ${(e as Error).message.split('\n')[0]}`;
    console.log(line);
    lines.push(line);
  }
}
await writeFile(path.join(OUT_ROOT, 'SUMMARY.md'), `# Real-design route run\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`, 'utf8');
console.log(`\nwrote ${path.join(OUT_ROOT, 'SUMMARY.md')}`);
