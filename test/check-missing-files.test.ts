import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCheck } from '../src/commands/check.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(config: object): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'copperhead-missing-'));
  roots.push(root);
  await mkdir(path.join(root, '.copperhead'));
  await writeFile(path.join(root, '.copperhead', 'config.json'), JSON.stringify(config));
  return root;
}

describe('check distinguishes absent configuration from deleted design files', () => {
  it('still skips intentionally unconfigured schematic and board', async () => {
    const result = await runCheck(await repo({ schematic: null, board: null }), () => {});
    expect(result.ok).toBe(true);
    expect(result.erc).toBeNull();
    expect(result.drc).toBeNull();
  });

  it.each([
    ['schematic', 'hardware/design.kicad_sch', 'erc'],
    ['board', 'hardware/design.kicad_pcb', 'drc'],
  ] as const)('fails when the configured %s is missing', async (key, file, check) => {
    const lines: string[] = [];
    const result = await runCheck(await repo({ [key]: file }), (line) => lines.push(line));
    expect(result.ok).toBe(false);
    expect(result[check]).toEqual({
      ok: false,
      violations: 0,
      error: `configured ${key} is missing: ${file}`,
    });
    expect(lines.join('\n')).toContain(`${check.toUpperCase()} failed: configured ${key} is missing: ${file}`);
  });

  it('reports both missing configured files in one result', async () => {
    const result = await runCheck(
      await repo({ schematic: 'deleted.kicad_sch', board: 'deleted.kicad_pcb' }),
      () => {},
    );
    expect(result.ok).toBe(false);
    expect(result.erc?.ok).toBe(false);
    expect(result.drc?.ok).toBe(false);
  });
});
