import { existsSync } from 'node:fs';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execa } from 'execa';
import { parseSexp, children, child, isList, type SexpNode } from './sexp.js';
import { resolveKicadCli, kicadLoadError } from './cli.js';
import { symbolSearchDirs, symbolFootprintHints } from './symlib.js';

/**
 * Board bootstrap for the layout-draft stage.
 *
 * The schematic stage ends with a drafted sheet and a board that is still the
 * scaffold's bare outline. The layout stage's contract is "a board with a
 * footprint on it plus the Draft quality note", but the agent cannot get a
 * footprint onto the board by itself: `write_file` refuses KiCad files, and a
 * footprint is a few hundred lines of pad geometry copied from a library the
 * model cannot see, so every attempt ended in a refusal ("the PCB is only an
 * outline stub"). This module is the deterministic step the schematic stage
 * already has in `draft_schematic`: read the schematic's netlist, resolve each
 * part to an installed footprint, place the footprints on a grid inside an
 * outline sized to fit, assign pad nets, and leave routing to the stage.
 * The agent then edits placements and writes LAYOUT.md instead of authoring
 * geometry.
 *
 * Footprint resolution, in order: the schematic's own Footprint field when it
 * names an installed footprint; the library symbol's default Footprint; a
 * small table of packages for the stock generic symbols; the first installed
 * footprint matching the symbol's `ki_fp_filters` whose pads cover every pin
 * the netlist uses. A part none of these resolve is reported and left off the
 * board, never guessed at.
 */

export interface PlacedFootprint {
  ref: string;
  value: string;
  /** `Lib:Name` of the footprint that went onto the board. */
  footprint: string;
  /** What the schematic asked for (its Footprint field), for the record. */
  requested: string;
  how: 'schematic' | 'symbol-default' | 'symbol-filter' | 'generic-default';
  x: number;
  y: number;
}

export interface UnplacedPart {
  ref: string;
  value: string;
  requested: string;
  reason: string;
}

export interface PopulateResult {
  placed: PlacedFootprint[];
  unplaced: UnplacedPart[];
  nets: number;
  /** Board outline in mm, for the log and LAYOUT.md. */
  outline: { width: number; height: number };
}

interface NetlistPart {
  ref: string;
  value: string;
  footprint: string;
  libId: string;
}

interface Netlist {
  parts: NetlistPart[];
  /** net name -> [ref, pin] */
  nets: Map<string, [string, string][]>;
}

const atom = (node: SexpNode[] | undefined, idx: number): string | undefined => {
  const v = node?.[idx];
  return typeof v === 'string' ? v : undefined;
};

/** Same discovery shape as symbol libraries: env override is exclusive. */
export async function footprintSearchDirs(env = process.env): Promise<string[]> {
  const fromEnv = [env.KICAD_FOOTPRINT_DIR, env.KICAD10_FOOTPRINT_DIR, env.KICAD9_FOOTPRINT_DIR, env.KICAD8_FOOTPRINT_DIR].filter(
    (v): v is string => !!v,
  );
  const defaults = [
    '/usr/share/kicad/footprints',
    '/usr/local/share/kicad/footprints',
    '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints',
  ];
  const out: string[] = [];
  for (const dir of fromEnv.length ? fromEnv : defaults) {
    try {
      await access(dir);
      if (!out.includes(dir)) out.push(dir);
    } catch {
      // not present; skip
    }
  }
  // Derive from the symbol dirs when nothing else is found (a Windows install:
  // .../share/kicad/symbols next to .../share/kicad/footprints).
  if (!out.length) {
    for (const symDir of await symbolSearchDirs(env)) {
      const fp = path.join(path.dirname(symDir), 'footprints');
      try {
        await access(fp);
        if (!out.includes(fp)) out.push(fp);
      } catch {
        // skip
      }
    }
  }
  return out;
}

