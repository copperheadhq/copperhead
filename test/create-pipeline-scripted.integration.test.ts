import { describe, expect, it, vi, type TestContext } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { Msg, Provider, ToolCall, ToolSchema, Turn } from '../src/agent/types.js';
import { KicadCliMissingError, kicadCliVersion } from '../src/kicad/cli.js';
import { listSymbols } from '../src/kicad/sexp.js';

// Keep this an offline integration test. It exercises the real create pipeline,
// agent loop, tool dispatch, stage contracts, rollback, and git commits. Only
// OpenSpec workspace initialization is suppressed because it is unrelated and
// may invoke an optional external CLI.
vi.mock('../src/openspec/cli.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openspecInit: async () => ({ ok: true, output: 'mocked for offline pipeline test' }),
}));

import { runCreate, writeBriefHash } from '../src/commands/create.js';

const usage = { inputTokens: 1, outputTokens: 1 };

function turn(...toolCalls: ToolCall[]): Turn {
  return { text: null, toolCalls, usage };
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, args };
}

/** Deterministic mock model. Exhaustion is an assertion failure, never a fallback. */
class ScriptedProvider implements Provider {
  readonly name = 'scripted-offline-mock';
  readonly seenTools: string[][] = [];
  private index = 0;

  constructor(private readonly turns: Turn[]) {}

  async chat(_messages: Msg[], tools: ToolSchema[]): Promise<Turn> {
    const next = this.turns[this.index++];
    if (!next) throw new Error('script exhausted: an unplanned provider call cannot fall back to the network');
    const offered = new Set(tools.map((tool) => tool.name));
    for (const toolCall of next.toolCalls) {
      if (!offered.has(toolCall.name)) throw new Error(`script requested unavailable tool: ${toolCall.name}`);
    }
    this.seenTools.push([...offered]);
    return next;
  }

  get calls(): number {
    return this.index;
  }
}

interface Invocation {
  stage: string;
  attempt: number;
  provider: ScriptedProvider;
}

function providerFactoryFor(scripts: Record<string, Turn[]>, invocations: Invocation[]) {
  return (stage: string, attempt: number): Provider => {
    const script = scripts[stage];
    if (!script) throw new Error(`unexpected stage requested a provider: ${stage}`);
    if (attempt !== 1) throw new Error(`unexpected retry could reach a provider: ${stage} attempt ${attempt}`);
    const provider = new ScriptedProvider(script);
    invocations.push({ stage, attempt, provider });
    return provider;
  };
}

async function initGitRepo(repo: string): Promise<void> {
  await execa('git', ['init', '-q'], { cwd: repo });
  await execa('git', ['config', 'user.email', 'test@copperhead.local'], { cwd: repo });
  await execa('git', ['config', 'user.name', 'copperhead-test'], { cwd: repo });
}

async function commitSetup(repo: string, message = 'scripted pipeline fixture'): Promise<void> {
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '--no-verify', '-m', message], { cwd: repo });
}

