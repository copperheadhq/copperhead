import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import {
  addDeclinedOutcomes,
  briefSha256,
  initialReconciliationRecord,
  compareBrief,
  inspectBriefFreshness,
  writeReconciliationRecord,
} from '../src/memory/brief-reconciliation.js';
import { syncBriefResolve, validateBriefDecisions } from '../src/commands/sync.js';
import { runCheck } from '../src/commands/check.js';
import { tempFixtureRepo } from './helpers.js';

const silent = (): void => {};

async function commit(repo: string, message: string): Promise<void> {
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', message], { cwd: repo });
}

async function installBriefOrigin(repo: string, brief: string): Promise<void> {
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  await writeFile(path.join(repo, 'docs', 'BRIEF.md'), brief, 'utf8');
  await writeFile(
    path.join(repo, 'docs', 'BRIEF.sha256'),
    `brief: docs/BRIEF.md\nsha256: ${briefSha256(brief)}\n`,
    'utf8',
  );
  await commit(repo, 'add product brief provenance');
}

async function recordForCurrentBrief(repo: string, brief: string, refusals: { briefSha256: string; id: string; rationale: string }[] = []): Promise<void> {
  const { stdout: blob } = await execa('git', ['rev-parse', 'HEAD:docs/BRIEF.md'], { cwd: repo });
  await writeReconciliationRecord(repo, {
    schemaVersion: 1,
    briefPath: 'docs/BRIEF.md',
    sha256: briefSha256(brief),
    gitBlob: blob.trim(),
    refusals,
  });
}

async function runCheckCli(repo: string, json: boolean) {
  return execa(process.execPath, [
    '--import',
    path.resolve('node_modules/tsx/dist/loader.mjs'),
    path.resolve('src/cli.ts'),
    '--repo',
    repo,
    ...(json ? ['--json'] : []),
    'check',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    reject: false,
  });
}

class BriefDecisionProvider implements Provider {
  readonly name = 'scripted-brief-decision';
  private turn = 0;
  lastFinishResult: string | null = null;

