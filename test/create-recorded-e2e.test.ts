import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import type { Msg, Provider, ToolSchema, Turn } from '../src/agent/types.js';

// Only substitute the model boundary. The real agent loop, dispatcher, KiCad,
// completion contracts, rollback and commit code all execute normally.
const replay = vi.hoisted(() => ({
  providerFor: undefined as undefined | ((stage: string) => Promise<Provider>),
  calls: [] as string[],
  outcomes: [] as RunResult[],
  turnsServed: {} as Record<string, number>,
}));
vi.mock('../src/agent/loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/loop.js')>();
  return {
    ...actual,
    makeProvider: async () => { throw new Error('Replay forbids every live provider and fallback'); },
    runAgentLoop: async (opts: RunOptions) => {
      const stage = opts.request.replace('create pipeline stage: ', '');
      if (!replay.providerFor) throw new Error('Replay provider was not configured');
      replay.calls.push(stage);
      const result = await actual.runAgentLoop({ ...opts, provider: await replay.providerFor(stage) });
      replay.outcomes.push(result);
      return result;
    },
  };
});

import { runCreate, STAGES } from '../src/commands/create.js';
import { runCheck } from '../src/commands/check.js';
import { outputsPackageGap } from '../src/commands/outputs.js';
import { loadConfig } from '../src/config.js';
import { kicadCliVersion } from '../src/kicad/cli.js';
import { runErc } from '../src/kicad/cli.js';
import { bootstrapKicadProject } from '../src/kicad/bootstrap.js';
import { supervise } from '../scripts/run-recorded-create-e2e.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/create-recorded-500ma');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Recording = { name: string; recordedRun: string; turns: { file: string; sha256: string }[] };
const manifest = JSON.parse(await readFile(path.join(fixture, 'manifest.json'), 'utf8')) as {
  kind: string; briefSha256: string; stages: Recording[];
};

async function recordedProvider(record: Recording, truncateLast = false): Promise<Provider> {
  const turns: Turn[] = [];
  for (const item of record.turns) {
    const bytes = await readFile(path.join(fixture, item.file));
    expect(sha256(bytes), `immutable recording ${item.file}`).toBe(item.sha256);
    turns.push(JSON.parse(bytes.toString('utf8')) as Turn);
  }
  // Explicit negative-test fault injection: omit a response, never rewrite one.
  if (truncateLast) turns.pop();
  let cursor = 0;
  return {
    name: 'sequential-recorded-experimental-model-replay',
    async chat(messages: Msg[], tools: ToolSchema[]): Promise<Turn> {
      const request = messages.find((message) => message.role === 'user');
      expect(request?.content).toContain(`Request: create pipeline stage: ${record.name}`);
      const turn = turns[cursor++];
      if (!turn) throw new Error(`Recording exhausted in ${record.name}; historical replies will not be rewritten`);
      const available = new Set(tools.map((tool) => tool.name));
      for (const call of turn.toolCalls) {
        if (!available.has(call.name)) throw new Error(`Recorded tool is unavailable: ${record.name}/${call.name}`);
      }
      replay.turnsServed[record.name] = (replay.turnsServed[record.name] ?? 0) + 1;
      // The original cached Turn is returned unchanged, including its explicit
      // interface-only zero counters. Recorded physical usage remains unknown.
      return structuredClone(turn);
    },
  };
}

