/**
 * Draft real KiCad projects and keep both drawings side by side for eyeballing.
 *
 * The sibling script `draft-reference-boards.sh` byte-compares, because there
 * the golden IS the engine's own pinned output. That cannot work here. A real
 * project's schematic was drawn by a person, and the engine places by its own
 * rules, so the two sheets never match byte for byte and a diff of them says
 * nothing. Comparing them is a job for eyes.
 *
 * What IS machine-checkable is the netlist: whichever way the two sheets are
 * drawn, they must join the same pins into the same nets. That check runs here
 * and is the same one `test/draft-real-corpus.test.ts` asserts.
 *
 * So each project leaves behind:
 *
 *   manual-tests/runs/real-designs/<project>/
 *     source.net                 netlist exported from the real project
 *     schematic.intent.json      the IR extracted from it
 *     extracted-libs/            libraries rebuilt from the sheets' lib_symbols
 *     drawn/board.kicad_sch      what the engine drafted
 *     back.net                   netlist exported back from the drafted sheet
 *     render/original-*.png      the human's drawing, one per sheet
 *     render/drawn.png           the engine's drawing
 *     REPORT.md                  outcome, net comparison, refusal reasons
 *
 * `manual-tests/runs/` is gitignored, so nothing here is redistributed. That
 * matters: several corpus projects carry licences a permissive repo cannot
 * vendor (stickhub is CC BY-NC-SA).
 *
 * Usage:
 *   npm run realdesigns                 every project in the corpus
 *   npm run realdesigns -- stickhub     just one
 *   COPPERHEAD_CORPUS_DIR=... npm run realdesigns
 *
 * Needs kicad-cli. PNG rendering additionally needs ImageMagick `convert` and
 * is best-effort: the schematic and netlists are written either way.
 *
 * Imports the extractor from test/support so the script and the test cannot
 * drift apart; both are dev-only tooling and neither ships in dist/.
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { draftSchematicToText } from '../src/kicad/draft/draft.js';
import { findSymbolAcrossLibraries } from '../src/kicad/symlib.js';
import { extractEmbeddedLibs } from '../test/support/embedded-libs.js';
import {
  classifyRefusal,
  netPartition,
  netlistToIntent,
  parseNetlist,
  type Netlist,
} from '../test/support/netlist.js';

const CORPUS = process.env.COPPERHEAD_CORPUS_DIR ?? '/usr/share/kicad/demos';
const INSTALLED_SYMBOLS = ['/usr/share/kicad/symbols'];
const OUT_ROOT = path.join('manual-tests', 'runs', 'real-designs');
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

async function projectSymbolDirs(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const here = ents.some((e) => e.isFile() && e.name.endsWith('.kicad_sym')) ? [dir] : [];
  const below = await Promise.all(
    ents
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => projectSymbolDirs(path.join(dir, e.name), depth + 1)),
  );
  return [...here, ...below.flat()];
}

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

/**
 * Render a sheet to PNG. KiCad's SVG carries an invisible searchable-text layer
 * that ImageMagick happily paints over the drawing, so it is stripped first —
 * the same dance draft-reference-boards.sh does.
 */
async function render(sch: string, outDir: string, prefix: string): Promise<string[]> {
  try {
    return await renderOrThrow(sch, outDir, prefix);
  } catch (e) {
    // Best-effort by contract: a sheet ImageMagick will not rasterize (some of
    // the bigger corpus boards defeat its default resource limits) must not
    // cost us the schematic and netlists, which are the point.
    console.warn(`  (render skipped for ${prefix}: ${(e as Error).message.split('\n')[0]})`);
    return [];
  }
}

async function renderOrThrow(sch: string, outDir: string, prefix: string): Promise<string[]> {
  if (!(await which('kicad-cli'))) return [];
  const svgDir = path.join(outDir, `${prefix}-svg`);
  await mkdir(svgDir, { recursive: true });
  await execa('kicad-cli', ['sch', 'export', 'svg', '--no-background-color', '-o', svgDir, sch]);
  const svgs = (await readdir(svgDir)).filter((f) => f.endsWith('.svg') && !f.endsWith('.clean.svg'));
  if (!(await which('convert'))) return [];
  const pngs: string[] = [];
  for (const svg of svgs) {
    const full = path.join(svgDir, svg);
    const clean = full.replace(/\.svg$/, '.clean.svg');
    await writeFile(clean, (await readFile(full, 'utf8')).replace(/<text[^>]*>[\s\S]*?<\/text>/g, ''), 'utf8');
    const png = path.join(outDir, svgs.length > 1 ? `${prefix}-${svg.replace(/\.svg$/, '')}.png` : `${prefix}.png`);
    await execa('convert', ['-density', '150', '-background', 'white', '-flatten', clean, png]);
    pngs.push(png);
  }
  await rm(svgDir, { recursive: true, force: true });
  return pngs;
}

async function which(bin: string): Promise<boolean> {
  try {
    await execa('which', [bin]);
    return true;
  } catch {
    return false;
  }
}