  async chat(messages: Msg[]): Promise<Turn> {
    const finishResult = [...messages].reverse().find((message) => message.role === 'tool' && message.toolCallId === 'finish');
    if (finishResult?.role === 'tool') this.lastFinishResult = finishResult.content;
    const calls = [
      [{ id: 'proposal', name: 'propose_change', args: {
        id: 'brief-reconciliation-test',
        why: 'Exercise brief reconciliation in a deterministic test.',
        what_changes: '- Reconcile the fixture brief.',
        tasks: '- [x] Record the fixture outcome.',
      } }],
      [{ id: 'validate', name: 'validate_change', args: {} }],
      [{ id: 'decision', name: 'record_decision', args: {
          decision: 'brief:B1 declined',
          rationale: 'The fixture does not contain a design change to implement.',
        } }],
      [
        { id: 'drift', name: 'check_drift', args: {} },
        { id: 'finish', name: 'finish', args: { outcome: 'done', summary: 'Recorded the fixture decision.' } },
      ],
    ];
    const toolCalls = calls[Math.min(this.turn++, calls.length - 1)]!;
    return { text: null, toolCalls, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

class BriefMutationProvider extends BriefDecisionProvider {
  private mutated = false;

  constructor(private readonly repo: string, private readonly replacement: string) {
    super();
  }

  override async chat(messages: Msg[]): Promise<Turn> {
    const turn = await super.chat(messages);
    if (!this.mutated) {
      await writeFile(path.join(this.repo, 'docs', 'BRIEF.md'), this.replacement, 'utf8');
      this.mutated = true;
    }
    return turn;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function installPreCommitCheck(repo: string, pass: boolean): Promise<void> {
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  const body = pass
    ? `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import ${shellQuote(path.resolve('node_modules/tsx/dist/loader.mjs'))} ${shellQuote(path.resolve('src/cli.ts'))} --repo ${shellQuote(repo)} check\n`
    : '#!/bin/sh\nexit 1\n';
  await writeFile(hook, body, { mode: 0o755 });
}

describe('brief reconciliation state', () => {
  it('creates an initial baseline only for the tracked brief recorded as the immutable origin', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const brief = '# Keyer\n\n- BLE keyboard\n';
      await installBriefOrigin(repo, brief);
      const record = await initialReconciliationRecord(repo, 'docs', {
        path: 'docs/BRIEF.md',
        sha256: briefSha256(brief),
      });
      const mismatched = await initialReconciliationRecord(repo, 'docs', {
        path: 'docs/BRIEF.md',
        sha256: briefSha256(`${brief}changed\n`),
      });

      expect(record).toMatchObject({ briefPath: 'docs/BRIEF.md', sha256: briefSha256(brief) });
      expect(record?.gitBlob).toMatch(/^[0-9a-f]{40,64}$/);
      expect(mismatched).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('redacts secrets from declined text and rationale before storing them', () => {
    const refusal = addDeclinedOutcomes([], 'a'.repeat(64), [{
      id: 'B1',
      outcome: 'declined',
      change: 'Use key sk-example_1234567890 in the board notes.',
      rationale: 'The key sk-example_1234567890 is unnecessary.',
    }])[0]!;

    expect(refusal.change).toContain('[REDACTED]');
    expect(refusal.rationale).toContain('[REDACTED]');
    expect(refusal.change).not.toContain('sk-example_1234567890');
    expect(refusal.rationale).not.toContain('sk-example_1234567890');
  });

  it('reports legacy origin provenance as unknown even when its hash matches', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const brief = '# Keyer\n\nRequirements:\n- BLE keyboard\n';
      await installBriefOrigin(repo, brief);

      const result = await inspectBriefFreshness(repo, 'docs');

      expect(result.status).toBe('unknown');
      expect(result.ok).toBe(false);
      expect(result.currentSha256).toBe(briefSha256(brief));
      expect(result.reconciledSha256).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('reports current and stale states against the last reconciled Git blob', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const brief = '# Keyer\n\n- BLE keyboard\n';
      await installBriefOrigin(repo, brief);
      await recordForCurrentBrief(repo, brief);

      const current = await inspectBriefFreshness(repo, 'docs');
      expect(current).toMatchObject({ status: 'current' });
      expect(current.ok).toBe(true);

      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), `${brief}- Bottom-side labels\n`, 'utf8');
      const stale = await inspectBriefFreshness(repo, 'docs');
      expect(stale.status).toBe('stale');
      expect(stale.ok).toBe(false);
      expect(stale.reconciledSha256).toBe(briefSha256(brief));
      expect(stale.currentSha256).toBe(briefSha256(`${brief}- Bottom-side labels\n`));
    } finally {
      await cleanup();
    }
  });

  it('makes unknown and stale freshness fail through check text, JSON, and exit status', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const original = '# Keyer\n\n- BLE keyboard\n';
      await installBriefOrigin(repo, original);

      const unknownCli = await runCheckCli(repo, true);
      expect(unknownCli.exitCode).toBe(1);
      expect(JSON.parse(unknownCli.stdout)).toMatchObject({
        ok: false,
        brief: { status: 'unknown' },
      });

      await recordForCurrentBrief(repo, original);
      const changed = `${original}- Bottom-side labels\n`;
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), changed, 'utf8');

      const messages: string[] = [];
      const direct = await runCheck(repo, (message) => messages.push(message));
      expect(direct.ok).toBe(false);
      expect(direct.brief).toMatchObject({ status: 'stale', ok: false });
      expect(messages.join('\n')).toContain('brief stale');

      const staleJsonCli = await runCheckCli(repo, true);
      expect(staleJsonCli.exitCode).toBe(1);
      expect(JSON.parse(staleJsonCli.stdout)).toMatchObject({
        ok: false,
        brief: { status: 'stale', ok: false },
      });

      const staleTextCli = await runCheckCli(repo, false);
      expect(staleTextCli.exitCode).toBe(1);
      expect(staleTextCli.stdout).toContain('brief stale');
    } finally {
      await cleanup();
    }
  });

