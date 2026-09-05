import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { draftSchematicToText } from '../src/kicad/draft/draft.js';
import { findSymbolAcrossLibraries } from '../src/kicad/symlib.js';
import { extractEmbeddedLibs } from './support/embedded-libs.js';
import {
  classifyRefusal,
  netPartition,
  netlistToIntent,
  parseNetlist,
  type Netlist,
  type RefusalKind,
} from './support/netlist.js';

/**
 * The engine against real designs, not fixtures.
 *
 * Every other draft suite feeds the engine intents we wrote. That makes them
 * good regression tests and poor discovery tests: an intent written to exercise
 * the engine tends to stay inside what the engine already does. Real designs do
 * not. They bring multi-unit opamps, project-local symbol libraries, hierarchies
 * eight sheets deep, and net counts in the hundreds.
 *
 * The input is `kicad-cli sch export netlist`, so KiCad flattens the hierarchy
 * and names every net before we see it (see test/support/netlist.ts for why
 * that beats reading the .kicad_sch).
 *
 * ## The contract
 *
 * Not "every board drafts". Most real boards legitimately will not: the engine
 * refuses multi-unit symbols by design, because a symbol's units share
 * symbol-space pin coordinates and drafting one would silently merge nets.
 *
 * The contract is the weaker, more important one: **draft faithfully or refuse
 * legibly, never silently wrong**. Concretely, for every project:
 *
 *   - drafting either succeeds or comes back with findings, never throws;
 *   - when it succeeds, the drawn netlist must partition pins exactly as the
 *     source did, no net lost, none gained;
 *   - when it refuses, every finding must carry an attributable detail.
 *
 * ## Opt-in, and why nothing is vendored
 *
 * Gated on `COPPERHEAD_TEST_CORPUS=1` and skipped when the corpus is absent.
 * The projects are not committed: the interesting ones carry licences that a
 * permissive repo cannot redistribute (the one board that currently round-trips
 * clean, stickhub, is CC BY-NC-SA). Reading them from a local KiCad install
 * redistributes nothing.
 *
 *   COPPERHEAD_TEST_CORPUS=1 npx vitest run test/draft-real-corpus.test.ts
 *
 * Point `COPPERHEAD_CORPUS_DIR` at any directory of KiCad projects to widen it.
 */

const CORPUS = process.env.COPPERHEAD_CORPUS_DIR ?? '/usr/share/kicad/demos';
const ENABLED = process.env.COPPERHEAD_TEST_CORPUS === '1' && existsSync(CORPUS);
const INSTALLED_SYMBOLS = ['/usr/share/kicad/symbols'];

/** The root sheet of a project: the one named after its .kicad_pro. */
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

/** Every directory under a project holding a .kicad_sym, so project-local libs resolve. */
async function projectSymbolDirs(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const here = ents.some((e) => e.isFile() && e.name.endsWith('.kicad_sym')) ? [dir] : [];
  const below = await Promise.all(
    ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => projectSymbolDirs(path.join(dir, e.name), depth + 1)),
  );
  return [...here, ...below.flat()];
}

/**
 * A netlist export sometimes records a part with no library, only a name.
 * Resolving it the way a person would (find the library that has that symbol)
 * keeps a corpus entry from failing on a gap in the export rather than on the
 * engine.
 */
async function fillEmptyLibs(nl: Netlist, dirs: string[]): Promise<void> {
  const seen = new Map<string, string | null>();
  for (const p of nl.parts) {
    if (!p.libId.startsWith(':')) continue;
    const bare = p.libId.slice(1);
    if (!seen.has(bare)) seen.set(bare, (await findSymbolAcrossLibraries(bare, dirs))[0]?.lib ?? null);
    const lib = seen.get(bare);
    if (lib) p.libId = `${lib}:${bare}`;
  }
}

async function exportNetlist(sch: string, out: string): Promise<Netlist> {
  await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', out, sch]);
  return parseNetlist(await readFile(out, 'utf8'));
}

interface Outcome {
  project: string;
  parts: number;
  nets: number;
  drafted: boolean;
  paper?: string;
  lost?: number;
  gained?: number;
  refusals?: Partial<Record<RefusalKind, number>>;
  firstDetail?: string;
}

