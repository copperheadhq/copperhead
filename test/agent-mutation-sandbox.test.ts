import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { loadConfig } from '../src/config.js';
import { dispatchToolResult, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { buildSystemPrompt } from '../src/agent/prompts.js';
import { loadConstraints, saveConstraints } from '../src/memory/constraints.js';
import { SandboxError } from '../src/util/paths.js';
import { tempFixtureRepo } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(): Promise<{ repo: string; outside: string }> {
  const { repo, cleanup } = await tempFixtureRepo();
  cleanups.push(cleanup);
  const outside = await mkdtemp(path.join(tmpdir(), 'copperhead-outside-'));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  return { repo, outside };
}

async function context(repoRoot: string): Promise<RunContext> {
  const transcript = new Transcript(repoRoot);
  await transcript.init();
  return {
    repoRoot, config: await loadConfig(repoRoot), transcript, ledger: new ObligationsLedger(),
    runId: 'sandbox-test', interactive: false, confirm: async () => true,
    editsUnlocked: true, changeId: 'old-change', proposalValidated: true,
    filesTouched: new Set(), decisions: [], lastErc: null, lastDrc: null,
    lastLegibility: null, lastScore: null, repairCycles: 0, finishRequest: null,
  };
}

describe('agent metadata writes reject existing leaf symlinks', () => {
  it.each(['proposal.md', 'tasks.md'])('refuses an external %s before writing either proposal artifact', async (leaf) => {
    const { repo, outside } = await fixture();
    const ctx = await context(repo);
    const dir = path.join(repo, 'openspec/changes/new-change');
    await mkdir(dir, { recursive: true });
    const target = path.join(outside, leaf);
    await writeFile(target, 'outside original');
    await symlink(target, path.join(dir, leaf));

    const result = await dispatchToolResult(ctx, 'propose_change', {
      id: 'new-change', why: 'new request', what_changes: '- changes', tasks: '- [ ] tasks',
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('symbolic link');
    expect(ctx.editsUnlocked).toBe(false);
    expect(ctx.proposalValidated).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('outside original');
    await expect(readFile(path.join(dir, leaf === 'proposal.md' ? 'tasks.md' : 'proposal.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not append a decision through a symlink', async () => {
    const { repo, outside } = await fixture();
    const ctx = await context(repo);
    await mkdir(path.join(repo, 'docs'));
    const target = path.join(outside, 'DECISIONS.md');
    await writeFile(target, 'outside original');
    await symlink(target, path.join(repo, 'docs/DECISIONS.md'));

    const result = await dispatchToolResult(ctx, 'record_decision', { decision: 'choice', rationale: 'reason' });

    expect(result.ok).toBe(false);
    expect(ctx.decisions).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe('outside original');
  });

  it('does not read or overwrite a linked constraint registry', async () => {
    const { repo, outside } = await fixture();
    await mkdir(path.join(repo, '.copperhead'), { recursive: true });
    const target = path.join(outside, 'constraints.json');
    await writeFile(target, '{}\n');
    await symlink(target, path.join(repo, '.copperhead/constraints.json'));

    await expect(loadConstraints(repo)).rejects.toThrow(SandboxError);
    await expect(saveConstraints(repo, { limit: { max: 1, source: 'docs/SPEC.md', affects: [] } })).rejects.toThrow(SandboxError);
    expect(await readFile(target, 'utf8')).toBe('{}\n');
  });

  it('fails the changelog gate without writing through its symlink', async () => {
    const { repo, outside } = await fixture();
    await mkdir(path.join(repo, 'docs'));
    const target = path.join(outside, 'CHANGELOG.md');
    await writeFile(target, 'outside original');
    await writeFile(path.join(repo, 'docs/.keep'), 'original');
    await execa('git', ['add', '-A'], { cwd: repo });
    await execa('git', ['commit', '-qm', 'linked changelog'], { cwd: repo });
    let turn = 0;

    const result = await runAgentLoop({
      repoRoot: repo, request: 'notes', model: 'test', maxTurns: 2, log: () => {},
      provider: {
        name: 'scripted',
        async chat() {
          // The prompt's own read gate is tested separately. Install the
          // preexisting leaf for the later changelog write after prompt load.
          if (turn === 0) await symlink(target, path.join(repo, 'docs/CHANGELOG.md'));
          return {
            text: null, usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: ++turn === 1 ? [
              { id: 'propose', name: 'propose_change', args: { id: 'new-change', why: 'notes', what_changes: '- notes', tasks: '- [ ] notes' } },
              { id: 'validate', name: 'validate_change', args: {} },
            ] : [
              { id: 'write', name: 'write_file', args: { path: 'notes.txt', content: 'run work' } },
              { id: 'finish', name: 'finish', args: { outcome: 'done', summary: 'notes' } },
            ],
          };
        },
      },
    });

    expect(result.outcome).toBe('failure');
    expect(result.exitPath).toBe('commit-failed');
    expect(result.summary).toContain('symbolic link');
    expect(await readFile(target, 'utf8')).toBe('outside original');
    await expect(readFile(path.join(repo, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('prompt and transcript paths remain contained', () => {
  it('rejects a linked design doc before its external contents enter the prompt', async () => {
    const { repo, outside } = await fixture();
    await mkdir(path.join(repo, 'docs'));
    const target = path.join(outside, 'private.md');
    await writeFile(target, 'outside private content');
    await symlink(target, path.join(repo, 'docs/SPEC.md'));

    await expect(buildSystemPrompt(repo, await loadConfig(repo), {})).rejects.toThrow(SandboxError);
    expect(await readFile(target, 'utf8')).toBe('outside private content');
  });

  it.each([false, true])('does not initialize through a runs-directory symlink, constructor already called: %s', async (constructed) => {
    const { repo, outside } = await fixture();
    const transcript = constructed ? new Transcript(repo) : null;
    await mkdir(path.join(repo, '.copperhead'), { recursive: true });
    await symlink(outside, path.join(repo, '.copperhead/runs'), 'dir');

    if (transcript) await expect(transcript.init()).rejects.toThrow(SandboxError);
    else expect(() => new Transcript(repo)).toThrow(SandboxError);
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(['transcript.jsonl', 'summary.md'])('does not write through an existing %s symlink', async (leaf) => {
    const { repo, outside } = await fixture();
    const transcript = new Transcript(repo);
    await transcript.init();
    const target = path.join(outside, leaf);
    await writeFile(target, 'outside original');
    await rm(path.join(transcript.dir, leaf), { force: true });
    await symlink(target, path.join(transcript.dir, leaf));

    if (leaf === 'transcript.jsonl') {
      await expect(transcript.event('test', { data: 'new event' })).rejects.toThrow(SandboxError);
    } else {
      await expect(transcript.writeSummary({
        request: 'request', changeId: null, plan: null, filesTouched: [],
        ercResult: null, drcResult: null, decisions: [], tokensIn: 0, tokensOut: 0,
        outcome: 'success', openObligations: null,
      })).rejects.toThrow(SandboxError);
    }
    expect(await readFile(target, 'utf8')).toBe('outside original');
  });
});
