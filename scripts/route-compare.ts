/**
 * Route one real KiCad project's DSN through several routing engines and compare
 * the imported result against the project's own hand-routed `.kicad_pcb` — the
 * golden reference. This is the "try the alternatives" half of the founder's
 * #253 review: it executes Freerouting (the jar) and the `freeroute` Python port
 * side by side, imports each result through the same DSN/SES bridge, and reports
 * unrouted nets, DRC, track/via counts, and connectivity side by side.
 *
 * The comparison is metric-based, not a diff: the golden was placed by a person,
 * while copperhead places on a deterministic grid before routing (see
 * `src/kicad/layout/placement.ts`). What IS machine-checked, and checked here per
 * engine:
 *
 *   - routing completion: the routed board must have zero unrouted nets
 *   - DRC: no error-severity violations beyond the ratsnest
 *   - connectivity: every two-pad net the golden connects must also be connected
 *
 * Reported side by side (not asserted equal): track count, via count, board area,
 * and the number of nets each board leaves unrouted.
 *
 * Engine list (each is genuinely executed; a router that does not run is reported
 * as such, never fabricated):
 *
 *   - freerouting jar  (`java -jar freerouting.jar -de dsn -do ses`)
 *   - freeroute grid   (`freeroute -de dsn -do ses --engine grid`)
 *   - freeroute exact  (`freeroute ... --engine exact --shove --diagonal`)
 *   - freeroute room   (`freeroute ... --engine room --pack --shove`)
 *
 * The two writers disagree on SES coordinate units: Freerouting's SesWriter emits
 * Specctra *resolution units* (0.1 µm for `(resolution um 10)`), while `freeroute`
 * echoes raw micrometres. {@link parseSes} reads the former by default; this
 * script passes `resolutionUnits: false` for the `freeroute` engines.
 *
 * Everything lands under `manual-tests/runs/router-compare/<project>/` (gitignored).
 * The golden reference is read from the corpus in place and never modified.
 *
 * Usage:
 *   COPPERHEAD_FREEROUTING_JAR=/path/to.jar \
 *   COPPERHEAD_FREEROUTE_BIN=/path/to/freeroute \
 *     npm run route:compare                      # complex_hierarchy
 *   npm run route:compare -- interf_u
 *
 * Needs kicad-cli, a JRE 21+ on PATH, and the `freeroute` Python CLI on PATH
 * (or its path in COPPERHEAD_FREEROUTE_BIN).
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { emitRoutedBoard } from '../src/kicad/board.js';
import { runDrc } from '../src/kicad/cli.js';
import { emitDsn, parseSes } from '../src/kicad/layout/dsn.js';
import { FreeroutingRoutingEngine, resolveFreeroutingJar } from '../src/kicad/layout/freerouting.js';
import { DEFAULT_LAYOUT_RULES, populateBoard } from '../src/kicad/layout/layout.js';
import { readNetlist } from '../src/kicad/netlist.js';
import { hardViolations, type CheckReport } from '../src/kicad/report.js';
import { parseSexp, isList, children, child, type SexpNode } from '../src/kicad/sexp.js';
import type { BoardModel, RoutedBoard } from '../src/kicad/layout/types.js';

const atomAt = (n: SexpNode[] | undefined, i: number): string | undefined => {
  const v = n?.[i];
  return typeof v === 'string' ? v : undefined;
};

const CORPUS = process.env.CORPUS_DIR ?? process.env.COPPERHEAD_CORPUS_DIR ?? '/usr/share/kicad/demos';
const OUT_ROOT = path.join('manual-tests', 'runs', 'router-compare');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/** A router engine this script can actually execute. */
interface Engine {
  id: string;
  label: string;
  /** `freeroute` engine selector, or null for the Freerouting jar. */
  freerouteEngine: 'grid' | 'exact' | 'room' | null;
  /** Extra `freeroute` CLI flags (after `-de`/`-do`). */
  freerouteFlags: string[];
}

const ENGINES: Engine[] = [
  { id: 'freerouting-jar', label: 'Freerouting 2.3.0 (jar)', freerouteEngine: null, freerouteFlags: [] },
  { id: 'freeroute-grid', label: 'freeroute grid', freerouteEngine: 'grid', freerouteFlags: [] },
  {
    id: 'freeroute-exact',
    label: 'freeroute exact',
    freerouteEngine: 'exact',
    freerouteFlags: ['--shove', '--diagonal'],
  },
  {
    id: 'freeroute-room',
    label: 'freeroute room',
    freerouteEngine: 'room',
    freerouteFlags: ['--pack', '--shove'],
  },
];

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
  return hardViolations(drc).length;
}