async function configureOfflineCreate(repo: string): Promise<void> {
  const configPath = path.join(repo, '.copperhead', 'config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  const current = await readFile(configPath, 'utf8').catch(() => '{}');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...JSON.parse(current),
        origin: 'create',
        maxTurns: 10,
        maxStageRetries: 0,
        turnTimeoutMs: 1_000,
        heartbeatMs: 0,
        llmCache: false,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

async function makeEmptyRepo(): Promise<{ repo: string; briefPath: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-scripted-empty-'));
  await initGitRepo(repo);
  await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n.history/\n', 'utf8');
  const briefPath = path.join(repo, 'brief.md');
  await writeFile(briefPath, '# Offline scripted pipeline test\n', 'utf8');
  await configureOfflineCreate(repo);
  return { repo, briefPath, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

async function seedCompletedDocStages(repo: string): Promise<void> {
  const docs = path.join(repo, 'docs');
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, 'SPEC.md'), '# Spec\n\n## Budgets\n\n- current_mA: 100\n', 'utf8');
  await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# Subsystems\n\n## Core\n\nInput and control logic.\n', 'utf8');
  await writeFile(
    path.join(docs, 'BOM.md'),
    '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | TEST-MPN | fixture part |\n',
    'utf8',
  );
}

async function transcriptEvents(repo: string): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const runs = path.join(repo, '.copperhead', 'runs');
  const files = await readdir(runs, { recursive: true });
  const transcript = files.find((file) => file.endsWith('transcript.jsonl'));
  if (!transcript) throw new Error('missing transcript.jsonl');
  return (await readFile(path.join(runs, transcript), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
}

async function requireKicad(context: TestContext): Promise<boolean> {
  try {
    await kicadCliVersion();
    return true;
  } catch (error) {
    if (!(error instanceof KicadCliMissingError)) throw error;
    context.skip('requires kicad-cli for real ERC/export verification');
    return false;
  }
}

describe('create pipeline with a deterministic scripted provider (mocked, offline)', () => {
  it('stops and rolls back when the first stage wedges for three consecutive tool-less turns', async () => {
    const { repo, briefPath, cleanup } = await makeEmptyRepo();
    try {
      await commitSetup(repo);
      const invocations: Invocation[] = [];
      const providerFactory = providerFactoryFor(
        {
          'spec-seed': [
            { text: 'thinking', toolCalls: [], usage },
            { text: 'still thinking', toolCalls: [], usage },
            { text: 'stuck', toolCalls: [], usage },
          ],
        },
        invocations,
      );

      const before = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout;
      const result = await runCreate({ repoRoot: repo, briefPath, model: 'network-must-not-run', providerFactory, log: () => {} });

      expect(result).toEqual({ ok: false, completed: [] });
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({ stage: 'spec-seed', attempt: 1 });
      expect(invocations[0]!.provider.calls).toBe(3);
      expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout).toBe(before);
      expect((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout).toBe('');
      const end = (await transcriptEvents(repo)).find((event) => event.type === 'run-end');
      expect(end?.data.exitPath).toBe('stalled');
    } finally {
      await cleanup();
    }
  });

  it('rejects an ERC-green but zero-symbol schematic instead of advancing to layout', async (context) => {
    if (!(await requireKicad(context))) return;
    const { repo, briefPath, cleanup } = await makeEmptyRepo();
    try {
      await seedCompletedDocStages(repo);
      await writeBriefHash(repo, 'docs/', {
        path: 'brief.md',
        sha256: createHash('sha256').update(await readFile(briefPath, 'utf8')).digest('hex'),
      });
      await commitSetup(repo);
      const invocations: Invocation[] = [];
      const providerFactory = providerFactoryFor(
        {
          schematic: [
            turn(
              call('erc', 'run_erc'),
              call('finish', 'finish', { outcome: 'done', summary: 'ERC is green on the empty scaffold' }),
            ),
          ],
        },
        invocations,
      );

      const lines: string[] = [];
      const result = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'network-must-not-run',
        providerFactory,
        log: (line) => lines.push(line),
      });

      expect(result).toEqual({ ok: false, completed: ['spec-seed', 'architecture', 'part-selection'] });
      expect(invocations.map(({ stage, attempt }) => ({ stage, attempt }))).toEqual([{ stage: 'schematic', attempt: 1 }]);
      const config = JSON.parse(await readFile(path.join(repo, '.copperhead', 'config.json'), 'utf8')) as { schematic: string };
      expect(await listSymbols(path.join(repo, config.schematic))).toHaveLength(0);
      const ercEvent = (await transcriptEvents(repo)).find(
        (event) => event.type === 'tool' && event.data.name === 'run_erc',
      );
      expect(ercEvent?.data.result).toContain('ERC: clean');
      expect(ercEvent?.data.result).toContain('ZERO symbols');
      expect(ercEvent?.data.result).toContain('NOT a verified design');
      expect(lines.join('\n')).toContain('stopped at stage 4/8 (schematic)');
      expect(lines.join('\n')).not.toContain('layout-draft running');
    } finally {
      await cleanup();
    }
  }, 60_000);

});