describe('immutable recorded provider fixture', () => {
  it('has all eight ordered stages and an unchanged nontrivial brief', async () => {
    expect(manifest.kind).toBe('sequential-recorded-experimental-model-replay');
    expect(manifest.stages.map((stage) => stage.name)).toEqual(STAGES.map((stage) => stage.name));
    expect(sha256(await readFile(path.join(fixture, 'brief.txt')))).toBe(manifest.briefSha256);
    expect(manifest.stages.reduce((n, stage) => n + stage.turns.length, 0)).toBe(29);
    for (const record of manifest.stages) await recordedProvider(record);
  });
  it('terminates a wedged subprocess at a real external deadline', async () => {
    const result = await supervise(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: tmpdir(), timeoutMs: 150, stdio: 'ignore',
    });
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
  });
  it('rejects the real zero-symbol scaffold even when actual ERC is clean', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'copperhead-recorded-empty-'));
    try {
      await bootstrapKicadProject(root, '# Empty schematic false-green regression');
      const config = await loadConfig(root);
      expect(config.schematic).toBeTruthy();
      expect((await runErc(path.join(root, config.schematic!))).ok).toBe(true);
      expect(await STAGES.find((stage) => stage.name === 'schematic')!.isComplete(root, config.docs)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function executeRecordedPipeline(mode: 'complete' | 'missing-final') {
    expect(await kicadCliVersion(), 'this scoped profile requires a KiCad 9 environment').toMatch(/^9\./);
    const root = await mkdtemp(path.join(tmpdir(), 'copperhead-recorded-create-'));
    console.log(`Replay evidence preserved at ${root}`);
    await mkdir(path.join(root, '.copperhead'));
    await writeFile(path.join(root, '.copperhead/config.json'), JSON.stringify({
      docs: 'docs/', model: null, maxTurns: 5, maxRepairCycles: 0,
      maxStageRetries: 0, turnTimeoutMs: 30_000, turnMaxMs: 30_000,
      heartbeatMs: 0, llmCache: false,
    }, null, 2) + '\n');
    await writeFile(path.join(root, '.gitignore'), '.env\n.copperhead/runs/\n.copperhead/llm-cache/\n.history/\n');
    // An empty OpenSpec workspace is initialization, not a completed artifact.
    await mkdir(path.join(root, 'openspec'));
    for (const args of [['init', '-q'], ['config', 'user.name', 'Recorded Replay'],
      ['config', 'user.email', 'replay@copperhead.local'], ['add', '-A'],
      ['commit', '-q', '-m', 'brief-only replay configuration']]) {
      await execa('git', args, { cwd: root });
    }
    const before = (await execa('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout;
    const logs: string[] = [];
    replay.calls = []; replay.outcomes = []; replay.turnsServed = {};
    replay.providerFor = async (stage) => {
      const record = manifest.stages.find((item) => item.name === stage);
      if (!record) throw new Error(`No authentic recording for ${stage}`);
      return recordedProvider(record, mode === 'missing-final' && stage === 'devplan');
    };
    let result: Awaited<ReturnType<typeof runCreate>> | undefined;
    try {
      result = await runCreate({ repoRoot: root, briefPath: path.join(fixture, 'brief.txt'),
        model: 'recorded-experimental-replay', log: (line) => { logs.push(line); console.log(line); } });
    } finally {
      await mkdir(path.join(root, '.copperhead/runs'), { recursive: true });
      await writeFile(path.join(root, '.copperhead/runs/replay.log'), logs.join('\n') + '\n');
      await writeFile(path.join(root, '.copperhead/runs/replay-result.json'), JSON.stringify({
        kind: manifest.kind, recordedPhysicalUsage: 'unknown', result,
        stageCalls: replay.calls, turnsServed: replay.turnsServed, stageResults: replay.outcomes.map((r) => ({
          outcome: r.outcome, exitPath: r.exitPath, commit: r.commit, summary: r.summary,
        })),
      }, null, 2));
    }
    return { root, before, result, logs };
}

describe.skipIf(process.env.COPPERHEAD_TEST_RECORDED_CREATE !== '1')('real eight-stage recorded experimental replay', () => {
  it('creates and commits every stage from only a brief and configuration', async () => {
    const { root, before, result, logs } = await executeRecordedPipeline('complete');
    expect(result, `inspect ${root}/.copperhead/runs/replay.log`).toEqual({ ok: true, completed: STAGES.map((s) => s.name) });
    expect(replay.calls).toEqual(STAGES.map((s) => s.name));
    for (const stage of manifest.stages) expect(replay.turnsServed[stage.name], stage.name).toBe(stage.turns.length);
    expect(replay.outcomes.every((r) => r.outcome === 'success' && r.exitPath === 'done' && r.commit)).toBe(true);
    expect(new Set(replay.outcomes.map((r) => r.commit)).size).toBe(8);
    const subjects = (await execa('git', ['log', '--format=%s', `${before}..HEAD`], { cwd: root })).stdout.split('\n');
    for (const stage of STAGES) expect(subjects.filter((s) => s === `copperhead: create pipeline stage: ${stage.name}`)).toHaveLength(1);
    const config = await loadConfig(root);
    for (const stage of STAGES) expect(await stage.isComplete(root, config.docs), stage.name).toBe(true);
    expect(await outputsPackageGap(root, config)).toBeNull();
    expect((await runCheck(root, (s) => logs.push(s))).ok).toBe(true);
    expect((await execa('git', ['show', 'HEAD:docs/DEVPLAN.md'], { cwd: root })).stdout).toContain('##');
    expect((await execa('git', ['status', '--porcelain'], { cwd: root })).stdout).toBe('');
    const report = JSON.parse(await readFile(path.join(root, '.copperhead/runs/report.json'), 'utf8'));
    expect(report.stageCount).toBe(8); expect(report.ran).toBe(8); expect(report.resumed).toBe(0);
  }, 600_000);
  it('fails and does not commit devplan when its final recorded reply is omitted', async () => {
    const { root, before, result } = await executeRecordedPipeline('missing-final');
    expect(result).toEqual({ ok: false, completed: STAGES.slice(0, -1).map((stage) => stage.name) });
    expect(replay.calls).toEqual(STAGES.map((stage) => stage.name));
    const subjects = (await execa('git', ['log', '--format=%s', `${before}..HEAD`], { cwd: root })).stdout.split('\n');
    expect(subjects).not.toContain('copperhead: create pipeline stage: devplan');
    expect(replay.outcomes.at(-1)?.outcome).not.toBe('success');
    expect(replay.turnsServed.devplan).toBe(2);
    expect(await STAGES.find((stage) => stage.name === 'devplan')!.isComplete(root, 'docs/')).toBe(false);
    expect((await execa('git', ['status', '--porcelain'], { cwd: root })).stdout).toBe('');
  }, 600_000);
});