  it('recovers the exact legacy origin and splits separated requirement additions into stable blocks', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const original = '# Board\n\n## Power\nExisting power rail.\n\n## PCB\nExisting outline.\n\n## Labels\nExisting top labels.\n';
      await installBriefOrigin(repo, original);
      const changed = '# Board\n\n## Power\nExisting power rail.\nAdd 100 nF capacitors at the MCU.\n\n## PCB\nExisting outline.\nAdd mounting notches.\n\n## Labels\nExisting top labels.\nAdd pin labels on the bottom side.\n';
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), changed, 'utf8');
      await commit(repo, 'update product brief');

      const before = (await execa('git', ['status', '--short'], { cwd: repo })).stdout;
      const report = await compareBrief(repo, 'docs');
      const after = (await execa('git', ['status', '--short'], { cwd: repo })).stdout;

      expect(report).toMatchObject({ status: 'stale' });
      expect(report.baseline).toBe('origin');
      expect(report.items.map((item) => item.id)).toEqual(['B1', 'B2', 'B3']);
      expect(report.items.map((item) => item.after)).toEqual([
        'Add 100 nF capacitors at the MCU.',
        'Add mounting notches.',
        'Add pin labels on the bottom side.',
      ]);
      expect(report.currentText).toBe(changed);
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('previews a legacy brief diff without calling a provider or changing the worktree', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const original = '# Keyer\n\n- BLE keyboard\n';
      await installBriefOrigin(repo, original);
      const changed = `${original}- Bottom-side labels\n`;
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), changed, 'utf8');
      await commit(repo, 'update product brief');
      const before = (await execa('git', ['status', '--short'], { cwd: repo })).stdout;
      const cli = await execa(process.execPath, [
        '--import',
        'tsx',
        path.join(process.cwd(), 'src', 'cli.ts'),
        '--repo',
        repo,
        'sync',
        '--brief',
        '--dry-run',
      ], { cwd: process.cwd() });
      const after = (await execa('git', ['status', '--short'], { cwd: repo })).stdout;

      expect(cli.stdout).toContain('brief reconciliation: 1 changed block');
      expect(cli.stdout).toContain('Bottom-side labels');
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('reports corrupt and unavailable reconciliation state as unknown', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await installBriefOrigin(repo, '# Keyer\n');
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'brief-reconciliation.json'), '{bad json', 'utf8');
      const corrupt = await inspectBriefFreshness(repo, 'docs');
      expect(corrupt.status).toBe('unknown');
      expect(corrupt.ok).toBe(false);
      expect(corrupt.detail).toContain('unreadable');

      await writeFile(path.join(repo, '.copperhead', 'brief-reconciliation.json'), JSON.stringify({
        schemaVersion: 1,
        briefPath: 'docs/BRIEF.md',
        sha256: briefSha256('# Keyer\n'),
        gitBlob: '0000000000000000000000000000000000000000',
        refusals: [],
      }), 'utf8');
      const unavailable = await inspectBriefFreshness(repo, 'docs');
      expect(unavailable.status).toBe('unknown');
      expect(unavailable.ok).toBe(false);
      expect(unavailable.detail).toContain('baseline is unavailable');
    } finally {
      await cleanup();
    }
  });

  it('keeps explicit declines visible while reporting matching freshness as current', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const brief = '# Keyer\n\n- BLE keyboard\n';
      await installBriefOrigin(repo, brief);
      await recordForCurrentBrief(repo, brief, [{
        briefSha256: briefSha256(brief),
        id: 'B1',
        change: 'Add a larger enclosure.',
        rationale: 'The board size constraint rules this out.',
      }]);

      const result = await inspectBriefFreshness(repo, 'docs');

      expect(result).toMatchObject({ status: 'current' });
      expect(result.refused).toEqual([{ briefSha256: briefSha256(brief), id: 'B1', change: 'Add a larger enclosure.', rationale: 'The board size constraint rules this out.' }]);
    } finally {
      await cleanup();
    }
  });

  it('does not claim a clean result when a conventional brief lacks origin provenance', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), '# Keyer\n', 'utf8');
      const result = await inspectBriefFreshness(repo, 'docs');
      expect(result.status).toBe('unknown');
      expect(result.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('reports brief freshness as not applicable when the project has no brief or origin', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const messages: string[] = [];
      const result = await runCheck(repo, (message) => messages.push(message));

      expect(result.brief).toMatchObject({ status: 'not-applicable', ok: true });
      expect(messages.join('\n')).toContain('brief skipped (no brief provenance configured)');
    } finally {
      await cleanup();
    }
  });
});

