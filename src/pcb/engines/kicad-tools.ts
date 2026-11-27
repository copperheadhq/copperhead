/**
 * Shared by the kicad-tools router and placer wrappers: locating `kct` and
 * rewriting KiCad 10 boards into the net-code dialect its parser expects.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { PcbDesign } from '../ir/types.js';
import { topLevelBlocks } from '../ir/kicad/blocks.js';
import { toolsDirs } from './tools.js';

/** kct: COPPERHEAD_KCT > vendor/tools/kt-venv (target repo, then the copperhead package) > PATH. */
export function resolveKct(env = process.env, repoRoot = process.cwd()): string {
  if (env.COPPERHEAD_KCT?.trim()) return env.COPPERHEAD_KCT.trim();
  for (const dir of toolsDirs(repoRoot)) {
    const venv = path.join(dir, 'kt-venv', 'bin', 'kct');
    if (existsSync(venv)) return venv;
  }
  return 'kct';
}

/** Rewrite a name-dialect board (KiCad 10) into the code dialect (KiCad 8/9) that kct parses: a net table after (setup) and `(net N "name")` on every object. */
export function toCodeDialect(text: string, design: PcbDesign): string {
  const codes = new Map(design.nets.map((n) => [n.name, n.code]));
  let next = Math.max(0, ...codes.values()) + 1;
  const body = text.replace(/\(net "((?:[^"\\]|\\.)*)"\)/g, (_m, name: string) => {
    if (!codes.has(name)) codes.set(name, next++);
    return `(net ${codes.get(name)} "${name}")`;
  });
  const table = ['\t(net 0 "")', ...[...codes.entries()].sort((a, b) => a[1] - b[1]).map(([name, code]) => `\t(net ${code} "${name}")`)].join('\n');
  const setup = topLevelBlocks(body).find((b) => b.head === 'setup');
  const at = setup ? setup.end : body.lastIndexOf(')');
  return `${body.slice(0, at)}\n${table}${body.slice(at)}`;
}

/** The board text a KiCad 8/9-era parser should read (kct, pyplacer): the code dialect when the source carries only net names. */
export function boardForKct(text: string, design: PcbDesign): string {
  return design.source.netDialect === 'name' ? toCodeDialect(text, design) : text;
}
