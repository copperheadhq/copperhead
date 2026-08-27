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
export async function resolveFootprintPath(libId: string, env = process.env): Promise<string | null> {
  const colon = libId.indexOf(':');
  if (colon < 0) return null;
  const lib = libId.slice(0, colon);
  const fp = libId.slice(colon + 1);
  for (const root of footprintSearchDirs(env)) {
    const candidate = path.join(root, `${lib}.pretty`, `${fp}.kicad_mod`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
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
      pads.push({ number, type, shape, x, y, rot, width, height, layers });
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  if (root) {
    for (const line of children(root, 'fp_line')) {
      const layer = child(line, 'layer');
      const layerName = layer ? atom(layer, 1) : undefined;
      if (layerName !== 'F.CrtYd' && layerName !== 'B.CrtYd') continue;
      const start = child(line, 'start');
      const end = child(line, 'end');
      const x1 = num(start, 1);
      const y1 = num(start, 2);
      const x2 = num(end, 1);
      const y2 = num(end, 2);
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) continue;
      minX = Math.min(minX, x1, x2);
      maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2);
      maxY = Math.max(maxY, y1, y2);
    }
  }
  const courtyard = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;

  return { libId, pads, courtyard };
}

/** Resolve a lib_id to parsed pad geometry, or null when the library is absent. */
export async function resolveFootprint(libId: string, env = process.env): Promise<FootprintDef | null> {
  const file = await resolveFootprintPath(libId, env);
  if (!file) return null;
  try {
    return parseFootprint(await readFile(file, 'utf8'), libId);
  } catch {
    return null;
  }
}

/** Cached by file mtime so repeated parts sharing a footprint are read once. */
const cache = new Map<string, { mtimeMs: number; def: FootprintDef }>();

export async function resolveFootprintCached(libId: string, env = process.env): Promise<FootprintDef | null> {
  const file = await resolveFootprintPath(libId, env);
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
