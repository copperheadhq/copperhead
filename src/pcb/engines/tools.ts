/**
 * Where engine binaries fetched by scripts/tools.sh live. They sit under the
 * copperhead checkout (or the installed package), not under the user's board
 * repository, so every resolver looks in both places.
 *
 * `vendor/tools` is the home; `bench/var/tools` is still searched because that
 * is where the toolchain lived until the benchmark moved to the copperbench
 * repository, and an existing checkout should not have to re-fetch 668 MB.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The copperhead package root (this file is <root>/src|dist/pcb/engines/tools.*). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** Candidate tools directories: the target repo first, then the copperhead package; `vendor/tools` before the legacy `bench/var/tools`. */
export function toolsDirs(repoRoot: string): string[] {
  const roots = [repoRoot, packageRoot()];
  const dirs = roots.flatMap((r) => [path.join(r, 'vendor', 'tools'), path.join(r, 'bench', 'var', 'tools')]);
  return [...new Set(dirs)].filter((d) => existsSync(d));
}
