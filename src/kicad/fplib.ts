/**
 * Footprint library resolution (issue #252): turn a schematic footprint lib_id
 * (`Resistor_SMD:R_0603_1608Metric`) into the pad geometry the board population
 * step needs, by reading the installed `.pretty/*.kicad_mod`. Mirrors the symbol
 * side (`symlib.ts`): read-only, never serializes, env overrides + stock install
 * locations.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { parseSexp, isList, children, child, type SexpNode } from './sexp.js';
import type { Extents } from './layout/types.js';

export interface FootprintPadDef {
  number: string;
  type: string;
  shape: string;
  /** Footprint-local pad centre (mm). */
  x: number;
  y: number;
  /** Rotation in degrees. */
  rot: number;
  width: number;
  height: number;
  layers: string[];
  /** Plated-through hole diameter (mm); absent for SMD pads. */
  drill?: number;
  /** Hole offset for slotted holes (`(drill d (offset x y))`); absent for round. */
  drillOffset?: { x: number; y: number };
}

export interface FootprintDef {
  libId: string;
  pads: FootprintPadDef[];
  /** Bounding box of F.CrtYd/B.CrtYd graphics (mm), or null when none drawn. */
  courtyard: Extents | null;
}

const atom = (n: SexpNode[] | undefined, i: number): string | undefined => {
  const v = n?.[i];
  return typeof v === 'string' ? v : undefined;
};

const num = (n: SexpNode[] | undefined, i: number): number | undefined => {
  const v = atom(n, i);
  if (v === undefined) return undefined;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : undefined;
};

/** A 2-D point read from an `(at|start|end|center|mid x y …)` node, or null. */
const pointAt = (n: SexpNode[] | undefined): { x: number; y: number } | null => {
  const x = num(n, 1);
  const y = num(n, 2);
  return x !== undefined && y !== undefined ? { x, y } : null;
};

/**
 * The circle through three non-collinear points (circumcenter + radius), or
 * null. Used to bound `fp_arc` courtyard segments: an arc's own endpoints only
 * reach two extremes, so the full circle is the safe (superset) bound.
 */
function circleThrough(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const x =
    ((a.x * a.x + a.y * a.y) * (b.y - c.y) +
      (b.x * b.x + b.y * b.y) * (c.y - a.y) +
      (c.x * c.x + c.y * c.y) * (a.y - b.y)) /
    d;
  const y =
    ((a.x * a.x + a.y * a.y) * (c.x - b.x) +
      (b.x * b.x + b.y * b.y) * (a.x - c.x) +
      (c.x * c.x + c.y * c.y) * (b.x - a.x)) /
    d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

/** Candidate directories holding `.pretty` footprint libraries. */
export function footprintSearchDirs(env = process.env, winRoot = 'C:/Program Files/KiCad'): string[] {
  const fromEnv = [
    env.KICAD_FOOTPRINT_DIR,
    env.KICAD10_FOOTPRINT_DIR,
    env.KICAD9_FOOTPRINT_DIR,
    env.KICAD8_FOOTPRINT_DIR,
  ].filter((v): v is string => !!v);
  const defaults = [
    '/usr/share/kicad/footprints',
    '/usr/local/share/kicad/footprints',
    '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints',
    path.join(winRoot, 'share', 'kicad', 'footprints'),
  ];
  return [...new Set([...fromEnv, ...defaults])].filter((d) => existsSync(d));
}

/** List the `.pretty` directories under a footprint search dir. */
export async function prettyDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root);
    return entries
      .filter((e) => e.endsWith('.pretty'))
      .map((e) => path.join(root, e));
  } catch {
    return [];
  }
}

