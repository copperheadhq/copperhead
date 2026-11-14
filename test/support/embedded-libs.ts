/**
 * Materializing the symbol libraries a real design embeds in its sheets.
 *
 * Most interesting corpus boards were drawn against private libraries
 * (`antmicroCapacitors0402`, …) that were never published as `.kicad_sym`
 * files; the projects ship without them, so every part refuses with
 * `symbol-unresolved`. But nothing is actually missing: since the v6 format,
 * every `.kicad_sch` embeds a verbatim copy of each symbol it places in its
 * `lib_symbols` section, under the full `"lib:Name"`. KiCad's GUI can export
 * those back out (File > Export > Symbols to New Library…) but kicad-cli
 * cannot, so this module does the same extraction textually: pull each
 * embedded block, rename it to the bare `Name` a library file uses (the unit
 * children are already bare in the embedded form), and write one
 * `<nickname>.kicad_sym` per library into `outDir`, which the caller prepends
 * to the engine's symbol search dirs.
 *
 * First definition wins when several sheets embed the same symbol: within one
 * project the copies are duplicates of the same source library entry, and a
 * sweep has no better tiebreak than a person opening the project would.
 *
 * Test-tree only, like the netlist reader beside it: the shipped CLI never
 * fabricates libraries, this exists so the drafting engine can be pointed at
 * real designs (draft-real-corpus.test.ts, scripts/draft-real-designs.ts).
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractSymbolBlock } from '../../src/kicad/draft/symsource.js';
import { EMIT_VERSION, renameSymbolBlock } from '../../src/kicad/emit.js';

/** Every sheet under a project, depth-limited like projectSymbolDirs. */
async function sheetsUnder(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const here = ents.filter((e) => e.isFile() && e.name.endsWith('.kicad_sch')).map((e) => path.join(dir, e.name));
  const below = await Promise.all(
    ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => sheetsUnder(path.join(dir, e.name), depth + 1)),
  );
  return [...here, ...below.flat()];
}

/**
 * Extract every embedded `lib_symbols` entry under `projectDir` into
 * `outDir/<nickname>.kicad_sym`. Returns `[outDir]` when anything was
 * written, `[]` otherwise, so the result splices into a search-dir list.
 */
export async function extractEmbeddedLibs(projectDir: string, outDir: string): Promise<string[]> {
  const byLib = new Map<string, Map<string, string>>();
  for (const sheet of await sheetsUnder(projectDir)) {
    const text = await readFile(sheet, 'utf8');
    // Quoted names after `(symbol` occur only inside lib_symbols (placed
    // instances carry `(lib_id …)` instead). Split on the FIRST colon,
    // matching resolve()'s parsing. A colonless name is a part whose
    // libsource recorded no library at all (cm5_minima's PUSB3F96X_1); it
    // goes into a synthetic nickname so fillEmptyLibs' exact cross-library
    // search can claim it, which outranks any fuzzy stock-library guess.
    for (const m of text.matchAll(/^\s*\(symbol\s+"([^"]+)"/gm)) {
      const libId = m[1]!;
      const cut = libId.indexOf(':');
      const lib = cut > 0 ? libId.slice(0, cut) : 'copperhead_embedded';
      const name = libId.slice(cut + 1);
      if (!name) continue;
      // A nickname findLibraryFile would refuse cannot resolve anyway.
      if (lib.includes('/') || lib.includes('\\') || lib.includes('..')) continue;
      if (/_\d+_\d+$/.test(name)) continue; // a unit child, not a placeable entry
      if (byLib.get(lib)?.has(name)) continue;
      const block = extractSymbolBlock(text, libId);
      if (!block) continue;
      if (!byLib.has(lib)) byLib.set(lib, new Map());
      byLib.get(lib)!.set(name, renameSymbolBlock(block, name));
    }
  }
  if (!byLib.size) return [];
  await mkdir(outDir, { recursive: true });
  for (const [lib, syms] of byLib) {
    await writeFile(
      path.join(outDir, `${lib}.kicad_sym`),
      `(kicad_symbol_lib\n\t(version ${EMIT_VERSION})\n\t(generator "copperhead-extract")\n${[...syms.values()].join('\n')}\n)\n`,
      'utf8',
    );
  }
  return [outDir];
}
