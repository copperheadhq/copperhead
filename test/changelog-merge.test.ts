import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendChangelog } from '../src/agent/loop.js';
import type { CopperheadConfig } from '../src/config.js';

const HEADER = '# Design changelog\n\nAppend-only, newest first. One entry per committed copperhead run.\n';
const today = new Date().toISOString().slice(0, 10);

async function repo(body: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ch-changelog-'));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'CHANGELOG.md'), HEADER + body);
  return root;
}
const cfg = { docs: 'docs' } as CopperheadConfig;
const entry = { changeId: 'c1', request: 'add R3', files: ['hw.kicad_sch'], verification: 'ERC clean' };

describe('appendChangelog', () => {
  it('folds the gate line into the agent entry for the same run', async () => {
    const root = await repo(`\n## ${today} — add R3\n\n- Agent note\n\n## 2026-01-01 — older\n\n- x\n`);
    await appendChangelog(root, cfg, entry);
    const text = await readFile(path.join(root, 'docs', 'CHANGELOG.md'), 'utf8');
    expect(text.split(`## ${today} — add R3`).length).toBe(2);
    expect(text).toContain('- Agent note\n- Gate (copperhead): ERC clean; change c1; files hw.kicad_sch\n\n## 2026-01-01');
  });

  it('adds a new entry when the newest one is a different run', async () => {
    const root = await repo(`\n## 2026-01-01 — older\n\n- x\n`);
    await appendChangelog(root, cfg, entry);
    const text = await readFile(path.join(root, 'docs', 'CHANGELOG.md'), 'utf8');
    expect(text.indexOf(`## ${today} — add R3`)).toBeLessThan(text.indexOf('## 2026-01-01'));
    expect(text).toContain('- Verification: ERC clean');
  });
});
