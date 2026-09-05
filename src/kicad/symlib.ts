/**
 * Cross-check the schematic's `lib_symbols` against the KiCad symbol libraries
 * installed on the machine (I9).
 *
 * The create pipeline currently has the model hand-author every `lib_symbols`
 * entry — pins, names, electrical types, geometry — under a `lib_id` that
 * *claims* to be a canonical KiCad part (`Device:R`, `Connector:USB_C_...`).
 * ERC only checks the net graph as drawn, so an entry whose pins silently
 * diverge from the real library part (wrong pin count, a missing shield/CC pin,
 * swapped numbers) passes every gate while being wrong. This module reads the
 * real `(symbol …)` out of the installed `.kicad_sym` and reports divergences so
 * the model — or a reviewer — can reconcile them.
 *
 * It is deliberately a *checker*, not an auto-replacer: KiCad renames symbols
 * across versions (e.g. `USB_C_Receptacle_USB2.0` became `…_14P`/`…_16P` in
 * KiCad 10), so blindly splicing by lib_id would fail on exactly the parts that
 * matter most. When the exact name is absent, we surface close candidates
 * instead of guessing.
 */

import { readFile, readdir, access, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseSexp, children, child, isList, type SexpNode } from './sexp.js';

/** Numeric-aware, case-insensitive pin-number ordering ("2" < "10", "a1" ~ "A1")
 * shared by every pin-table renderer so orderings never diverge. */
const pinNumberCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const comparePinNumbers = (a: string, b: string): number => pinNumberCollator.compare(a, b);

/**
 * Symbol-name index of a `.kicad_sym`, cached by mtime. The stock set is ~220
 * files that never change within a run, but discovery-heavy callers (the
 * dossier's per-part search, the recovery probe loop) would otherwise re-read
 * and re-scrape all of them per query. Returns null when the file is
 * unreadable, so callers skip it the same way a failed readFile did.
 */
