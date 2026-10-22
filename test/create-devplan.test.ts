import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';
import { commitAll } from '../src/util/git.js';
import { devplanStageCommitted, devplanReviewGap } from '../src/commands/devplan.js';
import type { RunOptions } from '../src/agent/loop.js';
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/agent/loop.js', async original => ({ ...await original<object>(), runAgentLoop: mocks.run }));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));
import { runCreate, STAGES } from '../src/commands/create.js';
afterEach(() => { vi.restoreAllMocks(); mocks.run.mockReset(); });
const subject = 'copperhead: create pipeline stage: devplan';
async function plan(root: string, text: string, message: string) {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs/DEVPLAN.md'), text);
  return commitAll(root, message);
}
describe('final-stage review and commit evidence', () => {
  it('rejects a candidate committed by firmware, blocks no-op finish, accepts genuine final change and detects later stale edits', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const before = '# Plan\nPower checks first.\n';
      const old = await plan(repo, before, 'copperhead: create pipeline stage: firmware');
      expect(await devplanStageCommitted(repo, 'docs/')).toBe(false);
      expect(await devplanReviewGap(repo, 'docs/', before)).toContain('unchanged');
      const reviewed = before + '\n## Measured bring-up\nCheck USB VBUS before attaching a prototype.\n';
      await writeFile(path.join(repo, 'docs/DEVPLAN.md'), reviewed);
      expect(await devplanReviewGap(repo, 'docs/', before)).toBeNull();
      expect(await devplanStageCommitted(repo, 'docs/')).toBe(false);
      await commitAll(repo, subject);
      expect(await devplanStageCommitted(repo, 'docs/')).toBe(true);
      await execa('git', ['merge-base', '--is-ancestor', old, 'HEAD'], { cwd: repo });
      await writeFile(path.join(repo, 'docs/DEVPLAN.md'), reviewed + 'Changed after commit.\n');
      expect(await devplanStageCommitted(repo, 'docs/')).toBe(false);
      await commitAll(repo, 'other-stage edit');
      expect(await devplanStageCommitted(repo, 'docs/')).toBe(false);
    } finally { await cleanup(); }
  });
  it('does not accept an empty stage-labelled commit and rejects missing/blank plans', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await devplanReviewGap(repo, 'docs/', null)).toContain('nonempty');
      await plan(repo, '# Plan\nCandidate.\n', 'firmware');
      await execa('git', ['commit', '--allow-empty', '-m', subject], { cwd: repo });
      expect(await devplanStageCommitted(repo, 'docs/')).toBe(false);
      await writeFile(path.join(repo, 'docs/DEVPLAN.md'), '# Heading only\n');
      expect(await devplanReviewGap(repo, 'docs/', null)).toContain('nonempty');
    } finally { await cleanup(); }
  });
  it('normal create resumes only final stage, requires improvement and commit, then skips on next invocation', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      for (const stage of STAGES.slice(0, 7)) vi.spyOn(stage, 'isComplete').mockResolvedValue(true);
      await writeFile(path.join(repo, 'brief.md'), '# Existing design\n');
      await plan(repo, '# Candidate\nPower checks.\n', 'copperhead: create pipeline stage: firmware');
      mocks.run.mockImplementation(async (opts: RunOptions) => {
        expect(opts.request).toBe('create pipeline stage: devplan');
        expect(opts.stagePrompt).toContain('substantively improve docs/DEVPLAN.md');
        expect(await opts.stageGate!()).toContain('unchanged');
        const file = path.join(repo, 'docs/DEVPLAN.md');
        await writeFile(file, await readFile(file, 'utf8') + '\n## Prototype order\nRoute remaining draft nets and re-export before fabrication.\n');
        expect(await opts.stageGate!()).toBeNull();
        const commit = await commitAll(repo, subject);
        return { outcome: 'success', exitPath: 'done', summary: 'scripted genuine document change', transcriptDir: '', filesTouched: ['docs/DEVPLAN.md'], commit };
      });
      const opts = { repoRoot: repo, briefPath: path.join(repo, 'brief.md'), model: 'gpt-5', log: () => {} };
      expect((await runCreate(opts)).ok).toBe(true);
      expect(mocks.run).toHaveBeenCalledTimes(1);
      expect((await runCreate(opts)).ok).toBe(true);
      expect(mocks.run).toHaveBeenCalledTimes(1);
    } finally { await cleanup(); }
  });
});
