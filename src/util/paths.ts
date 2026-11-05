import path from 'node:path';
import os from 'node:os';

export class SandboxError extends Error {
  constructor(public readonly attempted: string) {
    super(`path escapes repo root: ${attempted}`);
    this.name = 'SandboxError';
  }
}

/**
 * Resolve a repo-relative path and reject anything that escapes the repo root
 * (AC-4.2). All file tools must go through this.
 */
export function resolveInRepo(repoRoot: string, p: string): string {
  const abs = path.resolve(repoRoot, p);
  const root = path.resolve(repoRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new SandboxError(p);
  }
  return abs;
}

export function isKicadFile(p: string): boolean {
  return /\.(kicad_sch|kicad_pcb|kicad_pro|kicad_sym|kicad_mod|kicad_dru)$/.test(p);
}

/**
 * Files whose edit changes what DRC says about the board: the board itself,
 * the project's design rules and rule severities (.kicad_pro), and its custom
 * rules (.kicad_dru). Tightening a clearance there fails an unchanged board;
 * loosening one passes a board that failed.
 */
export function affectsDrc(p: string): boolean {
  return /\.(kicad_pcb|kicad_pro|kicad_dru)$/.test(p);
}

/** Shorten absolute paths for TTY chrome: `$HOME/…` → `~/…`. */
export function shortPath(p: string): string {
  const home = os.homedir();
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return '~' + p.slice(home.length);
  }
  return p;
}
