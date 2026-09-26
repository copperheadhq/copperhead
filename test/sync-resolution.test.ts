import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const loop = vi.hoisted(() => vi.fn());
vi.mock('../src/agent/loop.js', () => ({ runAgentLoop: loop }));
import { syncResolve, syncVerify } from '../src/commands/sync.js';

const roots: string[] = [];
beforeEach(() => {
  loop.mockReset();
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'copperhead-sync-'));
  roots.push(root);
  await mkdir(path.join(root, '.copperhead'));
  await writeFile(path.join(root, '.copperhead', 'config.json'), JSON.stringify({ docs: 'design-docs' }));
  await writeFile(path.join(root, '.copperhead', 'constraints.json'), JSON.stringify({
    'power.sleep_current_uA': { max: 25, source: 'design-docs/SPEC.md', affects: [] },
  }));
  return root;
}

async function repairDocs(root: string): Promise<void> {
  await mkdir(path.join(root, 'design-docs'));
  await writeFile(path.join(root, 'design-docs', 'SPEC.md'), 'sleep_current_uA: 25\n');
  await writeFile(path.join(root, 'design-docs', 'DECISIONS.md'), '# Decisions\n');
  await writeFile(path.join(root, 'design-docs', 'CHANGELOG.md'), '# Changelog\n');
}

describe('sync verifies the repaired state before success', () => {
  it('reports registry constraints with no doc mention even when every doc is missing', async () => {
    const report = await syncVerify(await repo());
    expect(report.resolvable).toContainEqual(expect.objectContaining({
      kind: 'dual-write', claim: 'constraint power.sleep_current_uA exists in registry', actual: 'no doc mentions it',
    }));
    expect(report.resolvable).toContainEqual(expect.objectContaining({ kind: 'coverage', doc: 'design-docs/DECISIONS.md' }));
  });

  it('rejects a claimed agent success when inconsistencies remain and logs the remaining report', async () => {
    const root = await repo();
    const report = await syncVerify(root);
    const run = { outcome: 'success', transcriptDir: 'test-run' };
    loop.mockResolvedValue(run);
    const lines: string[] = [];
    const result = await syncResolve(root, report, 'gpt-5', (line) => lines.push(line));
    expect(result).toEqual({ ok: false, run });
    expect(lines.join('\n')).toContain('sync resolution incomplete');
    expect(lines.join('\n')).toContain('power.sleep_current_uA');
  });

  it('succeeds after the agent actually repairs the detected gaps', async () => {
    const root = await repo();
    const report = await syncVerify(root);
    loop.mockImplementation(async () => {
      await repairDocs(root);
      return { outcome: 'success' };
    });
    expect((await syncResolve(root, report, 'gpt-5', () => {})).ok).toBe(true);
  });
});