describe('brief reconciliation decisions', () => {
  it('requires one unambiguous outcome with rationale for every changed block', () => {
    expect(validateBriefDecisions(['brief:B1 applied | why:Added the requested capacitors.', 'brief:B2 declined | why:Conflicts with the size limit.'], ['B1', 'B2'])).toEqual({
      ok: true,
      outcomes: [
        { id: 'B1', outcome: 'applied', rationale: 'Added the requested capacitors.' },
        { id: 'B2', outcome: 'declined', rationale: 'Conflicts with the size limit.' },
      ],
    });
    expect(validateBriefDecisions(['brief:B1 applied | why:Done.'], ['B1', 'B2']).ok).toBe(false);
    expect(validateBriefDecisions(['brief:B1 applied | why:Done.', 'brief:B1 declined | why:Changed my mind.'], ['B1']).ok).toBe(false);
    expect(validateBriefDecisions(['brief:B1 applied | why:'], ['B1']).ok).toBe(false);
  });
});

describe('sync --brief with an edited source brief', () => {
  async function staleBriefRepo(): Promise<{ repo: string; cleanup: () => Promise<void>; original: string; changed: string }> {
    const fixture = await tempFixtureRepo();
    const original = '# Keyer\n\n- BLE keyboard\n';
    const changed = `${original}- Add bottom-side labels\n`;
    await installBriefOrigin(fixture.repo, original);
    await recordForCurrentBrief(fixture.repo, original);
    await commit(fixture.repo, 'record initial brief reconciliation');
    await writeFile(path.join(fixture.repo, 'docs', 'BRIEF.md'), changed, 'utf8');
    return { ...fixture, original, changed };
  }

  it('reconciles a dirty brief and passes the pre-commit check in the same commit', async () => {
    const { repo, cleanup, changed } = await staleBriefRepo();
    try {
      const report = await compareBrief(repo, 'docs');
      await installPreCommitCheck(repo, true);
      const log: string[] = [];
      const provider = new BriefDecisionProvider();

      const result = await syncBriefResolve(repo, report, 'gpt-5', (line) => log.push(line), { provider });
      const freshness = await inspectBriefFreshness(repo, 'docs');
      const { stdout: committedBrief } = await execa('git', ['show', 'HEAD:docs/BRIEF.md'], { cwd: repo });

      expect(result.run.outcome, `${log.join('\n')}\n${provider.lastFinishResult ?? ''}`).toBe('success');
      expect(freshness).toMatchObject({ status: 'current', currentSha256: briefSha256(changed) });
      expect(committedBrief).toBe(changed.trimEnd());
      expect((await execa('git', ['status', '--short'], { cwd: repo })).stdout).toBe('');
    } finally {
      await cleanup();
    }
  });

  it('refuses to run when any pre-existing change besides the brief is present', async () => {
    const { repo, cleanup } = await staleBriefRepo();
    try {
      const report = await compareBrief(repo, 'docs');
      await writeFile(path.join(repo, 'docs', 'NOTES.md'), 'unrelated change\n', 'utf8');

      await expect(syncBriefResolve(repo, report, 'gpt-5', silent)).rejects.toThrow(/commit or stash other changes/);
      expect(await readFile(path.join(repo, 'docs', 'BRIEF.md'), 'utf8')).toContain('Add bottom-side labels');
    } finally {
      await cleanup();
    }
  });

  it('preserves the dirty brief and prior reconciliation record when the commit hook fails', async () => {
    const { repo, cleanup, original, changed } = await staleBriefRepo();
    try {
      const report = await compareBrief(repo, 'docs');
      await installPreCommitCheck(repo, false);
      const log: string[] = [];
      const provider = new BriefDecisionProvider();

      const result = await syncBriefResolve(repo, report, 'gpt-5', (line) => log.push(line), { provider });
      const freshness = await inspectBriefFreshness(repo, 'docs');

      expect(result.run.outcome).toBe('failure');
      expect(result.run.exitPath, `${log.join('\n')}\n${provider.lastFinishResult ?? ''}`).toBe('commit-failed');
      expect(await readFile(path.join(repo, 'docs', 'BRIEF.md'), 'utf8')).toBe(changed);
      expect(freshness).toMatchObject({ status: 'stale', reconciledSha256: briefSha256(original), currentSha256: briefSha256(changed) });
    } finally {
      await cleanup();
    }
  });

  it('does not advance the reconciliation record when the brief changes during the run', async () => {
    const { repo, cleanup, original, changed } = await staleBriefRepo();
    try {
      const report = await compareBrief(repo, 'docs');
      const concurrentlyChanged = `${changed}- Added while reconciliation is running\n`;
      const provider = new BriefMutationProvider(repo, concurrentlyChanged);

      const result = await syncBriefResolve(repo, report, 'gpt-5', silent, { provider });
      const freshness = await inspectBriefFreshness(repo, 'docs');

      expect(result.run.outcome).toBe('failure');
      expect(result.run.exitPath).toBe('commit-failed');
      expect(freshness.status).toBe('stale');
      expect(freshness.reconciledSha256).toBe(briefSha256(original));
      expect(freshness.currentSha256).not.toBe(briefSha256(original));
    } finally {
      await cleanup();
    }
  });
});