/** Full round trip: project -> netlist -> IR -> drafted sheet -> netlist -> compare. */
async function roundTrip(dir: string, project: string): Promise<Outcome> {
  const sch = await rootSchOf(dir);
  if (!sch) throw new Error(`no root schematic in ${dir}`);
  const work = await mkdtemp(path.join(tmpdir(), 'copperhead-corpus-'));
  try {
    const source = await exportNetlist(sch, path.join(work, 'source.net'));
    // Extracted-from-the-sheets first: most corpus boards were drawn against
    // private libraries that only survive as the sheets' embedded lib_symbols.
    const extracted = await extractEmbeddedLibs(dir, path.join(work, 'extracted-libs'));
    const symbolDirs = [...extracted, ...(await projectSymbolDirs(dir)), ...INSTALLED_SYMBOLS];
    await fillEmptyLibs(source, symbolDirs);
    const intent = netlistToIntent(source);
    await writeFile(path.join(work, 'schematic.intent.json'), JSON.stringify(intent, null, 2), 'utf8');

    const res = await draftSchematicToText({
      repoRoot: work,
      schematic: 'board.kicad_sch',
      intentPath: 'schematic.intent.json',
      docsDir: null,
      symbolDirs,
    });

    const base = { project, parts: intent.parts.length, nets: intent.nets.length };
    if (!res.ok) {
      const refusals: Partial<Record<RefusalKind, number>> = {};
      for (const f of res.findings) {
        const k = classifyRefusal(f.detail);
        refusals[k] = (refusals[k] ?? 0) + 1;
      }
      return { ...base, drafted: false, refusals, firstDetail: res.findings[0]?.detail };
    }

    await mkdir(path.join(work, 'out'), { recursive: true });
    const outSch = path.join(work, 'out', 'board.kicad_sch');
    await writeFile(outSch, res.text, 'utf8');
    const back = await exportNetlist(outSch, path.join(work, 'back.net'));
    const before = netPartition(source);
    const after = netPartition(back);
    return {
      ...base,
      drafted: true,
      paper: res.report.paper,
      lost: [...before].filter((k) => !after.has(k)).length,
      gained: [...after].filter((k) => !before.has(k)).length,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Project directories that actually carry a root sheet, resolved before collection. */
async function corpusProjects(): Promise<string[]> {
  const ents = await readdir(CORPUS, { withFileTypes: true });
  const named = ents
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const withSheet = await Promise.all(named.map(async (n) => ((await rootSchOf(path.join(CORPUS, n))) ? n : null)));
  return withSheet.filter((n): n is string => n !== null);
}

const projects = ENABLED ? await corpusProjects() : [];

describe.skipIf(!ENABLED)('real designs: draft faithfully or refuse legibly', () => {
  const outcomes: Outcome[] = [];

  it.each(projects)(
    '%s: round-trips with connectivity intact, or refuses with attributable findings',
    async (project) => {
      const outcome = await roundTrip(path.join(CORPUS, project), project);
      outcomes.push(outcome);

      if (outcome.drafted) {
        // The load-bearing assertion. A drafted sheet whose pins group
        // differently from the source is a circuit the engine invented.
        expect({ project, lost: outcome.lost, gained: outcome.gained }).toEqual({
          project,
          lost: 0,
          gained: 0,
        });
      } else {
        // A refusal is a legitimate outcome; a silent or unattributable one is not.
        expect(outcome.refusals, `${project} refused with no findings`).toBeTruthy();
        expect(Object.values(outcome.refusals ?? {}).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
        expect(outcome.firstDetail ?? '').not.toBe('');
      }
    },
    180_000,
  );

  it('reports what the corpus covered', () => {
    const drafted = outcomes.filter((o) => o.drafted);
    const lines = outcomes.map((o) =>
      o.drafted
        ? `  ${o.project}: DRAFTED parts=${o.parts} nets=${o.nets} paper=${o.paper} lost=${o.lost} gained=${o.gained}`
        : `  ${o.project}: refused parts=${o.parts} nets=${o.nets} ${Object.entries(o.refusals ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`,
    );
    console.log(`real-design corpus (${CORPUS}):\n${lines.join('\n')}`);

    // Guard against the sweep quietly covering nothing: if every project in a
    // populated corpus refuses, the harness itself is more likely broken than
    // the engine is.
    expect(outcomes.length).toBeGreaterThan(0);
    expect(drafted.length, 'no project drafted; suspect the corpus harness, not the engine').toBeGreaterThan(0);
  });
});