/** `<dir>/<Lib>.pretty/<Name>.kicad_mod` in the first dir that has it. */
async function findFootprintFile(fpId: string, dirs: string[]): Promise<string | null> {
  const i = fpId.indexOf(':');
  if (i <= 0) return null;
  const lib = fpId.slice(0, i);
  const name = fpId.slice(i + 1);
  if (!lib || !name || /[\\/]|\.\./.test(lib) || /[\\/]|\.\./.test(name)) return null;
  for (const dir of dirs) {
    const p = path.join(dir, `${lib}.pretty`, `${name}.kicad_mod`);
    try {
      await access(p);
      return p;
    } catch {
      // next
    }
  }
  return null;
}

/** Every installed footprint id, cached per dir set for the filter search. */
const allFootprintsCache = new Map<string, Promise<string[]>>();
async function listInstalledFootprints(dirs: string[]): Promise<string[]> {
  const key = dirs.join('\0');
  let cached = allFootprintsCache.get(key);
  if (!cached) {
    cached = (async () => {
      const ids: string[] = [];
      for (const dir of dirs) {
        let libs: string[] = [];
        try {
          libs = (await readdir(dir)).filter((d) => d.endsWith('.pretty'));
        } catch {
          continue;
        }
        for (const lib of libs) {
          let files: string[] = [];
          try {
            files = await readdir(path.join(dir, lib));
          } catch {
            continue;
          }
          for (const f of files) {
            if (f.endsWith('.kicad_mod')) ids.push(`${lib.slice(0, -'.pretty'.length)}:${f.slice(0, -'.kicad_mod'.length)}`);
          }
        }
      }
      return ids;
    })();
    allFootprintsCache.set(key, cached);
  }
  return cached;
}

/** Test helper. */
export function resetFootprintCache(): void {
  allFootprintsCache.clear();
}

/** KiCad `ki_fp_filters` glob (`*` and `?`, case-insensitive) over the name or the `Lib:Name`. */
function filterToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/**
 * Packages for the stock generic symbols, which carry no default footprint and
 * (mostly) no filters. A first draft needs a package on the board more than it
 * needs the right one; the choice is recorded as `generic-default` so LAYOUT.md
 * and the stage can say so.
 */
