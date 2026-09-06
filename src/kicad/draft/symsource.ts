import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseSexp, children, child, isList, type SexpNode, type Bounds } from '../sexp.js';
import { symbolSearchDirs, findLibraryFile, findSymbolAcrossLibraries, closestSymbolNames } from '../symlib.js';
import { EMIT_VERSION, renameSymbolBlock } from '../emit.js';

/**
 * Symbol resolution for the drafting engine, with hermetic vendoring (design
 * D4): on first use a symbol's `(symbol …)` source block is copied verbatim
 * from the installed `.kicad_sym` into a committed project cache, and every
 * later draft reads the vendored copy. A KiCad library upgrade therefore
 * cannot change drafted output until the cache is deliberately refreshed;
 * `verify_symbols` keeps comparing against the installed libraries, so genuine
 * library drift stays visible rather than silently frozen.
 */

export const SYM_CACHE_DIR = 'sym-lib-cache';

/**
 * How many `(extends …)` hops to follow before treating a library as malformed.
 * Real libraries chain at most one or two deep (a part variant extending a
 * generic); anything deeper is a cycle, and following it would blow the stack
 * mid-draft with no attributable message.
 */
const MAX_EXTENDS_DEPTH = 8;

const atomAt = (node: SexpNode[] | undefined, idx: number): string | undefined => {
  const v = node?.[idx];
  return typeof v === 'string' ? v : undefined;
};
const tag = (n: SexpNode): string | null => (isList(n) && typeof n[0] === 'string' ? n[0] : null);
const num = (n: SexpNode[] | undefined, idx: number, fb = 0): number => {
  const v = atomAt(n, idx);
  return v === undefined ? fb : parseFloat(v);
};

export interface DraftPin {
  number: string;
  name: string;
  /** electrical type: passive | power_in | power_out | input | output | … */
  etype: string;
  /** Connection point, symbol space. */
  x: number;
  y: number;
  /** Pin direction angle (deg): the pin line runs from (x,y) toward the body. */
  angle: number;
}

/** One placeable unit of a multi-unit symbol: its own pins and drawn body
 * (unit graphics merged with the symbol's common unit-0 graphics). */
export interface SymbolUnitView {
  unit: number;
  pins: DraftPin[];
  body: Bounds | null;
}

export interface ResolvedSymbol {
  libId: string;
  /** Verbatim `(symbol "Name" …)` block from the vendored source. */
  sourceText: string;
  pins: DraftPin[];
  /** Union of body graphic items, symbol space; null for graphics-free symbols. */
  body: Bounds | null;
  isPower: boolean;
  /** True when the library symbol defines more than one unit (an opamp, a
   * gate pack). Units share symbol-space pin coordinates, so a single placed
   * instance would overlay unrelated pins on one point; the engine places
   * each unit as its own instance instead, using `units` below. */
  multiUnit: boolean;
  /** Per-unit views (pins and body), present iff `multiUnit`. Only the
   * default body style (`_<unit>_0`/`_<unit>_1` children) contributes — a
   * de Morgan alternate (style ≥ 2) repeats the same pins at other
   * coordinates and would double them. Common (`_0_*`) pins are included in
   * EVERY unit's view, because KiCad draws them on every placed unit. */
  units?: SymbolUnitView[];
  /** Pin numbers defined in the COMMON unit (`_0_*` children) — the classic
   * home of a gate pack's power pins (an LM358's V+/V-). Each is drawn on
   * every placed unit, so the engine wires it at every instance; the shared
   * net makes the appearances electrically one point. */
  commonUnitPins?: string[];
}

/** Extract the top-level `(symbol "name" …)` block from library text, verbatim. */
export function extractSymbolBlock(libText: string, name: string): string | null {
  const needle = `(symbol "${name}"`;
  let idx = -1;
  // match only top-level entries: preceded by newline + whitespace, depth 1
  for (let from = 0; ; ) {
    idx = libText.indexOf(needle, from);
    if (idx === -1) return null;
    const lineStart = libText.lastIndexOf('\n', idx) + 1;
    if (libText.slice(lineStart, idx).trim() === '') break;
    from = idx + needle.length;
  }
  let depth = 0;
  let inString = false;
  for (let i = idx; i < libText.length; i++) {
    const c = libText[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return libText.slice(idx, i + 1);
    }
  }
  return null;
}