const symbolNameCache = new Map<string, { mtimeMs: number; names: string[] }>();
async function libSymbolNames(file: string): Promise<string[] | null> {
  try {
    const { mtimeMs } = await stat(file);
    const hit = symbolNameCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.names;
    const text = await readFile(file, 'utf8');
    const names = [...text.matchAll(/^\s*\(symbol\s+"([^"]+)"/gm)].map((m) => m[1]!);
    symbolNameCache.set(file, { mtimeMs, names });
    return names;
  } catch {
    return null;
  }
}

const tag = (n: SexpNode): string | null => (isList(n) && typeof n[0] === 'string' ? n[0] : null);
const atomAt = (node: SexpNode[] | undefined, idx: number): string | undefined => {
  const v = node?.[idx];
  return typeof v === 'string' ? v : undefined;
};

// KiCad has two spellings for an unnamed pin: the legacy `~` sentinel and, in
// newer library format, an empty string. They are semantically identical, so
// normalize before comparing or the check floods with phantom `~` vs "" diffs.
const normPinName = (n: string): string => (n === '~' ? '' : n);

export interface LibPin {
  number: string;
  name: string;
  /** electrical type: passive | power_in | bidirectional | input | … */
  type: string;
}

/**
 * Candidate directories holding KiCad's stock `.kicad_sym` libraries, most
 * specific first. Env overrides win (KiCad exports these), then the standard
 * install locations for Linux/macOS/Windows. Only existing dirs are returned.
 *
 * @param winRoot test seam for the Windows `C:\Program Files\KiCad` root;
 *   defaults to the real path. Without this, the Windows version-directory
 *   discovery below can only be exercised on an actual Windows machine with
 *   KiCad installed at the default location.
 */
export async function symbolSearchDirs(env = process.env, winRoot = 'C:/Program Files/KiCad'): Promise<string[]> {
  const fromEnv = [
    env.KICAD_SYMBOL_DIR,
    env.KICAD10_SYMBOL_DIR,
    env.KICAD9_SYMBOL_DIR,
    env.KICAD8_SYMBOL_DIR,
  ].filter((v): v is string => !!v);
  const defaults = [
    '/usr/share/kicad/symbols',
    '/usr/local/share/kicad/symbols',
    '/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols',
    // Windows installs under a version-numbered directory
    // (C:\Program Files\KiCad\10.0\...), unlike Linux/macOS, so there is no
    // single fixed path here. Discovered below instead.
  ];
  const out: string[] = [];
  // An env override is exclusive: a caller pinning KICAD_SYMBOL_DIR at an
  // isolated directory (tests, a pinned library set) must get only that
  // directory back, not the machine's stock install appended after it.
  for (const dir of fromEnv.length ? fromEnv : defaults) {
    try {
      await access(dir);
      if (!out.includes(dir)) out.push(dir);
    } catch {
      // not present on this machine; skip
    }
  }
  // Windows: KiCad's own installer picks the version directory
  // (`10.0`, `9.0`, `8.0`, ...), so no fixed path is ever correct. List
  // `C:\Program Files\KiCad` and check each version folder instead. Sorted
  // descending so a machine with more than one version prefers the newest.
  // Skipped entirely when an env override is set: "env overrides win" means
  // exactly that, not "env overrides win, plus whatever else this discovers"
  // — a caller pointing KICAD_SYMBOL_DIR at an isolated directory (tests, a
  // pinned library set) must get only that directory back.
  const kicadRoot = winRoot;
  if (fromEnv.length === 0) {
    try {
      const entries = await readdir(kicadRoot, { withFileTypes: true });
      const versions = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
        const dir = `${kicadRoot}/${version}/share/kicad/symbols`;
        try {
          await access(dir);
          if (!out.includes(dir)) out.push(dir);
        } catch {
          // this version folder has no symbols dir; skip
        }
      }
      // Some installs put share/ directly under the KiCad root with no
      // version directory; probe that layout after the versioned ones.
      const flat = `${kicadRoot}/share/kicad/symbols`;
      try {
        await access(flat);
        if (!out.includes(flat)) out.push(flat);
      } catch {
        // no non-versioned layout either; skip
      }
    } catch {
      // C:\Program Files\KiCad doesn't exist on this machine (not Windows, or KiCad not installed here); skip
    }
  }
  return out;
}

/** Path to `<lib>.kicad_sym` in the first search dir that has it, or null.
 * The nickname is model-supplied text: a separator or `..` in it would escape
 * the search directories, so such a nickname resolves to nothing. */
export async function findLibraryFile(lib: string, dirs: string[]): Promise<string | null> {
  if (lib.includes('/') || lib.includes('\\') || lib.includes('..')) return null;
  for (const dir of dirs) {
    const p = path.join(dir, `${lib}.kicad_sym`);
    try {
      await access(p);
      return p;
    } catch {
      // try next dir
    }
  }
  return null;
}

/**
 * Rank a library's symbol names against a queried name that failed to resolve.
 * Comparison is case-insensitive with separators (`_`, `-`, `.`) stripped, so
 * `Rotary_Encoder` finds `RotaryEncoder_Switch` and `microSD_Card` finds
 * `Micro_SD_Card` — KiCad's own naming is inconsistent on exactly this axis.
 * Sub-unit children (`Name_<unit>_<style>`) are internal structure, not
 * placeable symbols, and never candidates. The name-inside-query direction
 * requires at least 3 significant characters: a stock library is full of
 * single-letter generics (`R`, `C`, `D`) that would otherwise "match" nearly
 * any part number and crowd out the real near-miss.
 */
const canonSymName = (s: string): string => s.toLowerCase().replace(/[_\-.]/g, '');

export interface RankedSymbolName {
  name: string;
  /** 0 = exact (separator-insensitive), 1 = prefix, 2 = substring,
   * 3 = name-inside-query, 4 = one-edit family variant. */
  rank: number;
}

/** Names must be this long before a single edit is distinctive enough to match. */
const MIN_EDIT_MATCH_LEN = 5;

