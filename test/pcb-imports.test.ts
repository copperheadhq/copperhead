/**
 * Import direction (ADR 0005, implementation spec §1): `ir` imports nothing
 * under src/pcb; `verify` imports `ir`; `engines` imports `ir` and
 * `verify/diagnostic`; `agent` never imports an engine wrapper; and the
 * `check` command's module graph never reaches `src/pcb/engines` or
 * `src/pcb/agent`.
 */
import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await tsFiles(p)));
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  } catch {
    // layer not built yet
  }
  return out;
}

async function importsOf(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/from '(\.[^']+)\.js'/g)) out.push(path.resolve(path.dirname(file), m[1]!) + '.ts');
  return out;
}

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

describe('src/pcb import direction', () => {
  it('ir never imports from verify, engines, agent', async () => {
    for (const f of await tsFiles(path.join(ROOT, 'src/pcb/ir'))) {
      for (const i of await importsOf(f)) expect(rel(i), rel(f)).not.toMatch(/^src\/pcb\/(verify|engines|agent)\//);
    }
  });
  it('verify imports only ir (and the kicad wrappers), never engines or agent', async () => {
    for (const f of await tsFiles(path.join(ROOT, 'src/pcb/verify'))) {
      for (const i of await importsOf(f)) expect(rel(i), rel(f)).not.toMatch(/^src\/pcb\/(engines|agent)\//);
    }
  });
  it('engines never import agent or a sibling wrapper', async () => {
    for (const f of await tsFiles(path.join(ROOT, 'src/pcb/engines'))) {
      for (const i of await importsOf(f)) {
        expect(rel(i), rel(f)).not.toMatch(/^src\/pcb\/agent\//);
        // a wrapper may import its own directory (dsn.ts, ses.ts) but never another engine's
        const own = /^(src\/pcb\/engines\/(?:routers|placers)\/[^/]+)\//.exec(rel(f))?.[1];
        if (own) {
          const target = /^(src\/pcb\/engines\/(?:routers|placers)\/[^/]+)\//.exec(rel(i))?.[1];
          if (target) expect(target, `${rel(f)} imports ${rel(i)}`).toBe(own);
        }
      }
    }
  });
  it('agent never imports an engine wrapper', async () => {
    for (const f of await tsFiles(path.join(ROOT, 'src/pcb/agent'))) {
      for (const i of await importsOf(f)) expect(rel(i), rel(f)).not.toMatch(/^src\/pcb\/engines\/(routers|placers)\//);
    }
  });
  it('the check command never reaches engines or agent', async () => {
    const seen = new Set<string>();
    const queue = [path.join(ROOT, 'src/commands/check.ts')];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      expect(rel(f)).not.toMatch(/^src\/pcb\/(engines|agent)\//);
      queue.push(...(await importsOf(f)));
    }
  });
});