describe('verified run pre-commit hook', () => {
  class FinishProvider implements Provider {
    readonly name = 'scripted-finish';
    async chat(): Promise<Turn> {
      return {
        text: null,
        toolCalls: [{ id: 'finish', name: 'finish', args: { outcome: 'done', summary: 'verified' } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
  }

  it('commits reconciliation bookkeeping only after finish gates pass', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const statePath = path.join(repo, '.copperhead', 'brief-reconciliation.json');
      const result = await runAgentLoop({
        repoRoot: repo,
        request: 'test pre-commit bookkeeping',
        model: 'gpt-5',
        provider: new FinishProvider(),
        log: silent,
        beforeCommit: async (ctx) => {
          await writeFile(statePath, '{"saved":true}\n', 'utf8');
          ctx.filesTouched.add(statePath);
        },
      });
      expect(result.outcome).toBe('success');
      expect(result.commit).toBeTruthy();
      expect((await execa('git', ['show', 'HEAD:.copperhead/brief-reconciliation.json'], { cwd: repo })).stdout).toContain('"saved":true');
    } finally {
      await cleanup();
    }
  });

  it('rolls back bookkeeping when the pre-commit hook fails', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const statePath = path.join(repo, '.copperhead', 'brief-reconciliation.json');
      const result = await runAgentLoop({
        repoRoot: repo,
        request: 'test failed pre-commit bookkeeping',
        model: 'gpt-5',
        provider: new FinishProvider(),
        log: silent,
        beforeCommit: async () => {
          await writeFile(statePath, '{"saved":true}\n', 'utf8');
          throw new Error('test failure');
        },
      });
      expect(result.outcome).toBe('failure');
      expect(result.exitPath).toBe('commit-failed');
      expect(existsSync(statePath)).toBe(false);
      expect((await execa('git', ['status', '--short'], { cwd: repo })).stdout).toBe('');
    } finally {
      await cleanup();
    }
  });
});
