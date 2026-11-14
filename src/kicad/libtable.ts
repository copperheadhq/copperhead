import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSexp, children, child, isList, type SexpNode } from './sexp.js';
import { kicadMajorVersion } from './cli.js';

/**
 * KiCad library tables (`fp-lib-table`, `sym-lib-table`), read the way KiCad
 * reads them: the project table next to the `.kicad_pro` first, then the
 * user's global table, with `${VAR}` URIs expanded and nested `Table` rows
 * followed (KiCad 10's global table is a single row pointing at the stock
 * template table). Read-only: nothing here writes a table.
 */

export type LibKind = 'fp' | 'sym';

export interface LibTableRow {
  /** The nickname a `Lib:Name` id uses. */
  name: string;
  /** Expanded absolute path: a `.pretty` dir (fp) or a `.kicad_sym` file (sym). */
  uri: string;
  /** Which table the row came from, for messages ("project fp-lib-table"). */
  source: string;
}

const TABLE_FILE: Record<LibKind, string> = { fp: 'fp-lib-table', sym: 'sym-lib-table' };
const MAX_TABLE_DEPTH = 4;

const atom = (node: SexpNode[] | undefined, idx: number): string | undefined => {
  const v = node?.[idx];
  return typeof v === 'string' ? v : undefined;
};

/**
 * Expand `${VAR}` and `$(VAR)` in a table URI. Returns null when a variable has
 * no value: KiCad shows such a row as unavailable, and a half-expanded path
 * would only ever resolve by accident.
 */
export function expandUri(uri: string, vars: Record<string, string | undefined>): string | null {
  let missing = false;
  const out = uri.replace(/\$\{([^}]+)\}|\$\(([^)]+)\)/g, (_, a: string | undefined, b: string | undefined) => {
    const v = vars[(a ?? b)!];
    if (v === undefined || v === '') {
      missing = true;
      return '';
    }
    return v;
  });
  return missing ? null : out;
}

/**
 * KiCad's per-user config root, newest version dir first (`~/.config/kicad/10.0`,
 * `~/Library/Preferences/kicad/10.0`, `%APPDATA%\kicad\10.0`).
 * `KICAD_CONFIG_HOME` replaces the platform root, as it does in KiCad. Given
 * the running KiCad's major version, only that version's dirs: KiCad reads its
 * own config, never a newer or older install's.
 */
export async function kicadConfigDirs(env = process.env, platform = process.platform, major?: number | null): Promise<string[]> {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const base =
    env.KICAD_CONFIG_HOME ||
    (platform === 'win32'
      ? env.APPDATA && path.join(env.APPDATA, 'kicad')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Preferences', 'kicad')
        : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'kicad'));
  if (!base) return [];
  let versions: string[] = [];
  try {
    versions = (await readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d+(\.\d+)*$/.test(e.name))
      .map((e) => e.name)
      .filter((v) => major === undefined || major === null || v.split('.')[0] === String(major))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
  return versions.map((v) => path.join(base, v));
}

/**
 * The path variables KiCad itself defines for table URIs, below the process
 * environment: `KICAD<n>_3RD_PARTY` (where the Plugin and Content Manager
 * installs libraries, and how it writes their rows) at KiCad's default
 * location, then the user's own variables from `kicad_common.json`
 * (Preferences > Configure Paths). Without them such a row expands to nothing
 * and an installed library reads as missing.
 */
export async function kicadPathVars(
  env = process.env,
  platform = process.platform,
  kicadMajor?: number | null,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};
  const configDir = (await kicadConfigDirs(env, platform, kicadMajor))[0];
  // the running KiCad defines its own version's variables whether or not it
  // has written a config dir yet
  const version = configDir ? path.basename(configDir) : kicadMajor != null ? `${kicadMajor}.0` : null;
  if (version) {
    const home = env.HOME || env.USERPROFILE || os.homedir();
    const major = version.split('.')[0];
    const dataRoot =
      platform === 'linux' || (platform !== 'win32' && platform !== 'darwin')
        ? path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'kicad')
        : path.join(env.KICAD_DOCUMENTS_HOME || path.join(home, 'Documents'), 'KiCad');
    vars[`KICAD${major}_3RD_PARTY`] = path.join(dataRoot, version, '3rdparty');
    try {
      if (!configDir) throw new Error('no config dir');
      const common = JSON.parse(await readFile(path.join(configDir, 'kicad_common.json'), 'utf8')) as {
        environment?: { vars?: Record<string, unknown> | null };
      };
      for (const [k, v] of Object.entries(common.environment?.vars ?? {})) if (typeof v === 'string' && v) vars[k] = v;
    } catch {
      // no kicad_common.json, or unreadable: KiCad's defaults stand
    }
  }
  return vars;
}