const GENERIC_DEFAULTS: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/^Device:R(_Small)?(_US)?$/, 'Resistor_SMD:R_0603_1608Metric'],
  [/^Device:C(_Small)?(_Polarized)?$/, 'Capacitor_SMD:C_0603_1608Metric'],
  [/^Device:C_Polarized(_Small)?(_US)?$/, 'Capacitor_SMD:CP_Elec_4x5.4'],
  [/^Device:L(_Small)?$/, 'Inductor_SMD:L_0603_1608Metric'],
  [/^Device:LED(_Small)?$/, 'LED_SMD:LED_0603_1608Metric'],
  [/^Device:D(_Small)?(_Schottky)?(_Zener)?$/, 'Diode_SMD:D_SOD-123'],
  [/^Device:Crystal(_Small)?$/, 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm'],
  [/^Device:Crystal_GND24(_Small)?$/, 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm'],
  [/^Device:Fuse(_Small)?$/, 'Fuse:Fuse_1206_3216Metric'],
  [/^Device:Ferrite_Bead(_Small)?$/, 'Inductor_SMD:L_0603_1608Metric'],
  [/^Device:Q_(NPN|PNP)_/, 'Package_TO_SOT_SMD:SOT-23'],
  [/^Device:Q_(NMOS|PMOS)_/, 'Package_TO_SOT_SMD:SOT-23'],
  [/^Switch:SW_Push(_Dual)?$/, 'Button_Switch_SMD:SW_SPST_B3S-1000'],
  [/^Switch:SW_SPST$/, 'Button_Switch_SMD:SW_SPST_B3S-1000'],
  [/^Connector_Generic:Conn_01x(\d\d)$/, (m) => `Connector_PinHeader_2.54mm:PinHeader_1x${m[1]}_P2.54mm_Vertical`],
  [/^Connector_Generic:Conn_02x(\d\d)_Odd_Even$/, (m) => `Connector_PinHeader_2.54mm:PinHeader_2x${m[1]}_P2.54mm_Vertical`],
  [/^Connector:Conn_01x(\d\d)_Pin$/, (m) => `Connector_PinHeader_2.54mm:PinHeader_1x${m[1]}_P2.54mm_Vertical`],
  [/^Connector:TestPoint$/, 'TestPoint:TestPoint_Pad_1.0x1.0mm'],
  [/^Connector:USB_C_Receptacle_USB2\.0(_14P|_16P)?$/, 'Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12'],
  [/^Connector:USB_C_Receptacle_PowerOnly_6P$/, 'Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12'],
  [/^Connector:USB_C_Receptacle$/, 'Connector_USB:USB_C_Receptacle_GCT_USB4085'],
];

async function runKicadNetlist(schPath: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-netlist-'));
  const out = path.join(dir, 'board.net');
  try {
    const res = await execa(resolveKicadCli(), ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '--output', out, schPath], {
      reject: false,
    });
    if (res.failed || !existsSync(out)) {
      throw new Error(`kicad-cli could not export the netlist: ${(res.stderr || res.stdout || `exit ${res.exitCode}`).trim().slice(0, 300)}`);
    }
    return await readFile(out, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Parse the kicadsexpr netlist: real components (no power symbols) and nets. */
export function parseNetlist(text: string): Netlist {
  const root = parseSexp(text)[0];
  const parts: NetlistPart[] = [];
  const nets = new Map<string, [string, string][]>();
  if (root === undefined || !isList(root)) return { parts, nets };
  const comps = child(root, 'components');
  for (const comp of comps ? children(comps, 'comp') : []) {
    const ref = atom(child(comp, 'ref'), 1) ?? '';
    if (!ref || ref.startsWith('#')) continue;
    const src = child(comp, 'libsource');
    const lib = atom(src ? child(src, 'lib') : undefined, 1) ?? '';
    const part = atom(src ? child(src, 'part') : undefined, 1) ?? '';
    parts.push({
      ref,
      value: atom(child(comp, 'value'), 1) ?? '',
      footprint: atom(child(comp, 'footprint'), 1) ?? '',
      libId: lib && part ? `${lib}:${part}` : part,
    });
  }
  const netsNode = child(root, 'nets');
  for (const net of netsNode ? children(netsNode, 'net') : []) {
    const name = atom(child(net, 'name'), 1) ?? '';
    if (!name) continue;
    const nodes: [string, string][] = [];
    for (const node of children(net, 'node')) {
      const ref = atom(child(node, 'ref'), 1);
      const pin = atom(child(node, 'pin'), 1);
      if (ref && pin && !ref.startsWith('#')) nodes.push([ref, pin]);
    }
    if (nodes.length) nets.set(name, nodes);
  }
  return { parts, nets };
}

interface FootprintGeom {
  /** Pad numbers present (deduplicated). */
  pads: Set<string>;
  /** Courtyard (or pad) bounding box relative to the footprint origin, mm. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function footprintGeometry(root: SexpNode[]): FootprintGeom {
  const pads = new Set<string>();
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let sawCourtyard = false;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const onCourtyard = (n: SexpNode[]) => atom(child(n, 'layer'), 1) === 'F.CrtYd' || atom(child(n, 'layer'), 1) === 'B.CrtYd';
  for (const kind of ['fp_line', 'fp_rect', 'fp_circle', 'fp_poly', 'fp_arc']) {
    for (const g of children(root, kind)) {
      if (!onCourtyard(g)) continue;
      sawCourtyard = true;
      for (const key of ['start', 'end', 'center', 'mid']) {
        const p = child(g, key);
        const x = Number(atom(p, 1)),
          y = Number(atom(p, 2));
        if (p && Number.isFinite(x) && Number.isFinite(y)) grow(x, y);
      }
      const pts = child(g, 'pts');
      for (const xy of pts ? children(pts, 'xy') : []) {
        const x = Number(atom(xy, 1)),
          y = Number(atom(xy, 2));
        if (Number.isFinite(x) && Number.isFinite(y)) grow(x, y);
      }
      if (kind === 'fp_circle') {
        // circle: centre + radius from end
        const c = child(g, 'center'),
          e = child(g, 'end');
        const cx = Number(atom(c, 1)),
          cy = Number(atom(c, 2)),
          ex = Number(atom(e, 1)),
          ey = Number(atom(e, 2));
        if ([cx, cy, ex, ey].every(Number.isFinite)) {
          const r = Math.hypot(ex - cx, ey - cy);
          grow(cx - r, cy - r);
          grow(cx + r, cy + r);
        }
      }
    }
  }
  // pads always, so a footprint without a courtyard still has a box
  let pMinX = Infinity,
    pMinY = Infinity,
    pMaxX = -Infinity,
    pMaxY = -Infinity;
  for (const pad of children(root, 'pad')) {
    const num = atom(pad, 1) ?? '';
    if (num) pads.add(num);
    const at = child(pad, 'at'),
      size = child(pad, 'size');
    const x = Number(atom(at, 1)),
      y = Number(atom(at, 2));
    const w = Number(atom(size, 1)),
      h = Number(atom(size, 2));
    if (![x, y, w, h].every(Number.isFinite)) continue;
    const half = Math.max(w, h) / 2; // rotation-agnostic
    pMinX = Math.min(pMinX, x - half);
    pMinY = Math.min(pMinY, y - half);
    pMaxX = Math.max(pMaxX, x + half);
    pMaxY = Math.max(pMaxY, y + half);
  }
  if (!sawCourtyard || !Number.isFinite(minX)) {
    minX = pMinX;
    minY = pMinY;
    maxX = pMaxX;
    maxY = pMaxY;
  }
  if (!Number.isFinite(minX)) {
    minX = -1;
    minY = -1;
    maxX = 1;
    maxY = 1;
  }
  return { pads, minX, minY, maxX, maxY };
}

function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const num = (n: number): string => {
  const s = n.toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

/**
 * Turn a library footprint's source into a board footprint: the library header
 * tokens go, the lib nickname joins the name, reference/value are set, the
 * placement and a stable uuid are added, and each pad gets its net. Text
 * surgery on the library source (the repo never serializes s-expressions).
 */
export function instantiateFootprint(
  libText: string,
  fpId: string,
  ref: string,
  value: string,
  at: { x: number; y: number },
  padNets: Map<string, { code: number; name: string }>,
  seed: string,
): string {
  let text = libText.trim();
  text = text.replace(/^\(footprint\s+"[^"]*"/, `(footprint "${fpId}"`);
  text = text.replace(/^\(footprint\s+([^\s()"]+)/, `(footprint "${fpId}"`);
  // library-only header tokens, each on its own line in KiCad's output
  text = text.replace(/^\s*\((version|generator|generator_version|tedit)\s[^()\n]*\)\s*$\n?/gm, '');
  // placement and identity right after the opening line
  text = text.replace(/^(\(footprint\s+"[^"]*"[^\n]*\n)/, `$1\t(uuid "${uuidFrom(seed)}")\n\t(at ${num(at.x)} ${num(at.y)})\n`);
  // reference and value: the first Reference/Value properties are the footprint's own
  let refDone = false,
    valDone = false;
  text = text.replace(/\(property\s+"Reference"\s+"[^"]*"/, (m) => {
    if (refDone) return m;
    refDone = true;
    return `(property "Reference" "${ref.replace(/"/g, '')}"`;
  });
  text = text.replace(/\(property\s+"Value"\s+"[^"]*"/, (m) => {
    if (valDone) return m;
    valDone = true;
    return `(property "Value" "${value.replace(/"/g, '\\"')}"`;
  });
  // pad nets: `(pad "N" type shape` → `(pad "N" type shape (net code "name")`
  text = text.replace(/\(pad\s+"([^"]*)"\s+(\S+)\s+(\S+)/g, (m, padNum: string) => {
    const net = padNets.get(padNum);
    if (!net) return m;
    return `${m}\n\t\t(net ${net.code} "${net.name.replace(/"/g, '\\"')}")`;
  });
  // indent to the board's footprint level
  return text
    .split('\n')
    .map((l) => (l.length ? `\t${l}` : l))
    .join('\n');
}

interface Resolved {
  fpId: string;
  file: string;
  how: PlacedFootprint['how'];
  geom: FootprintGeom;
}

async function readGeom(file: string): Promise<FootprintGeom | null> {
  const root = parseSexp(await readFile(file, 'utf8'))[0];
  if (root === undefined || !isList(root)) return null;
  return footprintGeometry(root);
}

export async function resolveFootprint(
  part: NetlistPart,
  usedPins: Set<string>,
  fpDirs: string[],
  symDirs: string[],
): Promise<Resolved | { reason: string }> {
  const covers = (g: FootprintGeom) => [...usedPins].every((p) => g.pads.has(p));
  const tryId = async (fpId: string, how: PlacedFootprint['how']): Promise<Resolved | null> => {
    const file = await findFootprintFile(fpId, fpDirs);
    if (!file) return null;
    const geom = await readGeom(file);
    if (!geom) return null;
    return { fpId, file, how, geom };
  };
  // 1. the schematic's own field
  if (part.footprint) {
    const r = await tryId(part.footprint, 'schematic');
    if (r) return r; // the designer's choice stands even when pads and pins disagree
  }
  // 2. the library symbol's default package
  const hints = part.libId ? await symbolFootprintHints(part.libId, symDirs) : { footprint: null, filters: [] };
  if (hints.footprint) {
    const r = await tryId(hints.footprint, 'symbol-default');
    if (r) return r;
  }
  // 3. the generic table, ahead of the filters: a filter like `LED*` matches a
  // hundred packages and the shortest name is a through-hole 3 mm LED, while
  // the table names the 0603 a first draft wants
  for (const [re, pick] of GENERIC_DEFAULTS) {
    const m = part.libId.match(re);
    if (!m) continue;
    const id = typeof pick === 'string' ? pick : pick(m);
    const r = await tryId(id, 'generic-default');
    if (r) return r;
  }
  // 4. the symbol's footprint filters
  if (hints.filters.length) {
    const all = await listInstalledFootprints(fpDirs);
    const res = hints.filters.map(filterToRegex);
    const candidates = all
      .filter((id) => {
        const name = id.slice(id.indexOf(':') + 1);
        return res.some((re) => re.test(name) || re.test(id));
      })
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
    let fallback: Resolved | null = null;
    for (const id of candidates.slice(0, 60)) {
      const r = await tryId(id, 'symbol-filter');
      if (!r) continue;
      if (covers(r.geom)) return r;
      fallback ??= r;
    }
    if (fallback) return fallback;
  }
  return {
    reason: part.footprint
      ? `footprint "${part.footprint}" is not installed and the symbol ${part.libId || '(unknown)'} suggests none`
      : `no Footprint field and the symbol ${part.libId || '(unknown)'} suggests none`,
  };
}

/** Shelf-pack boxes left to right, rows top to bottom; returns origins. */
export function shelfPack(
  boxes: { w: number; h: number }[],
  gap: number,
): { x: number; y: number }[] {
  const totalArea = boxes.reduce((a, b) => a + (b.w + gap) * (b.h + gap), 0);
  const widest = boxes.reduce((a, b) => Math.max(a, b.w + gap), 0);
  const rowWidth = Math.max(widest, Math.sqrt(totalArea) * 1.25);
  const out: { x: number; y: number }[] = [];
  let x = 0,
    y = 0,
    rowH = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w + gap > rowWidth) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    out.push({ x, y });
    x += b.w + gap;
    rowH = Math.max(rowH, b.h + gap);
  }
  return out;
}

/**
 * Populate the board in `boardPath` from the schematic in `schPath`. The board
 * is expected to hold no footprints (the scaffold); the caller checks. Returns
 * what was placed and what could not be.
 */
export async function populateBoard(
  repoRoot: string,
  schematic: string,
  board: string,
  env = process.env,
): Promise<PopulateResult> {
  const schPath = path.join(repoRoot, schematic);
  const boardPath = path.join(repoRoot, board);
  const netlist = parseNetlist(await runKicadNetlist(schPath));
  const fpDirs = await footprintSearchDirs(env);
  const symDirs = await symbolSearchDirs(env);
  if (!fpDirs.length) throw new Error('no installed KiCad footprint libraries found (set KICAD_FOOTPRINT_DIR)');

  // pins each part uses, and the net per (ref, pin)
  const usedPins = new Map<string, Set<string>>();
  const netOf = new Map<string, { code: number; name: string }>(); // "ref\0pin"
  let code = 0;
  const netNames = [...netlist.nets.keys()].sort((a, b) => a.localeCompare(b));
  const netCodes = new Map<string, number>();
  for (const name of netNames) {
    code += 1;
    netCodes.set(name, code);
    for (const [ref, pin] of netlist.nets.get(name) ?? []) {
      if (!usedPins.has(ref)) usedPins.set(ref, new Set());
      usedPins.get(ref)!.add(pin);
      netOf.set(`${ref}\0${pin}`, { code, name });
    }
  }

  const resolved: { part: NetlistPart; r: Resolved }[] = [];
  const unplaced: UnplacedPart[] = [];
  for (const part of netlist.parts) {
    const r = await resolveFootprint(part, usedPins.get(part.ref) ?? new Set(), fpDirs, symDirs);
    if ('reason' in r) unplaced.push({ ref: part.ref, value: part.value, requested: part.footprint, reason: r.reason });
    else resolved.push({ part, r });
  }

  // biggest first, so the pack is stable and the module anchors the board
  resolved.sort((a, b) => {
    const area = (g: FootprintGeom) => (g.maxX - g.minX) * (g.maxY - g.minY);
    return area(b.r.geom) - area(a.r.geom) || a.part.ref.localeCompare(b.part.ref, undefined, { numeric: true });
  });
  const GAP = 1.5; // mm between courtyards; DRC only needs them not to overlap
  const MARGIN = 2; // mm from the outline
  const ORIGIN = { x: 100, y: 100 }; // where the scaffold drew its outline
  const boxes = resolved.map(({ r }) => ({ w: r.geom.maxX - r.geom.minX, h: r.geom.maxY - r.geom.minY }));
  const origins = shelfPack(boxes, GAP);
  let maxX = 0,
    maxY = 0;
  const placed: PlacedFootprint[] = [];
  const chunks: string[] = [];
  for (const [i, { part, r }] of resolved.entries()) {
    const o = origins[i]!;
    const b = boxes[i]!;
    // the footprint origin sits so its box's top-left lands on the shelf slot
    const x = ORIGIN.x + MARGIN + o.x - r.geom.minX;
    const y = ORIGIN.y + MARGIN + o.y - r.geom.minY;
    maxX = Math.max(maxX, o.x + b.w);
    maxY = Math.max(maxY, o.y + b.h);
    const padNets = new Map<string, { code: number; name: string }>();
    for (const pin of r.geom.pads) {
      const n = netOf.get(`${part.ref}\0${pin}`);
      if (n) padNets.set(pin, n);
    }
    chunks.push(
      instantiateFootprint(await readFile(r.file, 'utf8'), r.fpId, part.ref, part.value, { x, y }, padNets, `${part.ref}:${r.fpId}:${board}`),
    );
    placed.push({ ref: part.ref, value: part.value, footprint: r.fpId, requested: part.footprint, how: r.how, x, y });
  }
  const width = Math.max(10, Math.ceil(maxX + 2 * MARGIN));
  const height = Math.max(10, Math.ceil(maxY + 2 * MARGIN));

  let text = await readFile(boardPath, 'utf8');
  if (text.includes('(footprint ')) throw new Error(`${board} already has footprints; not touching it`);
  // nets after net 0
  const netLines = netNames.map((n) => `\t(net ${netCodes.get(n)} "${n.replace(/"/g, '\\"')}")`).join('\n');
  if (/^\t\(net 0 ""\)\s*$/m.test(text)) {
    text = text.replace(/^\t\(net 0 ""\)\s*$/m, (m) => (netLines ? `${m}\n${netLines}` : m));
  } else {
    text = text.replace(/\n\)\s*$/, `\n\t(net 0 "")\n${netLines}\n)\n`);
  }
  // outline: replace the scaffold's Edge.Cuts rect, or add one
  const rect = `(gr_rect (start ${num(ORIGIN.x)} ${num(ORIGIN.y)}) (end ${num(ORIGIN.x + width)} ${num(ORIGIN.y + height)})\n\t\t(stroke (width 0.1) (type default))\n\t\t(layer "Edge.Cuts")\n\t\t(uuid "${uuidFrom(`outline:${board}`)}")\n\t)`;
  const rectRe = /\(gr_rect \(start [^)]*\) \(end [^)]*\)\s*\(stroke \(width [^)]*\) \(type [^)]*\)\)\s*\(layer "Edge\.Cuts"\)\s*\(uuid "[^"]*"\)\s*\)/;
  if (rectRe.test(text)) text = text.replace(rectRe, rect);
  else text = text.replace(/\n\)\s*$/, `\n\t${rect}\n)\n`);
  // footprints before the closing paren
  text = text.replace(/\n\)\s*$/, `\n${chunks.join('\n')}\n)\n`);
  await writeFile(boardPath, text, 'utf8');

  const loadErr = await kicadLoadError(boardPath);
  if (loadErr) throw new Error(`the populated board does not load in KiCad: ${loadErr}`);
  return { placed, unplaced, nets: netNames.length, outline: { width, height } };
}