/** Resolve a `Library:Footprint` lib_id to a `.kicad_mod` path, or null. */
export async function resolveFootprintPath(libId: string, env = process.env, projectDir?: string): Promise<string | null> {
  // A bare footprint name (no library nickname) is KiCad's legacy form for a
  // project-local footprint: match it against every library the project names.
  const colon = libId.indexOf(':');
  if (colon < 0) {
    if (!projectDir) return null;
    for (const dir of (await projectFootprintDirs(projectDir, env)).values()) {
      const candidate = path.join(dir, `${libId}.kicad_mod`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
  const lib = libId.slice(0, colon);
  const fp = libId.slice(colon + 1);
  // Real designs ship private footprint libraries beside the project and name
  // them in `fp-lib-table` (often `$(KIPRJMOD)/<lib>.pretty`). Search those
  // first — a project-local footprint must win over a same-named global one.
  if (projectDir) {
    const localDir = (await projectFootprintDirs(projectDir, env)).get(lib);
    if (localDir) {
      const candidate = path.join(localDir, `${fp}.kicad_mod`);
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const root of footprintSearchDirs(env)) {
    const candidate = path.join(root, `${lib}.pretty`, `${fp}.kicad_mod`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Footprint variables the project `fp-lib-table` may name (KiCad 6 through 10). */
const FOOTPRINT_DIR_VARS = [
  'KICAD10_FOOTPRINT_DIR',
  'KICAD9_FOOTPRINT_DIR',
  'KICAD8_FOOTPRINT_DIR',
  'KICAD7_FOOTPRINT_DIR',
  'KICAD6_FOOTPRINT_DIR',
  'KICAD_FOOTPRINT_DIR',
];

/** Library-nickname → absolute `.pretty` directory, read from the project `fp-lib-table`. */
async function projectFootprintDirs(projectDir: string, env = process.env): Promise<Map<string, string>> {
  const table = path.join(projectDir, 'fp-lib-table');
  const map = new Map<string, string>();
  if (!existsSync(table)) return map;
  let text: string;
  try {
    text = await readFile(table, 'utf8');
  } catch {
    return map;
  }
  const root = parseSexp(text).find(isList);
  if (!root) return map;
  const global = footprintSearchDirs(env)[0] ?? '/usr/share/kicad/footprints';
  const resolve = (uri: string): string => {
    let u = uri;
    u = u.split('$(KIPRJMOD)').join(projectDir).split('${KIPRJMOD}').join(projectDir);
    for (const v of FOOTPRINT_DIR_VARS) {
      u = u.split(`$(${v})`).join(global).split(`\${${v}}`).join(global);
    }
    return u;
  };
  for (const lib of children(root, 'lib')) {
    const name = atom(child(lib, 'name'), 1);
    const uri = atom(child(lib, 'uri'), 1);
    if (name && uri) map.set(name, resolve(uri));
  }
  return map;
}

/** Parse a `.kicad_mod` footprint into pads + courtyard extent. */
export function parseFootprint(text: string, libId: string): FootprintDef {
  const root = parseSexp(text).find(isList);
  const pads: FootprintPadDef[] = [];
  if (root) {
    for (const pad of children(root, 'pad')) {
      const number = atom(pad, 1) ?? '';
      const type = atom(pad, 2) ?? 'smd';
      const shape = atom(pad, 3) ?? 'circle';
      const at = child(pad, 'at');
      const size = child(pad, 'size');
      const layersList = child(pad, 'layers');
      const x = num(at, 1) ?? 0;
      const y = num(at, 2) ?? 0;
      const rot = num(at, 3) ?? 0;
      const width = num(size, 1) ?? 0;
      const height = num(size, 2) ?? width;
      const layers = layersList ? layersList.slice(1).filter((l): l is string => typeof l === 'string') : [];
      // Through-hole pads carry a `(drill d)` (round) or `(drill d (offset x y))`
      // (slotted) hole; SMD pads carry none. Missing here, a thru_hole pad would
      // emit a zero-size hole and fail DRC (`drill_out_of_range`, `padstack_invalid`).
      const drillNode = child(pad, 'drill');
      const drill = num(drillNode, 1);
      const offsetNode = drillNode ? child(drillNode, 'offset') : undefined;
      pads.push({
        number,
        type,
        shape,
        x,
        y,
        rot,
        width,
        height,
        layers,
        ...(drill !== undefined ? { drill } : {}),
        ...(offsetNode ? { drillOffset: { x: num(offsetNode, 1) ?? 0, y: num(offsetNode, 2) ?? 0 } } : {}),
      });
    }
  }

  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x: number, y: number): void => {
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  };
  if (root) {
    // KiCad 8 and earlier draw the courtyard with four `fp_line`s; KiCad 9/10
    // regenerated libraries use the newer `fp_rect`/`fp_circle`/`fp_poly`/
    // `fp_arc` primitives. The layer name is written either as a quoted string
    // (`(layer "F.CrtYd")`) or a bare atom (`(layer F.CrtYd)`), so read it
    // through `atom` rather than comparing the raw token.
    const isCourtyard = (n: SexpNode[]): boolean => {
      const layerName = atom(child(n, 'layer'), 1);
      return layerName === 'F.CrtYd' || layerName === 'B.CrtYd';
    };
    for (const line of children(root, 'fp_line')) {
      if (!isCourtyard(line)) continue;
      const s = pointAt(child(line, 'start'));
      const e = pointAt(child(line, 'end'));
      if (s) grow(s.x, s.y);
      if (e) grow(e.x, e.y);
    }
    for (const rect of children(root, 'fp_rect')) {
      if (!isCourtyard(rect)) continue;
      const s = pointAt(child(rect, 'start'));
      const e = pointAt(child(rect, 'end'));
      if (s) grow(s.x, s.y);
      if (e) grow(e.x, e.y);
    }
    for (const circle of children(root, 'fp_circle')) {
      if (!isCourtyard(circle)) continue;
      const c = pointAt(child(circle, 'center'));
      const e = pointAt(child(circle, 'end')); // a point on the circumference
      if (c && e) {
        const r = Math.hypot(e.x - c.x, e.y - c.y);
        grow(c.x - r, c.y - r);
        grow(c.x + r, c.y + r);
      }
    }
    for (const arc of children(root, 'fp_arc')) {
      if (!isCourtyard(arc)) continue;
      const s = pointAt(child(arc, 'start'));
      const m = pointAt(child(arc, 'mid'));
      const e = pointAt(child(arc, 'end'));
      const circle = s && m && e ? circleThrough(s, m, e) : null;
      if (circle) {
        grow(circle.x - circle.r, circle.y - circle.r);
        grow(circle.x + circle.r, circle.y + circle.r);
      } else {
        if (s) grow(s.x, s.y);
        if (m) grow(m.x, m.y);
        if (e) grow(e.x, e.y);
      }
    }
    for (const kind of ['fp_poly', 'fp_bezier'] as const) {
      for (const poly of children(root, kind)) {
        if (!isCourtyard(poly)) continue;
        for (const xy of children(child(poly, 'pts') ?? [], 'xy')) {
          const p = pointAt(xy);
          if (p) grow(p.x, p.y);
        }
      }
    }
  }
  const courtyard = Number.isFinite(box.minX)
    ? { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY }
    : null;

  return { libId, pads, courtyard };
}

/** Resolve a lib_id to parsed pad geometry, or null when the library is absent. */
export async function resolveFootprint(libId: string, env = process.env, projectDir?: string): Promise<FootprintDef | null> {
  const file = await resolveFootprintPath(libId, env, projectDir);
  if (!file) return null;
  try {
    return parseFootprint(await readFile(file, 'utf8'), libId);
  } catch {
    return null;
  }
}

/** Cached by file mtime so repeated parts sharing a footprint are read once. */
const cache = new Map<string, { mtimeMs: number; def: FootprintDef }>();

export async function resolveFootprintCached(libId: string, env = process.env, projectDir?: string): Promise<FootprintDef | null> {
  const file = await resolveFootprintPath(libId, env, projectDir);
  if (!file) return null;
  try {
    const { mtimeMs } = await stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.def;
    const def = parseFootprint(await readFile(file, 'utf8'), libId);
    cache.set(file, { mtimeMs, def });
    return def;
  } catch {
    return null;
  }
}