/**
 * Rows of one table file, nested `Table` rows inlined in place. Disabled rows
 * and non-KiCad plugin types (Legacy, Eagle, …) are skipped: copperhead reads
 * only KiCad-format libraries. First row for a nickname wins, as in KiCad.
 */
async function readTable(
  file: string,
  vars: Record<string, string | undefined>,
  source: string,
  depth: number,
  out: LibTableRow[],
): Promise<void> {
  if (depth > MAX_TABLE_DEPTH || !existsSync(file)) return;
  let root: SexpNode | undefined;
  try {
    root = parseSexp(await readFile(file, 'utf8'))[0];
  } catch {
    return; // an unreadable table contributes nothing, same as KiCad's error dialog
  }
  if (!root || !isList(root)) return;
  for (const lib of children(root, 'lib')) {
    if (child(lib, 'disabled')) continue;
    const name = atom(child(lib, 'name'), 1);
    const type = atom(child(lib, 'type'), 1) ?? 'KiCad';
    const rawUri = atom(child(lib, 'uri'), 1);
    if (!name || !rawUri) continue;
    const uri = expandUri(rawUri, vars);
    if (!uri) continue;
    // normalized: `${KIPRJMOD}/lib` on Windows would otherwise mix separators
    const abs = path.isAbsolute(uri) ? path.normalize(uri) : path.resolve(path.dirname(file), uri);
    if (type === 'Table') {
      await readTable(abs, vars, source, depth + 1, out);
    } else if (type === 'KiCad' && !out.some((r) => r.name === name)) {
      out.push({ name, uri: abs, source });
    }
  }
}

export interface LibTableOptions {
  /** Directory holding the `.kicad_pro`; `${KIPRJMOD}` expands to it. */
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  /** Extra variable defaults (e.g. `KICAD10_FOOTPRINT_DIR` from the stock install). */
  defaults?: Record<string, string>;
  /** Read the user's global table too (default true). */
  global?: boolean;
  /**
   * The running KiCad's major version, whose config and variables apply.
   * Defaults to `kicad-cli`'s; null reads the newest install.
   */
  kicadMajor?: number | null;
  /** Platform whose default paths apply (tests); defaults to this one. */
  platform?: NodeJS.Platform;
}

/**
 * Project rows, then global rows, keyed by nickname (project wins a clash).
 * `searched` names each table that exists, for "Searched: …" messages.
 */
export async function libTableRows(
  kind: LibKind,
  opts: LibTableOptions,
): Promise<{ rows: Map<string, LibTableRow>; searched: string[] }> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const major = opts.kicadMajor !== undefined ? opts.kicadMajor : await kicadMajorVersion();
  const vars: Record<string, string | undefined> = {
    ...opts.defaults,
    ...(await kicadPathVars(env, platform, major)),
    ...env,
    KIPRJMOD: opts.projectDir,
  };
  const rows: LibTableRow[] = [];
  const searched: string[] = [];
  const projectTable = path.join(opts.projectDir, TABLE_FILE[kind]);
  if (existsSync(projectTable)) {
    searched.push(`project ${TABLE_FILE[kind]}`);
    await readTable(projectTable, vars, `project ${TABLE_FILE[kind]}`, 0, rows);
  }
  if (opts.global !== false) {
    for (const dir of await kicadConfigDirs(env, platform, major)) {
      const table = path.join(dir, TABLE_FILE[kind]);
      if (!existsSync(table)) continue;
      const label = `global ${TABLE_FILE[kind]} (KiCad ${path.basename(dir)})`;
      searched.push(label);
      await readTable(table, vars, label, 0, rows);
      break; // KiCad reads only its own version's table
    }
  }
  return { rows: new Map(rows.map((r) => [r.name, r])), searched };
}