async function run(project: string): Promise<string> {
  const dir = path.join(CORPUS, project);
  const sch = await rootSchOf(dir);
  if (!sch) return `${project}: no root schematic`;
  const out = path.join(OUT_ROOT, project);
  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, 'drawn'), { recursive: true });
  await mkdir(path.join(out, 'render'), { recursive: true });

  const source = await exportNetlist(sch, path.join(out, 'source.net'));
  // Extracted-from-the-sheets first: it is byte-for-byte what the design
  // actually placed, so it outranks both loose project libs and the installed
  // stock set. Most corpus boards ship no .kicad_sym at all (their libraries
  // were private); without this every part refuses symbol-unresolved.
  const extracted = await extractEmbeddedLibs(dir, path.join(out, 'extracted-libs'));
  const symbolDirs = [...extracted, ...(await projectSymbolDirs(dir)), ...INSTALLED_SYMBOLS];
  await fillEmptyLibs(source, symbolDirs);
  const intent = netlistToIntent(source);
  await writeFile(path.join(out, 'schematic.intent.json'), JSON.stringify(intent, null, 2), 'utf8');

  const res = await draftSchematicToText({
    repoRoot: out,
    schematic: path.join('drawn', 'board.kicad_sch'),
    intentPath: 'schematic.intent.json',
    docsDir: null,
    symbolDirs,
  });

  const head = `# ${project}\n\nSource: \`${sch}\`\nParts: ${intent.parts.length}  Nets: ${intent.nets.length}\n`;
  const originals = await render(sch, path.join(out, 'render'), 'original');

  if (!res.ok) {
    const kinds = new Map<string, number>();
    for (const f of res.findings) {
      const k = classifyRefusal(f.detail);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    const why = [...kinds].map(([k, v]) => `${k}=${v}`).join(' ');
    await writeFile(
      path.join(out, 'REPORT.md'),
      `${head}\n## Refused\n\n${why}\n\n` +
        `The engine declined to draft this board. Nothing was drawn, so there is\n` +
        `only the original render to look at.\n\n### Findings\n\n` +
        res.findings.map((f, i) => `${i + 1}. ${f.detail}`).join('\n\n') +
        `\n\n### Original drawing\n\n${originals.map((p) => `- \`${p}\``).join('\n') || '- (not rendered)'}\n`,
      'utf8',
    );
    return `${project}: REFUSED  parts=${intent.parts.length} nets=${intent.nets.length}  ${why}`;
  }

  await writeFile(path.join(out, 'drawn', 'board.kicad_sch'), res.text, 'utf8');
  const back = await exportNetlist(path.join(out, 'drawn', 'board.kicad_sch'), path.join(out, 'back.net'));
  const before = netPartition(source);
  const after = netPartition(back);
  const lost = [...before].filter((k) => !after.has(k));
  const gained = [...after].filter((k) => !before.has(k));
  const drawn = await render(path.join(out, 'drawn', 'board.kicad_sch'), path.join(out, 'render'), 'drawn');

  await writeFile(
    path.join(out, 'REPORT.md'),
    `${head}\n## Drafted\n\nPaper: ${res.report.paper}  Wires: ${res.report.wireCount}  Labels: ${res.report.labelCount}\n\n` +
      `## Netlist comparison\n\n` +
      `Pin groups lost: **${lost.length}**  gained: **${gained.length}**\n\n` +
      (lost.length || gained.length
        ? `${lost.map((k) => `- lost: \`${k}\``).join('\n')}\n${gained.map((k) => `- gained: \`${k}\``).join('\n')}\n`
        : `The drafted sheet joins exactly the same pins as the source. The two\n` +
          `drawings differ in layout, which is expected and not a defect.\n`) +
      `\n## Side by side\n\nOriginal (drawn by a person):\n\n` +
      `${originals.map((p) => `- \`${p}\``).join('\n') || '- (not rendered)'}\n\n` +
      `Drawn by the engine:\n\n${drawn.map((p) => `- \`${p}\``).join('\n') || '- (not rendered)'}\n`,
    'utf8',
  );
  return (
    `${project}: DRAFTED  parts=${intent.parts.length} nets=${intent.nets.length} paper=${res.report.paper} ` +
    `lost=${lost.length} gained=${gained.length}`
  );
}

if (!existsSync(CORPUS)) {
  console.error(`no corpus at ${CORPUS}; set COPPERHEAD_CORPUS_DIR to a directory of KiCad projects`);
  process.exit(1);
}
const all = (await readdir(CORPUS, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
const projects = (only.length ? all.filter((p) => only.includes(p)) : all).sort();
if (!projects.length) {
  console.error(`no matching projects in ${CORPUS}`);
  process.exit(1);
}
const lines: string[] = [];
for (const p of projects) {
  try {
    const line = await run(p);
    console.log(line);
    lines.push(line);
  } catch (e) {
    const line = `${p}: ERROR ${(e as Error).message.split('\n')[0]}`;
    console.log(line);
    lines.push(line);
  }
}
await writeFile(path.join(OUT_ROOT, 'SUMMARY.md'), `# Real-design draft run\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`, 'utf8');
console.log(`\nwrote ${path.join(OUT_ROOT, 'SUMMARY.md')}`);