/**
 * The shared one-edit rule for "same part family, variant spelling": within one
 * edit (SHT40 vs SHT4x, STM32F103C8T6 vs STM32F103C8Tx), except a
 * digit-for-digit substitution, which names a *different real part*
 * (TPS22860 vs TPS22810) rather than a family wildcard. Used by both resolvers
 * so search and cross-library discovery can never disagree about what counts
 * as a near-miss.
 */
function oneEditFamilyVariant(a: string, b: string): boolean {
  if (a.length < MIN_EDIT_MATCH_LEN || b.length < MIN_EDIT_MATCH_LEN) return false;
  if (editDistanceWithin(a, b, 1) > 1) return false;
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return !(/[0-9]/.test(a[i]!) && /[0-9]/.test(b[i]!));
      }
    }
  }
  return true;
}

/** `closestSymbolNames` with the match rank retained, so a caller merging
 * candidates from several libraries can order them by how well they match
 * rather than by which library happened to be scanned first. */
export function rankSymbolNames(
  names: Iterable<string>,
  query: string,
  cap = 8,
): RankedSymbolName[] {
  const canon = canonSymName;
  const q = canon(query);
  if (q.length < 2) return [];
  const ranked: RankedSymbolName[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name) || /_\d+_\d+$/.test(name)) continue;
    seen.add(name);
    const c = canon(name);
    let rank: number;
    if (c === q) rank = 0;
    else if (c.startsWith(q)) rank = 1;
    else if (c.includes(q)) rank = 2;
    else if (c.length >= 3 && q.includes(c)) rank = 3;
    // Without this tier, search declared family-variant stock symbols absent
    // (STM32F103C8T6 vs the installed STM32F103C8Tx) while
    // findSymbolAcrossLibraries found them, and the "machine-verified" dossier
    // rendered a search miss as a false absence claim.
    else if (oneEditFamilyVariant(q, c)) rank = 4;
    else continue;
    ranked.push({ name, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || (a.name < b.name ? -1 : 1));
  return ranked.slice(0, cap);
}

export function closestSymbolNames(names: Iterable<string>, query: string, cap = 8): string[] {
  return rankSymbolNames(names, query, cap).map((r) => r.name);
}

/** Every installed `<lib>.kicad_sym`, keyed by library nickname; the first
 * search dir claims a nickname, matching `findLibraryFile`'s precedence. */
export async function listInstalledLibraries(dirs: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith('.kicad_sym')) continue;
      const lib = e.slice(0, -'.kicad_sym'.length);
      if (!map.has(lib)) map.set(lib, path.join(dir, e));
    }
  }
  return map;
}

export interface CrossLibraryMatch {
  lib: string;
  /** The symbol name actually found (may differ from the query on a fuzzy hit,
   * e.g. `SHT4x` for a query of `SHT40`) — the suggested lib_id must be built
   * from this, never from the caller's original query, or a fuzzy suggestion
   * points at a lib_id that does not exist. */
  name: string;
  /** true when `name` matched exactly; false for a fuzzy hit. */
  exact: boolean;
}

/** Levenshtein edit distance, capped: returns `cap + 1` once the true distance
 * would exceed `cap`, so a caller doing a cheap "is this close enough" check
 * never pays for the full O(n·m) table on two names that are obviously
 * unrelated. */