/** True when the board file holds at least one footprint. */
export async function boardHasFootprints(boardPath: string): Promise<boolean> {
  if (!existsSync(boardPath)) return false;
  return (await readFile(boardPath, 'utf8')).includes('(footprint ');
}

/**
 * The LAYOUT.md opener for a bootstrapped board: what is on it, how each
 * package was chosen, and what the stage owes. Written only when the doc does
 * not exist; never adds the "## Draft quality" marker, which is the stage's
 * own contract to meet.
 */
export function layoutDocSeed(result: PopulateResult, board: string): string {
  const rows = result.placed.map(
    (p) => `| ${p.ref} | ${p.value} | ${p.footprint} | ${p.how === 'schematic' ? 'schematic Footprint field' : p.how === 'symbol-default' ? `symbol default (schematic said "${p.requested || ''}")` : p.how === 'symbol-filter' ? `first installed match for the symbol's footprint filters (schematic said "${p.requested || ''}")` : `generic default package (schematic said "${p.requested || ''}")`} |`,
  );
  const missing = result.unplaced.map((u) => `- ${u.ref} (${u.value}): ${u.reason}`);
  return [
    '# Layout',
    '',
    `copperhead placed every schematic part onto \`${board}\` on a grid (${result.outline.width} x ${result.outline.height} mm outline, all on F.Cu, nothing routed) so the layout stage edits placements rather than authoring footprints. Coordinates are a starting point, not a design.`,
    '',
    '## Footprints',
    '',
    '| Refdes | Value | Footprint on the board | How chosen |',
    '|---|---|---|---|',
    ...rows,
    ...(missing.length ? ['', '### Not placed', '', ...missing] : []),
    '',
  ].join('\n');
}
