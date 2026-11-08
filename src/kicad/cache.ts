/**
 * Library lookup cache (structured-part-selection, design D9): symbol pin
 * tables and footprint pad sets keyed by the library file's path and mtime,
 * in process and in a JSON store under `.copperhead/cache/`. A stale entry is
 * impossible by construction (the mtime is in the key); a missing, unreadable
 * or corrupt store is ignored and rebuilt. The directory ignores itself (a
 * `.gitignore` of `*` inside it, as the response cache does), so the user's
 * own .gitignore is never touched, and the agent loop's rollback — `git clean
 * -fd` without `-x` — leaves it alone: a retried stage does not re-parse
 * unchanged libraries, and neither do stage 4 and `check` after it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { LibPin } from './symlib.js';

export const CACHE_DIR = path.join('.copperhead', 'cache');
const STORE_FILE = 'library.json';
const STORE_VERSION = 1;

export interface CachedSymbol {
  pins: LibPin[];
  units: number;
}
export interface CachedPads {
  numbers: string[];
  heatsink: string[];
}
interface Entry<T> {
  mtimeMs: number;
  value: T;
}
interface Store {
  version: number;
  symbols: Record<string, Entry<CachedSymbol>>;
  pads: Record<string, Entry<CachedPads>>;
}

const MAX_ENTRIES = 20_000;

class LibraryCache {
  private symbols = new Map<string, Entry<CachedSymbol>>();
  private pads = new Map<string, Entry<CachedPads>>();
  private storeDir: string | null = null;
  private loaded = false;
  private dirty = false;
  hits = 0;
  misses = 0;

  /** Persist under `repoRoot/.copperhead/cache/`; idempotent, and a switch flushes the old store first. */
  attach(repoRoot: string): void {
    const dir = path.join(repoRoot, CACHE_DIR);
    if (this.storeDir === dir) return;
    this.flush();
    this.storeDir = dir;
    this.loaded = false;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storeDir) return;
    const file = path.join(this.storeDir, STORE_FILE);
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Store>;
      if (raw.version !== STORE_VERSION || !raw.symbols || !raw.pads) return;
      for (const [k, v] of Object.entries(raw.symbols)) if (v && typeof v.mtimeMs === 'number' && v.value) this.symbols.set(k, v);
      for (const [k, v] of Object.entries(raw.pads)) if (v && typeof v.mtimeMs === 'number' && v.value) this.pads.set(k, v);
    } catch {
      // corrupt store: rebuilt from scratch
    }
  }

  /** Write the store when something changed; synchronous so it can run at process exit. */
  flush(): void {
    if (!this.dirty || !this.storeDir) return;
    try {
      mkdirSync(this.storeDir, { recursive: true });
      const ignore = path.join(this.storeDir, '.gitignore');
      if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf8');
      const store: Store = { version: STORE_VERSION, symbols: Object.fromEntries(this.symbols), pads: Object.fromEntries(this.pads) };
      writeFileSync(path.join(this.storeDir, STORE_FILE), JSON.stringify(store), 'utf8');
      this.dirty = false;
    } catch {
      // a cache that cannot be written is only a cache
    }
  }

  private async mtime(file: string): Promise<number | null> {
    try {
      return (await stat(file)).mtimeMs;
    } catch {
      return null;
    }
  }

  async getSymbol(file: string, name: string): Promise<{ mtimeMs: number; value: CachedSymbol | null }> {
    this.load();
    const mtimeMs = (await this.mtime(file)) ?? -1;
    const hit = this.symbols.get(`${file}::${name}`);
    if (hit && hit.mtimeMs === mtimeMs) {
      this.hits++;
      return { mtimeMs, value: hit.value };
    }
    this.misses++;
    return { mtimeMs, value: null };
  }

  setSymbol(file: string, name: string, mtimeMs: number, value: CachedSymbol): void {
    if (this.symbols.size >= MAX_ENTRIES) this.symbols.clear();
    this.symbols.set(`${file}::${name}`, { mtimeMs, value });
    this.dirty = true;
  }

  async getPads(file: string): Promise<{ mtimeMs: number; value: CachedPads | null }> {
    this.load();
    const mtimeMs = (await this.mtime(file)) ?? -1;
    const hit = this.pads.get(file);
    if (hit && hit.mtimeMs === mtimeMs) {
      this.hits++;
      return { mtimeMs, value: hit.value };
    }
    this.misses++;
    return { mtimeMs, value: null };
  }

  setPads(file: string, mtimeMs: number, value: CachedPads): void {
    if (this.pads.size >= MAX_ENTRIES) this.pads.clear();
    this.pads.set(file, { mtimeMs, value });
    this.dirty = true;
  }

  /** Tests: forget everything, including the store location. */
  reset(): void {
    this.symbols.clear();
    this.pads.clear();
    this.storeDir = null;
    this.loaded = false;
    this.dirty = false;
    this.hits = 0;
    this.misses = 0;
  }
}

export const libraryCache = new LibraryCache();

process.once('exit', () => libraryCache.flush());