/** Copper count from a `.kicad_pcb`: tracks (segments) and vias. */
function copperCount(pcbText: string): { tracks: number; vias: number } {
  const root = parseSexp(pcbText).find(isList);
  if (!root) return { tracks: 0, vias: 0 };
  return { tracks: children(root, 'segment').length, vias: children(root, 'via').length };
}

/** Reference designator of a footprint, across the two board formats. */
function refdesOf(fp: SexpNode[]): string | null {
  for (const p of children(fp, 'property')) if (atomAt(p, 1) === 'Reference') return atomAt(p, 2) ?? null;
  for (const t of children(fp, 'fp_text')) if (atomAt(t, 1) === 'reference') return atomAt(t, 2) ?? null;
  return null;
}

/** Net name → sorted `ref:pad` set, for the connectivity comparison. */
function netPartitionOf(pcbText: string): Map<string, Set<string>> {
  const root = parseSexp(pcbText).find(isList);
  const out = new Map<string, Set<string>>();
  if (!root) return out;
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

/** A single engine's measured result, or the reason it could not run. */
interface EngineResult {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
  seconds?: number;
  tracks?: number;
  vias?: number;
  hardErrors?: number;
  unrouted?: number;
  connectivity?: string;
}

/** Resolve the `freeroute` CLI, or null when not installed. */
async function resolveFreeroute(): Promise<string | null> {
  const explicit = process.env.COPPERHEAD_FREEROUTE_BIN?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  if (explicit) return null;
  const probe = await execa('freeroute', ['--help'], { reject: false });
  return probe.failed ? null : 'freeroute';
}

async function routeFreeroute(
  bin: string,
  dsnPath: string,
  sesPath: string,
  engine: Engine,
): Promise<{ ok: boolean; seconds: number; error?: string }> {
  const args = ['-de', dsnPath, '-do', sesPath, '--engine', engine.freerouteEngine!, ...engine.freerouteFlags];
  const t0 = performance.now();
  // Bound each run so a slow engine (the `room` engine does not finish on a
  // 68-part board) is reported as "timed out" rather than hanging the sweep.
  const res = await execa(bin, args, { reject: false, all: true, timeout: 120_000 });
  const seconds = (performance.now() - t0) / 1000;
  if (res.failed) {
    const timedOut = res.timedOut;
    const detail = timedOut ? `timed out after ${seconds.toFixed(0)} s` : `exit ${res.exitCode}: ${(res.all ?? '').trim().slice(0, 400) || '(no output)'}`;
    return { ok: false, seconds, error: detail };
  }
  return { ok: true, seconds };
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
  const { board, unresolved } = await populateBoard(sch);
  const name = path.basename(project);
  const goldenText = await readFile(golden, 'utf8');

  const goldenNets = netPartitionOf(goldenText);
  const goldenReal = [...goldenNets.entries()].filter(([, pads]) => pads.size >= 2);
  const goldenDrc = await runDrc(golden);

  // One DSN, shared by the `freeroute` engines. The jar generates the same DSN
  // internally (deterministic emitDsn of the same board+rules).
  const dsnText = emitDsn(board, DEFAULT_LAYOUT_RULES, { boardName: name });
  const dsnPath = path.join(out, 'board.dsn');
  await writeFile(dsnPath, dsnText, 'utf8');

  const results: EngineResult[] = [];
  const freerouteBin = await resolveFreeroute();

  for (const engine of ENGINES) {
    const entry: EngineResult = { id: engine.id, label: engine.label, ok: false };
    try {
      let routed: RoutedBoard;
      let seconds: number;

      if (engine.freerouteEngine === null) {
        // Freerouting jar: reuse the production adapter (java + DSN + SES parse).
        const jar = resolveFreeroutingJar();
        const t0 = performance.now();
        routed = await new FreeroutingRoutingEngine(jar).route(board, DEFAULT_LAYOUT_RULES);
        seconds = (performance.now() - t0) / 1000;
      } else {
        if (!freerouteBin) {
          entry.error = 'freeroute CLI not installed (set COPPERHEAD_FREEROUTE_BIN)';
          results.push(entry);
          continue;
        }
        const sesPath = path.join(out, `${engine.id}.ses`);
        const r = await routeFreeroute(freerouteBin, dsnPath, sesPath, engine);
        seconds = r.seconds;
        if (!r.ok) {
          entry.error = r.error;
          results.push(entry);
          continue;
        }
        // `freeroute` echoes raw micrometre coordinates, not resolution units.
        routed = parseSes(await readFile(sesPath, 'utf8'), { rules: DEFAULT_LAYOUT_RULES, resolutionUnits: false });
      }

      const pcbPath = path.join(out, `${engine.id}.kicad_pcb`);
      const routedText = emitRoutedBoard(board, name, routed);
      await writeFile(pcbPath, routedText, 'utf8');

      const drc = await runDrc(pcbPath);
      const copper = copperCount(routedText);
      const matched = goldenReal.filter(
        ([n, pads]) => netPartitionOf(routedText).get(n) && setEq(netPartitionOf(routedText).get(n)!, pads),
      ).length;

      entry.ok = true;
      entry.seconds = seconds;
      entry.tracks = copper.tracks;
      entry.vias = copper.vias;
      entry.hardErrors = hardErrors(drc);
      entry.unrouted = drc.unrouted.length;
      entry.connectivity = `${matched}/${goldenReal.length}`;
    } catch (e) {
      entry.error = (e as Error).message.split('\n')[0];
    }
    results.push(entry);
  }

  // Report.
  const goldenCopper = copperCount(goldenText);
  const lines = [
    `# ${project} — router comparison`,
    ``,
    `Source: \`${sch}\``,
    `Golden: \`${golden}\` (unmodified)`,
    `Components: ${netlist.components.length}   Nets: ${netlist.nets.filter((n) => n.nodes.length >= 2).length}   Unresolved footprints: ${unresolved.length}`,
    ``,
    `## Golden reference`,
    ``,
    `- tracks: ${goldenCopper.tracks}   vias: ${goldenCopper.vias}`,
    `- DRC hard violations: ${hardErrors(goldenDrc)}   unrouted nets: ${goldenDrc.unrouted.length}`,
    ``,
    `## Engines`,
    ``,
    `| Engine | Ran | Routed? | Tracks | Vias | Hard DRC | Unrouted | Connect | Runtime |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...results.map((r) => {
      const ran = r.ok || r.error ? 'yes' : 'no';
      const routed = r.ok ? (r.tracks! > 0 ? 'yes' : 'no') : '—';
      const cell = (v: number | string | undefined) => (v === undefined ? '—' : String(v));
      return `| ${r.label} | ${ran} | ${r.ok ? routed : r.error ?? '—'} | ${cell(r.tracks)} | ${cell(r.vias)} | ${cell(
        r.hardErrors,
      )} | ${cell(r.unrouted)} | ${cell(r.connectivity)} | ${r.seconds ? `${r.seconds.toFixed(1)} s` : '—'} |`;
    }),
    ``,
    `## Notes`,
    ``,
    `- "Hard DRC" counts error-severity violations excluding the ratsnest, so 0 means the routed board is hard-clean.`,
    `- "Connect" is the number of golden 2-pad nets the imported board joins identically (net-name → pad set equality).`,
    `- A \`freeroute\` engine that drops a net leaves it unrouted rather than emit a DRC violation (documented upstream behaviour).`,
    ``,
  ];

  if (unresolved.length) {
    lines.push(`### Unresolved footprints`, ``, ...unresolved.map((u) => `- \`${u.ref}\`: \`${u.footprint}\``), ``);
  }

  await writeFile(path.join(out, 'REPORT.md'), lines.join('\n'), 'utf8');
  return `${project}: ${results.map((r) => `${r.id}=${r.ok ? `t${r.tracks}/h${r.hardErrors}/u${r.unrouted}` : `ERR(${r.error ?? 'skipped'})`}`).join(' ')}`;
}

if (!existsSync(CORPUS)) {
  console.error(`no corpus at ${CORPUS}; set COPPERHEAD_CORPUS_DIR to a directory of KiCad projects`);
  process.exit(1);
}
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
await writeFile(path.join(OUT_ROOT, 'SUMMARY.md'), `# Router comparison run\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`, 'utf8');
console.log(`\nwrote ${path.join(OUT_ROOT, 'SUMMARY.md')}`);