function editDistanceWithin(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1; // whole row exceeded cap: no cell can recover
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * A part is unresolvable at its guessed `lib_id`, but the guess itself is often
 * right about the *part*, just wrong about which stock file it lives in (a
 * chip's library nickname is not derivable from its part number). Rather than
 * fail outright, check every other discovered `.kicad_sym` for a symbol with
 * this exact name; when none matches exactly, fall back to the same
 * closest-candidate substring heuristic `resolveLibrarySymbol` already uses
 * within one file, just applied across all of them.
 *
 * Returns matches sorted exact-first; the caller decides what "found" means
 * (one exact hit resolves unambiguously, several means the agent must pick).
 */
export async function findSymbolAcrossLibraries(
  name: string,
  dirs: string[],
  excludeLib?: string,
): Promise<CrossLibraryMatch[]> {
  const q = name.toLowerCase();
  const exact: CrossLibraryMatch[] = [];
  const fuzzy: CrossLibraryMatch[] = [];
  for (const [lib, file] of await listInstalledLibraries(dirs)) {
    // `excludeLib` is only known not to hold this *exact* name; it can still
    // hold the near-miss the caller actually wants (SHT40 guessed in
    // Sensor_Humidity, where the real symbol is SHT4x). Skip its exact check,
    // never its fuzzy one.
    const skipExact = lib === excludeLib;
    const names = await libSymbolNames(file);
    if (!names) continue;
    if (!skipExact && names.includes(name)) {
      exact.push({ lib, name, exact: true });
      continue;
    }
    // The "does the query contain the library name" direction is only
    // meaningful for a reasonably specific name (>= 3 chars): a stock library
    // is full of single-letter generics ("R", "C", "L", "D", "U", "Q"), and
    // "does <any part number> contain the letter R" is true for nearly
    // everything, which would fuzzy-match almost any query against them.
    const MIN_SHORT_NAME_LEN = 3;
    // Substring alone misses the most common real near-miss: a datasheet part
    // number against a library's family name, differing mid-string rather than
    // at either end (SHT40 vs SHT4x). Neither contains the other; the shared
    // one-edit family-variant rule catches it while refusing digit-for-digit
    // swaps (TPS22860 vs TPS22810 are different real parts).
    // The matched candidate string, not just whether one exists: a fuzzy hit
    // must report the real symbol name (`n`) so the caller can build a lib_id
    // that actually resolves. Suggesting `${lib}:${query}` back would name a
    // part that was never found in that library — the exact regression this
    // fuzzy path exists to avoid repeating.
    const fuzzyHit = names.find((n) => {
      const lower = n.toLowerCase();
      if (lower.includes(q)) return true;
      if (lower.length >= MIN_SHORT_NAME_LEN && q.includes(lower)) return true;
      return oneEditFamilyVariant(q, lower);
    });
    if (fuzzyHit) {
      fuzzy.push({ lib, name: fuzzyHit, exact: false });
    }
  }
  return [...exact, ...fuzzy];
}

/**
 * Search every installed library for symbols matching a part name, returning
 * ranked `Lib:Name` lib_ids with exact (separator-insensitive) matches first.
 * This is the discovery primitive a bare lib_id probe cannot provide: a wrong
 * library-nickname guess is otherwise indistinguishable from a missing part,
 * and KiCad's nicknames rarely follow from the part number (TPS61165DBV lives
 * in Driver_LED, AudioJack3 in Connector_Audio, INA226 in Sensor_Energy).
 */
export async function searchInstalledSymbols(
  query: string,
  dirs: string[],
  cap = 24,
): Promise<string[]> {
  if (canonSymName(query).length < 2) return [];
  // Rank globally, not per library: a library scanned early contributes only
  // weak matches, and capping in scan order would drop a later library's
  // stronger candidate — the exact case this tool exists to surface, since a
  // caller reaching for it has already guessed the nickname wrong.
  const hits: { libId: string; rank: number; name: string }[] = [];
  for (const [lib, file] of await listInstalledLibraries(dirs)) {
    const names = await libSymbolNames(file);
    if (!names) continue;
    for (const { name, rank } of rankSymbolNames(names, query, 4)) {
      hits.push({ libId: `${lib}:${name}`, rank, name });
    }
  }
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.name.length - b.name.length ||
      (a.libId < b.libId ? -1 : a.libId > b.libId ? 1 : 0),
  );
  return hits.slice(0, cap).map((h) => h.libId);
}

/** Collect pins (number, name, electrical type) from a `(symbol …)` node,
 * including its nested unit sub-symbols. Same walk `libPinDefs` uses, plus the
 * electrical-type atom that pin-position parsing does not need. */
export function pinsOfSymbolNode(sym: SexpNode[]): LibPin[] {
  const pins: LibPin[] = [];
  const walk = (n: SexpNode): void => {
    if (!isList(n)) return;
    if (tag(n) === 'pin') {
      const num = atomAt(child(n, 'number'), 1);
      if (num !== undefined) {
        pins.push({
          number: num,
          name: atomAt(child(n, 'name'), 1) ?? '~',
          type: typeof n[1] === 'string' ? n[1] : '?',
        });
      }
    }
    for (const c of n) walk(c);
  };
  walk(sym);
  return pins;
}

/** Highest unit index among a symbol's `Name_<unit>_<style>` children: 1 for a
 * single-unit part. Unit 0 holds common graphics, so it never raises the count.
 * The drafting engine refuses symbols with units >= 2 (they share symbol-space
 * pin coordinates), which makes this the drawability half of availability. */
function maxUnitIndex(sym: SexpNode[]): number {
  let max = 1;
  for (const c of children(sym, 'symbol')) {
    const m = atomAt(c, 1)?.match(/_(\d+)_\d+$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** The top-level `(symbol "name" …)` entries of a parsed `.kicad_sym` root. */
function librarySymbols(root: SexpNode[]): Map<string, SexpNode[]> {
  const map = new Map<string, SexpNode[]>();
  for (const sym of children(root, 'symbol')) {
    const name = atomAt(sym, 1);
    if (name) map.set(name, sym);
  }
  return map;
}

/**
 * Resolve a `lib_id` (e.g. `Device:R`) to the real library part's pins.
 * `extends` derived symbols inherit their base's pins, so we follow one such
 * link (loop-guarded). Returns the pins, or — when the exact symbol is absent —
 * the closest-named candidates so a caller can suggest the real name.
 */
export async function resolveLibrarySymbol(
  libId: string,
  dirs: string[],
): Promise<
  | { status: 'ok'; pins: LibPin[]; units: number }
  | { status: 'no-symbol'; candidates: string[] }
  | { status: 'no-library' }
  | { status: 'found-elsewhere'; libIds: string[] }
> {
  const [lib, name] = libId.includes(':') ? [libId.slice(0, libId.indexOf(':')), libId.slice(libId.indexOf(':') + 1)] : ['', libId];
  const file = await findLibraryFile(lib, dirs);
  if (!file) {
    const elsewhere = await findSymbolAcrossLibraries(name, dirs, lib);
    if (elsewhere.length) return { status: 'found-elsewhere', libIds: elsewhere.map((m) => `${m.lib}:${m.name}`) };
    return { status: 'no-library' };
  }
  const root = parseSexp(await readFile(file, 'utf8'))[0];
  if (root === undefined || !isList(root)) return { status: 'no-library' };
  const symbols = librarySymbols(root);

  let current = name;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const sym = symbols.get(current);
    if (!sym) break;
    const pins = pinsOfSymbolNode(sym);
    if (pins.length) return { status: 'ok', pins, units: maxUnitIndex(sym) };
    // no pins of its own → follow an `extends` base if present
    const base = atomAt(child(sym, 'extends'), 1);
    if (!base) return { status: 'ok', pins, units: maxUnitIndex(sym) }; // genuinely pinless (e.g. a graphic)
    current = base;
  }

  // The guessed library exists and simply lacks this name, so its own ranked
  // near-matches are the most useful answer and come first: the caller named
  // the right file and mistyped the part. Only when that file offers nothing
  // is a different library worth suggesting (mirrors SymbolSource.resolve).
  const candidates = closestSymbolNames(symbols.keys(), name);
  if (candidates.length) return { status: 'no-symbol', candidates };

  const elsewhere = await findSymbolAcrossLibraries(name, dirs, lib);
  if (elsewhere.length) return { status: 'found-elsewhere', libIds: elsewhere.map((m) => `${m.lib}:${m.name}`) };

  return { status: 'no-symbol', candidates };
}

export interface SymbolFinding {
  libId: string;
  kind: 'no-library' | 'no-symbol' | 'wrong-library' | 'pin-count' | 'pin-mismatch';
  detail: string;
}

/** A schematic lib_symbols entry: its lib_id and the pins as authored. */
function schematicLibSymbols(root: SexpNode[]): { libId: string; pins: LibPin[] }[] {
  const libs = child(root, 'lib_symbols');
  if (!libs) return [];
  return children(libs, 'symbol').map((sym) => ({
    libId: atomAt(sym, 1) ?? '',
    pins: pinsOfSymbolNode(sym),
  }));
}

/**
 * Compare every lib_symbols entry in a schematic against the installed library.
 * Returns one finding per divergence; an empty array means every resolvable
 * symbol matched. A part whose library is not installed is reported once (so
 * the model knows the check could not run for it) but never treated as a
 * mismatch — absence of the library is not evidence of wrong pins.
 */
export async function verifySchematicSymbols(
  schPath: string,
  env = process.env,
): Promise<{ findings: SymbolFinding[]; checked: number; skipped: number }> {
  const dirs = await symbolSearchDirs(env);
  const root = parseSexp(await readFile(schPath, 'utf8'))[0];
  const findings: SymbolFinding[] = [];
  if (root === undefined || !isList(root)) return { findings, checked: 0, skipped: 0 };

  let checked = 0;
  let skipped = 0;
  for (const entry of schematicLibSymbols(root)) {
    if (!entry.libId) continue;
    const resolved = await resolveLibrarySymbol(entry.libId, dirs);
    if (resolved.status === 'no-library') {
      skipped++;
      findings.push({
        libId: entry.libId,
        kind: 'no-library',
        detail: `library for "${entry.libId}" is not installed on this machine; cannot verify its pins`,
      });
      continue;
    }
    if (resolved.status === 'no-symbol') {
      findings.push({
        libId: entry.libId,
        kind: 'no-symbol',
        detail: resolved.candidates.length
          ? `"${entry.libId}" does not exist in the installed library — closest real symbols: ${resolved.candidates.join(', ')}. Use one of these lib_ids (KiCad renames symbols across versions).`
          : `"${entry.libId}" does not exist in the installed library and no close match was found; confirm the lib_id.`,
      });
      continue;
    }
    if (resolved.status === 'found-elsewhere') {
      // A distinct kind from 'no-library': the part IS verifiable, just filed
      // under another name — callers counting real issues must include it,
      // while 'no-library' stays "could not check". When every suggestion
      // shares the queried nickname the library was right and only the symbol
      // name is a variant; saying "wrong library" there contradicts the fix.
      const nick = entry.libId.includes(':') ? entry.libId.slice(0, entry.libId.indexOf(':')) : '';
      const sameLib = nick !== '' && resolved.libIds.every((id) => id.startsWith(`${nick}:`));
      findings.push({
        libId: entry.libId,
        kind: 'wrong-library',
        detail: sameLib
          ? `"${entry.libId}" does not exist in that library — closest real name: ${resolved.libIds.join(' or ')}. The library was right; use the real symbol name.`
          : `"${entry.libId}" names the wrong library, not the wrong part: use ${resolved.libIds.join(' or ')} instead.`,
      });
      continue;
    }
    checked++;
    const real = resolved.pins;
    const authored = entry.pins;
    const realByNum = new Map(real.map((p) => [p.number, p]));
    const authByNum = new Map(authored.map((p) => [p.number, p]));
    if (real.length !== authored.length) {
      findings.push({
        libId: entry.libId,
        kind: 'pin-count',
        detail: `pin count differs: schematic has ${authored.length} pin(s) [${[...authByNum.keys()].join(',')}], the real ${entry.libId} has ${real.length} [${[...realByNum.keys()].join(',')}]`,
      });
    }
    // per-pin name/type divergence on shared pin numbers
    for (const [num, rp] of realByNum) {
      const ap = authByNum.get(num);
      if (!ap) continue; // count mismatch already reported the gap
      if (normPinName(ap.name) !== normPinName(rp.name) || ap.type !== rp.type) {
        findings.push({
          libId: entry.libId,
          kind: 'pin-mismatch',
          detail: `pin ${num}: schematic has (name "${ap.name}", ${ap.type}), real part has (name "${rp.name}", ${rp.type})`,
        });
      }
    }
  }
  return { findings, checked, skipped };
}
