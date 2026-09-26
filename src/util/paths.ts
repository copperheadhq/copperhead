import path from 'node:path';
import os from 'node:os';
import { lstatSync } from 'node:fs';

export class SandboxError extends Error {
  constructor(public readonly attempted: string, reason = 'path escapes repo root') {
    super(`${reason}: ${attempted}`);
    this.name = 'SandboxError';
  }
}

/**
 * Resolve a repo-relative path and reject anything that escapes the repo root
 * (AC-4.2). All file tools must go through this. Symlinks below the root are
 * refused, including in-repo aliases: an alias can hide a KiCad extension
 * from the verification gates. The root itself may be reached via a symlink.
 */
export function resolveInRepo(repoRoot: string, p: string): string {
  const abs = path.resolve(repoRoot, p);
  const root = path.resolve(repoRoot);
  const relative = path.relative(root, abs);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new SandboxError(p);
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new SandboxError(p, 'path follows a symbolic link below repo root; use the real repo-relative path');
      }
    } catch (err) {
      // New files and directories are valid write targets. Once a component
      // is absent, no existing descendant can contain a symbolic link.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
  }
  return abs;
}

export function isKicadFile(p: string): boolean {
  return /\.(kicad_sch|kicad_pcb|kicad_pro|kicad_sym|kicad_mod)$/.test(p);
}

/** Shorten absolute paths for TTY chrome: `$HOME/…` → `~/…`. */
export function shortPath(p: string): string {
  const home = os.homedir();
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return '~' + p.slice(home.length);
  }
  return p;
}