/** Highest unit number among a block's `Name_<unit>_<style>` children. */
function maxUnitOf(sym: SexpNode[]): number {
  let max = 0;
  for (const c of children(sym, 'symbol')) {
    const name = atomAt(c, 1);
    const m = name ? /_(\d+)_(\d+)$/.exec(name) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

const mergeBounds = (a: Bounds | null, b: Bounds | null): Bounds | null => {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
};

/**
 * Per-unit views of a multi-unit block. Each unit's pins and body come from
 * its own `_<unit>_<style>` children; the common `_0_*` graphics are merged
 * into every unit's body because KiCad draws them on every unit. Only body
 * styles 0 and 1 contribute — style ≥ 2 is the de Morgan alternate, which
 * repeats the same pins at other coordinates and would double them.
 */
function unitViewsOf(sym: SexpNode[]): { units: SymbolUnitView[]; commonUnitPins: string[] } {
  const byUnit = new Map<number, SexpNode[][]>();
  for (const c of children(sym, 'symbol')) {
    const name = atomAt(c, 1);
    const m = name ? /_(\d+)_(\d+)$/.exec(name) : null;
    if (!m || Number(m[2]) >= 2) continue;
    const u = Number(m[1]);
    byUnit.set(u, [...(byUnit.get(u) ?? []), c]);
  }
  const common = byUnit.get(0) ?? [];
  const commonPins = common.flatMap((c) => pinsOf(c));
  const commonUnitPins = commonPins.map((p) => p.number);
  const commonBody = common.reduce<Bounds | null>((b, c) => mergeBounds(b, bodyOf(c)), null);
  const units: SymbolUnitView[] = [...byUnit.keys()]
    .filter((u) => u >= 1)
    .sort((a, b) => a - b)
    .map((u) => ({
      unit: u,
      pins: [...byUnit.get(u)!.flatMap((n) => pinsOf(n)), ...commonPins],
      body: byUnit.get(u)!.reduce<Bounds | null>((b, n) => mergeBounds(b, bodyOf(n)), commonBody),
    }));
  return { units, commonUnitPins };
}

function parseSymbolNode(block: string): SexpNode[] {
  const node = parseSexp(block)[0];
  if (node === undefined || !isList(node)) throw new Error('unparseable symbol block');
  return node;
}

function pinsOf(sym: SexpNode[]): DraftPin[] {
  const pins: DraftPin[] = [];
  const walk = (n: SexpNode): void => {
    if (!isList(n)) return;
    if (tag(n) === 'pin') {
      const at = child(n, 'at');
      const numAtom = atomAt(child(n, 'number'), 1);
      if (at && numAtom !== undefined) {
        pins.push({
          number: numAtom,
          name: atomAt(child(n, 'name'), 1) ?? '~',
          etype: typeof n[1] === 'string' ? n[1] : 'passive',
          x: num(at, 1),
          y: num(at, 2),
          angle: num(at, 3),
        });
      }
    }
    for (const c of n) walk(c);
  };
  walk(sym);
  return pins;
}

function bodyOf(sym: SexpNode[]): Bounds | null {
  let b: Bounds | null = null;
  const extend = (x: number, y: number): void => {
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      b.minX = Math.min(b.minX, x);
      b.minY = Math.min(b.minY, y);
      b.maxX = Math.max(b.maxX, x);
      b.maxY = Math.max(b.maxY, y);
    }
  };
  const walk = (n: SexpNode): void => {
    if (!isList(n)) return;
    const t = tag(n);
    if (t === 'rectangle') {
      const s = child(n, 'start');
      const e = child(n, 'end');
      extend(num(s, 1), num(s, 2));
      extend(num(e, 1), num(e, 2));
    } else if (t === 'circle') {
      const c = child(n, 'center');
      const r = num(child(n, 'radius'), 1);
      extend(num(c, 1) - r, num(c, 2) - r);
      extend(num(c, 1) + r, num(c, 2) + r);
    } else if (t === 'arc') {
      for (const part of ['start', 'mid', 'end']) {
        const p = child(n, part);
        if (p) extend(num(p, 1), num(p, 2));
      }
    } else if (t === 'polyline') {
      for (const xy of children(child(n, 'pts') ?? [], 'xy')) extend(num(xy, 1), num(xy, 2));
    }
    if (t !== 'pin' && t !== 'text') for (const c of n) walk(c);
  };
  walk(sym);
  return b;
}

/** One vendored file per library nickname, so a project `sym-lib-table` can
 * point KiCad (and ERC's lib_symbol_issues check) at the vendored sources. */
const vendorFileName = (lib: string): string => `${lib.replace(/[^A-Za-z0-9_.+-]/g, '_')}.kicad_sym`;

const emptyVendorLib = (): string =>
  `(kicad_symbol_lib\n\t(version ${EMIT_VERSION})\n\t(generator "copperhead-vendor")\n)\n`;

/** Insert a symbol block before the wrapper's closing paren. */
function appendToVendorLib(libText: string, block: string): string {
  const end = libText.lastIndexOf(')');
  return libText.slice(0, end) + block + '\n' + libText.slice(end);
}

export class SymbolResolutionError extends Error {
  constructor(
    public readonly libId: string,
    public readonly reason: 'no-library' | 'no-symbol' | 'derived-unsupported' | 'found-elsewhere',
    public readonly candidates: string[] = [],
  ) {
    super(
      reason === 'no-library'
        ? `library for "${libId}" is not installed and not vendored`
        : reason === 'derived-unsupported'
          ? `"${libId}" extends a symbol that cannot be followed (missing base name, or a cycle deeper than ${MAX_EXTENDS_DEPTH} hops); use the base symbol directly`
          : reason === 'found-elsewhere'
            ? candidates.length && candidates.every((c) => c.startsWith(`${libId.includes(':') ? libId.slice(0, libId.indexOf(':')) : ''}:`))
              ? `"${libId}" does not exist in that library, closest real name: ${candidates.join(' or ')} — the library was right, use the real symbol name`
              : `"${libId}" is wrong about the library, not the part: use ${candidates.join(' or ')} instead`
            : `"${libId}" does not exist in the library${candidates.length ? ` — closest: ${candidates.join(', ')}` : ''}`,
    );
  }
}

/**
 * A part's library file is guessed wrong more often than the part itself is
 * misspelled (a chip's stock library nickname is not derivable from its part
 * number). The caller consults this only after the guessed file offered no
 * candidates of its own — same-library near-misses are stronger evidence and
 * come first. Across the other libraries, exact name hits are returned alone
 * when any exist; fuzzy matches are the fallback, reported under the symbol
 * name that actually matched. Returns corrected `lib_id`s or an empty array.
 */
async function crossLibrarySuggestions(name: string, lib: string, dirs: string[]): Promise<string[]> {
  const matches = await findSymbolAcrossLibraries(name, dirs, lib);
  const exact = matches.filter((m) => m.exact).map((m) => `${m.lib}:${m.name}`);
  if (exact.length) return exact;
  return matches.map((m) => `${m.lib}:${m.name}`);
}

export class SymbolSource {
  private cache = new Map<string, ResolvedSymbol>();

  /**
   * @param repoRoot project root; the vendored cache lives at `<root>/sym-lib-cache/`
   * @param searchDirs override for the installed-library search path (tests)
   * @param vendor when false, resolution never writes: symbols come from the
   *   vendored cache or the installed libraries verbatim, but nothing is copied
   *   into `sym-lib-cache/`. For read-shaped callers (`draftSchematicToText`, staleness
   *   probes) that must not mutate the working tree.
   */
  constructor(
    private readonly repoRoot: string,
    private readonly searchDirs?: string[],
    private readonly vendor: boolean = true,
  ) {}

  cacheDir(): string {
    return path.join(this.repoRoot, SYM_CACHE_DIR);
  }

  /** Library nicknames vendored (or generated) so far, for the sym-lib-table. */
  private readonly libs = new Set<string>();

  vendoredLibs(): string[] {
    return [...this.libs].sort();
  }

  /**
   * Write an engine-generated symbol block into the vendored cache (power lib).
   *
   * A generated block is the engine's, not a vendor's: when the engine's
   * drawing of a rail or ground changes, the cached copy must follow, or every
   * embedded power symbol on the sheet raises a lib_symbol_mismatch warning
   * against the stale library (the triangle-ground redraw hit 111 of them on
   * esp32-amp). A block already cached byte-for-byte is left alone.
   */
  async vendorGenerated(libId: string, block: string): Promise<void> {
    const lib = libId.slice(0, libId.indexOf(':'));
    const name = libId.slice(libId.indexOf(':') + 1);
    const file = path.join(this.cacheDir(), vendorFileName(lib));
    await mkdir(this.cacheDir(), { recursive: true });
    let text = existsSync(file) ? await readFile(file, 'utf8') : emptyVendorLib();
    const cached = extractSymbolBlock(text, name);
    if (cached !== block) {
      if (cached) text = text.replace(cached + '\n', '').replace(cached, '');
      await writeFile(file, appendToVendorLib(text, block), 'utf8');
    }
    this.libs.add(lib);
  }

  /**
   * A derived symbol (`(extends "Base")`) carries no geometry of its own: KiCad
   * stores the pins and body once on the base and lets the derived entry
   * override only properties (Value, Datasheet, description). Resolving one
   * means inheriting the base's geometry under the derived name.
   *
   * Returns null for a symbol that does not extend anything, so the caller
   * falls through to the ordinary path.
   *
   * `sourceText` is the BASE block verbatim. The emitter renames a vendored
   * block to its lib_id on the way into `lib_symbols`
   * (`emit.ts:renameSymbolBlock`), so the base geometry lands under the
   * derived name with no rewriting here. The rename covers the unit children
   * too (`Base_0_1` becomes `Derived_0_1`): KiCad's schematic loader requires
   * the child prefix to match the parent name, and a derived block wrapping
   * the base's children fails to load outright — found when the first
   * reference board with real derived symbols (AMS1117-3.3, ATmega328P-A)
   * refused to open.
   *
   * The derived entry's own property overrides are dropped. Nothing downstream
   * reads them — the engine sets Reference, Value and Footprint from the IR —
   * and keeping them would mean merging two property lists to no effect.
   */
  private async inherit(
    libId: string,
    lib: string,
    node: SexpNode[],
    depth: number,
  ): Promise<ResolvedSymbol | null> {
    const ext = child(node, 'extends');
    if (!ext) return null;
    const baseName = atomAt(ext, 1);
    if (!baseName) throw new SymbolResolutionError(libId, 'derived-unsupported');
    // A chain is legal (a derived symbol may extend another), a cycle is not —
    // and a malformed library that extends itself would otherwise recurse until
    // the stack gives out, mid-draft, with no attributable message.
    if (depth >= MAX_EXTENDS_DEPTH) throw new SymbolResolutionError(libId, 'derived-unsupported');
    const base = await this.resolve(`${lib}:${baseName}`, depth + 1);
    return {
      libId,
      sourceText: base.sourceText,
      pins: base.pins,
      body: base.body,
      isPower: base.isPower,
      multiUnit: base.multiUnit,
      units: base.units,
      commonUnitPins: base.commonUnitPins,
    };
  }

  /** Resolve a lib_id: vendored copy first, else installed library (then vendor it). */
  async resolve(libId: string, depth = 0): Promise<ResolvedSymbol> {
    const hit = this.cache.get(libId);
    if (hit) return hit;

    const lib = libId.includes(':') ? libId.slice(0, libId.indexOf(':')) : '';
    const name = libId.includes(':') ? libId.slice(libId.indexOf(':') + 1) : libId;
    const vendored = path.join(this.cacheDir(), vendorFileName(lib));
    let block: string | null = null;
    let fromInstalled = false;
    if (existsSync(vendored)) {
      block = extractSymbolBlock(await readFile(vendored, 'utf8'), name);
      if (block) this.libs.add(lib);
    }
    if (!block) {
      const dirs = this.searchDirs ?? (await symbolSearchDirs());
      const file = await findLibraryFile(lib, dirs);
      if (!file) {
        const elsewhere = await crossLibrarySuggestions(name, lib, dirs);
        if (elsewhere.length) throw new SymbolResolutionError(libId, 'found-elsewhere', elsewhere);
        throw new SymbolResolutionError(libId, 'no-library');
      }
      const libText = await readFile(file, 'utf8');
      block = extractSymbolBlock(libText, name);
      if (!block) {
        // The guessed library exists and simply lacks this name, so its own
        // near-matches are the most useful answer and come first: the caller
        // named the right file and mistyped the part. The scrape matches every
        // `(symbol …)` line including indented sub-unit children;
        // closestSymbolNames filters those out and ranks what remains, so all
        // 8 slots carry placeable symbols. Only when that file offers nothing
        // is a different library worth suggesting — and only an exact hit
        // there, since a cross-library *fuzzy* guess is weaker evidence than
        // "you were close, in the right file".
        const names = [...libText.matchAll(/^\s*\(symbol\s+"([^"]+)"/gm)].map((m) => m[1]!);
        const candidates = closestSymbolNames(names, name);
        if (candidates.length) throw new SymbolResolutionError(libId, 'no-symbol', candidates);
        const elsewhere = await crossLibrarySuggestions(name, lib, dirs);
        if (elsewhere.length) throw new SymbolResolutionError(libId, 'found-elsewhere', elsewhere);
        throw new SymbolResolutionError(libId, 'no-symbol', candidates);
      }
      fromInstalled = true;
      this.libs.add(lib);
    }

    const node = parseSymbolNode(block);
    const inherited = await this.inherit(libId, lib, node, depth);
    if (fromInstalled && this.vendor) {
      // Derived symbols vendor FLATTENED under their own name, never as the
      // library's `extends` stub. A vendored stub makes the project
      // sym-lib-table resolve the derived name to base-geometry-plus-derived-
      // properties while the sheet embeds base-geometry-plus-base-properties,
      // and ERC reports lib_symbol_mismatch on every derived part. The
      // flattened copy is byte-for-byte what the emitter embeds (modulo the
      // lib nickname), exactly like a non-derived vendored block.
      const vendorBlock = inherited ? renameSymbolBlock(inherited.sourceText, name) : block;
      await mkdir(this.cacheDir(), { recursive: true });
      const existing = existsSync(vendored) ? await readFile(vendored, 'utf8') : emptyVendorLib();
      if (!extractSymbolBlock(existing, name)) {
        await writeFile(vendored, appendToVendorLib(existing, vendorBlock), 'utf8');
      }
    }
    const multiUnit = maxUnitOf(node) >= 2;
    const resolved: ResolvedSymbol = inherited ?? {
      libId,
      sourceText: block,
      pins: pinsOf(node),
      body: bodyOf(node),
      isPower: child(node, 'power') !== undefined || libId.startsWith('power:'),
      multiUnit,
      ...(multiUnit ? unitViewsOf(node) : {}),
    };
    this.cache.set(libId, resolved);
    return resolved;
  }
}

/**
 * The symbol-name token a power-class net's generated symbol lives under
 * (`copperhead_power:<token>`), which is also what its vendored file is named
 * from. Two nets that sanitize to one token would share one `lib_id` and one
 * embedded pin name, quietly merging their rails in KiCad's netlist —
 * `validateIntent` refuses that pair using this same function, so the collision
 * dies as a numbered finding instead.
 */
export const powerNetToken = (net: string): string => net.replace(/[^A-Za-z0-9_+.-]/g, '_');

/** Escape a string for embedding inside a quoted s-expression atom. Defense in
 * depth: `validateIntent` already refuses net names containing `"` or `\`, but
 * this template must not be able to corrupt a schematic even if called raw. */
const sexpQuote = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Engine-authored power-port and PWR_FLAG symbols (design D6a). Authored here,
 * not copied from a library: the engine must be able to satisfy ERC's
 * undriven-rail check on any machine without depending on the installed power
 * library's naming. Pin at the origin; the body draws above (rail) or below
 * (ground) it.
 */
export function powerSymbolSource(rawNet: string, kind: 'rail' | 'ground'): { libId: string; sourceText: string } {
  const net = sexpQuote(rawNet);
  const name = powerNetToken(rawNet);
  const libId = `copperhead_power:${name}`;
  // Symbol space is Y-up and the schematic transform flips it: negative-Y
  // graphics here render BELOW the connection point on the sheet. A ground
  // hangs below its pin (angle 270 = line toward -Y body) as a stem and an
  // open triangle, the reference-ground glyph; a rail rises above (angle 90)
  // as a stem and a filled arrowhead, the way KiCad's own +3V3 draws. Both
  // reach 2.54 from the pin, inside the 2-unit box the engine reserves.
  const body =
    kind === 'ground'
      ? `\t(symbol "${name}_0_1"
\t\t(polyline (pts (xy 0 0) (xy 0 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
\t\t(polyline (pts (xy -1.27 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
\t)
\t(symbol "${name}_1_1"
\t\t(pin power_in line (at 0 0 270) (length 0) hide
\t\t\t(name "${net}" (effects (font (size 1.27 1.27))))
\t\t\t(number "1" (effects (font (size 1.27 1.27))))
\t\t)
\t)`
      : `\t(symbol "${name}_0_1"
\t\t(polyline (pts (xy 0 0) (xy 0 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
\t\t(polyline (pts (xy -0.762 1.27) (xy 0 2.54) (xy 0.762 1.27) (xy -0.762 1.27)) (stroke (width 0.254) (type default)) (fill (type outline)))
\t)
\t(symbol "${name}_1_1"
\t\t(pin power_in line (at 0 0 90) (length 0) hide
\t\t\t(name "${net}" (effects (font (size 1.27 1.27))))
\t\t\t(number "1" (effects (font (size 1.27 1.27))))
\t\t)
\t)`;
  const sourceText = `(symbol "${name}"
\t(power)
\t(pin_names (offset 0))
\t(exclude_from_sim yes)
\t(in_bom no)
\t(on_board no)
\t(property "Reference" "#PWR" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
\t(property "Value" "${net}" (at 0 ${kind === 'ground' ? '-3.556' : '3.556'} 0) (effects (font (size 1.27 1.27)) hide))
${body}
)`;
  return { libId, sourceText };
}

export function pwrFlagSource(): { libId: string; sourceText: string } {
  const libId = 'copperhead_power:PWR_FLAG';
  const sourceText = `(symbol "PWR_FLAG"
\t(power)
\t(pin_names (offset 0))
\t(exclude_from_sim yes)
\t(in_bom no)
\t(on_board no)
\t(property "Reference" "#FLG" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
\t(property "Value" "PWR_FLAG" (at 0 -3.556 0) (effects (font (size 1.27 1.27)) hide))
\t(symbol "PWR_FLAG_0_1"
\t\t(polyline (pts (xy 0 1.27) (xy -1.016 1.905) (xy 0 2.54) (xy 1.016 1.905) (xy 0 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
\t)
\t(symbol "PWR_FLAG_1_1"
\t\t(pin power_out line (at 0 0 90) (length 0) hide
\t\t\t(name "pwr" (effects (font (size 1.27 1.27))))
\t\t\t(number "1" (effects (font (size 1.27 1.27))))
\t\t)
\t)
)`;
  return { libId, sourceText };
}