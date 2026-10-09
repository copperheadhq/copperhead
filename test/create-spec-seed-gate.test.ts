import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import type { Msg, Provider, ToolCall, Turn } from '../src/agent/types.js';

// Inject only the provider at create's existing agent-loop seam. Every run still
// executes the real loop, tool dispatcher, finish handler, snapshot and commit.
const offline = vi.hoisted(() => ({
  provider: undefined as Provider | undefined,
  calls: [] as RunOptions[],
  results: [] as RunResult[],
}));
vi.mock('../src/agent/loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/loop.js')>();
  return {
    ...actual,
    makeProvider: async () => { throw new Error('This regression must never request a real provider'); },
    runAgentLoop: async (opts: RunOptions) => {
      if (!offline.provider) throw new Error('Missing offline fixture provider');
      offline.calls.push(opts);
      const result = await actual.runAgentLoop({ ...opts, provider: offline.provider });
      offline.results.push(result);
      return result;
    },
  };
});
// Do not let create's housekeeping inspect or remove other runs' temp files.
vi.mock('../src/util/tmp.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sweepStaleTempDirs: async () => [],
  pruneHistoryDir: async () => 0,
}));

import { runCreate, specDocGap, STAGES } from '../src/commands/create.js';

const specSeed = STAGES.find((stage) => stage.name === 'spec-seed')!;
const REQUIREMENTS_HEADING = '## Requirements and constraints';
const REQUIREMENTS_SPEC = `# USB-C power breakout

${REQUIREMENTS_HEADING}

- input_voltage_V: 5
- output_current_mA: 500
- board_width_mm: 30

## Assumptions

- No USB data connectivity (ASSUMED).
`;
const REPAIRED_SPEC = REQUIREMENTS_SPEC.replace(REQUIREMENTS_HEADING, '## Budgets');
const roots: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'copperhead-spec-gate-'));
  roots.push(root);
  return root;
}

async function writeSpec(root: string, docs: string, content: string): Promise<void> {
  await mkdir(path.join(root, docs), { recursive: true });
  await writeFile(path.join(root, docs, 'SPEC.md'), content, 'utf8');
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execa('git', args, { cwd: root })).stdout;
}

afterEach(async () => {
  offline.provider = undefined;
  offline.calls = [];
  offline.results = [];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('spec-seed preserves its contract and explains the missing artifact', () => {
  it('rejects real budget numbers under Requirements and constraints until the heading is repaired', async () => {
    const root = await freshRoot();
    await writeSpec(root, 'docs', REQUIREMENTS_SPEC);
    expect(await specSeed.isComplete(root, 'docs')).toBe(false);
    expect(await specDocGap(root, 'docs')).toBe(
      'docs/SPEC.md has no Budget or Budgets heading; add a "## Budgets" section with the actual budget constraints',
    );

    // Content is unchanged: the fix exposes the existing structural contract,
    // rather than accepting every document that happens to contain numbers.
    await writeSpec(root, 'docs', REPAIRED_SPEC);
    expect(await specSeed.isComplete(root, 'docs')).toBe(true);
    expect(await specDocGap(root, 'docs')).toBeNull();
  });

  it('names an absent SPEC and the section the agent needs to write', async () => {
    const root = await freshRoot();
    expect(await specSeed.isComplete(root, 'docs/')).toBe(false);
    expect(await specDocGap(root, 'docs/')).toBe(
      'docs/SPEC.md is missing; write it with a non-empty "## Budgets" section',
    );
  });

  it.each([
    ['heading only', '## Budgets\n\n'],
    ['scaffold placeholder', '## Budgets\n\n<!-- Add hard budgets here -->\n'],
    ['commented numbers', '## Budgets\n<!--\n- input_voltage_V: 5\n-->\n'],
    ['subheadings only', '## Budgets\n### Input\n\n### Output\n'],
    ['sibling prose', '## Budgets\n<!-- TODO -->\n## Requirements\n- input_voltage_V: 5\n'],
    ['shallower prose', '### Budgets\n<!-- TODO -->\n## Requirements\n- input_voltage_V: 5\n'],
    ['first budget section empty', '## Budget\n<!-- TODO -->\n## Budgets\n- input_voltage_V: 5\n'],
  ])('rejects an empty budget body: %s', async (_label, body) => {
    const root = await freshRoot();
    await writeSpec(root, 'docs', `# Spec\n\n${body}`);
    expect(await specSeed.isComplete(root, 'docs')).toBe(false);
    expect(await specDocGap(root, 'docs')).toBe(
      'docs/SPEC.md has an empty budget section; add real budget content, not only comments or subheadings',
    );
  });

  it.each([
    ['singular', '## Budget\n- input_voltage_V: 5\n'],
    ['numbered and case-insensitive', '## 3. Electrical BUDGETS and constraints\n- input_voltage_V: 5\n'],
    ['nested content', '## Budgets\n### Input\n<!-- note -->\n- input_voltage_V: 5\n'],
  ])('keeps accepting previously valid headings and bodies: %s', async (_label, body) => {
    const root = await freshRoot();
    await writeSpec(root, 'docs', `# Spec\n\n${body}`);
    expect(await specDocGap(root, 'docs')).toBeNull();
    expect(await specSeed.isComplete(root, 'docs')).toBe(true);
  });

  it('reads the configured docs directory, including a repository-root docs directory', async () => {
    const root = await freshRoot();
    await writeSpec(root, 'docs', REPAIRED_SPEC);
    await writeSpec(root, '.', REPAIRED_SPEC);
    expect(await specSeed.isComplete(root, 'design/notes')).toBe(false);
    expect(await specDocGap(root, 'design/notes')).toContain('design/notes/SPEC.md is missing');
    await writeSpec(root, 'design/notes', REQUIREMENTS_SPEC);
    expect(await specDocGap(root, 'design/notes')).toContain('design/notes/SPEC.md has no Budget');
    await writeSpec(root, 'design/notes', REPAIRED_SPEC);
    expect(await specDocGap(root, 'design/notes')).toBeNull();
    expect(await specSeed.isComplete(root, 'design/notes')).toBe(true);
    expect(await specSeed.isComplete(root, '.')).toBe(true);
  });

  it('tells the model to supply a nonempty Budgets section and dual-write constraints', () => {
    const prompt = specSeed.prompt('A USB-C power breakout', 'docs');
    expect(prompt).toContain('"## Budgets" section');
    expect(prompt).toContain('real budget content beneath the heading');
    expect(prompt).toContain('not just an empty placeholder');
    expect(prompt).toContain('record_constraint');
    expect(prompt).toContain('A USB-C power breakout');
  });
});

async function docsOnlyRepo(docs: string): Promise<{ root: string; head: string; briefPath: string }> {
  const root = await freshRoot();
  await mkdir(path.join(root, '.copperhead'));
  // Existing directory makes openspecInit a no-op. With no config.yaml,
  // validate_change uses its real structural check, with no external CLI.
  await mkdir(path.join(root, 'openspec'));
  await writeFile(path.join(root, 'openspec', '.gitkeep'), '', 'utf8');
  await writeFile(path.join(root, '.copperhead', 'config.json'), JSON.stringify({
    docs, schematic: null, board: null, origin: 'create',
    maxTurns: 3, maxStageRetries: 0, llmCache: false,
  }), 'utf8');
  await writeFile(path.join(root, '.gitignore'), '.env\n.copperhead/runs/\n.history/\n', 'utf8');
  const briefPath = path.join(root, 'brief.md');
  await writeFile(briefPath, '# USB-C power breakout\n', 'utf8');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@copperhead.local');
  await git(root, 'config', 'user.name', 'copperhead-test');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'offline fixture');
  return { root, head: await git(root, 'rev-parse', 'HEAD'), briefPath };
}

function scriptedProvider(
  steps: ((messages: Msg[]) => Promise<Omit<ToolCall, 'id'>[]> | Omit<ToolCall, 'id'>[])[],
): Provider & { seen: Msg[][] } {
  let index = 0;
  const seen: Msg[][] = [];
  return {
    name: 'OFFLINE-spec-seed-regression',
    seen,
    async chat(messages): Promise<Turn> {
      seen.push([...messages]);
      const step = steps[index++];
      if (!step) throw new Error('Unexpected provider call outside the offline script');
      const calls = await step(messages);
      return {
        text: null,
        toolCalls: calls.map((call, i) => ({ ...call, id: `offline-${index}-${i}` })),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

const finish = { name: 'finish', args: { outcome: 'done', summary: 'Requirements seeded' } };
const checkDrift = { name: 'check_drift', args: {} };
const propose = () => [
  { name: 'propose_change', args: {
    id: 'seed-spec', why: 'Seed the brief requirements',
    what_changes: '- Write the specification and constraints', tasks: '- [ ] Seed requirements',
  } },
  { name: 'validate_change', args: {} },
];
const seed = (specPath: string) => [
  { name: 'write_file', args: { path: specPath, content: REQUIREMENTS_SPEC } },
  ...Object.entries({ input_voltage_V: 5, output_current_mA: 500, board_width_mm: 30 }).map(([key, max]) => ({
    name: 'record_constraint', args: { key, max, source: specPath, affects: [] },
  })),
  checkDrift,
  finish,
];

describe('create spec-seed finish and commit, with a deterministic OFFLINE provider', () => {
  it.each(['docs', 'design/notes'])('blocks finish and commits nothing when %s/SPEC.md still lacks the heading', async (docs) => {
    const { root, head, briefPath } = await docsOnlyRepo(docs);
    const specPath = path.posix.join(docs, 'SPEC.md');
    const provider = scriptedProvider([
      propose,
      () => seed(specPath),
      async (messages) => {
        const feedback = messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n');
        expect(feedback).toContain('cannot finish yet');
        expect(feedback).toContain(`${specPath} has no Budget or Budgets heading`);
        expect(feedback).not.toContain('all gates satisfied');
        expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
        expect(await readFile(path.join(root, specPath), 'utf8')).toBe(REQUIREMENTS_SPEC);
        return [finish];
      },
    ]);
    offline.provider = provider;

    const result = await runCreate({ repoRoot: root, briefPath, model: 'offline-test', log: () => {}, meta: { kicadCliVersion: 'offline: not needed' } });
    expect(result).toEqual({ ok: false, completed: [] });
    expect(offline.calls).toHaveLength(1);
    expect(typeof offline.calls[0]!.stageGate).toBe('function');
    expect(provider.seen).toHaveLength(3);
    expect(offline.results[0]).toMatchObject({ outcome: 'failure', exitPath: 'turn-budget-exhausted', commit: null });
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'status', '--porcelain')).toBe('');
    expect(existsSync(path.join(root, specPath))).toBe(false); // failed-run rollback
  });

  it('commits the spec stage only after the provider sees the gap and repairs the heading in the same run', async () => {
    const docs = 'design/notes';
    const { root, head, briefPath } = await docsOnlyRepo(docs);
    const specPath = `${docs}/SPEC.md`;
    const provider = scriptedProvider([
      propose,
      () => seed(specPath),
      async (messages) => {
        const feedback = messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n');
        expect(feedback).toContain('cannot finish yet');
        expect(feedback).toContain(`${specPath} has no Budget or Budgets heading`);
        expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
        return [
          { name: 'edit_file', args: { path: specPath, old_string: REQUIREMENTS_HEADING, new_string: '## Budgets' } },
          checkDrift,
          finish,
        ];
      },
      // Stop at the next stage: this regression makes no claim about the rest
      // of the eight-stage pipeline and never enters KiCad or a real model.
      () => [{ name: 'finish', args: { outcome: 'refuse', summary: 'Offline test stops after spec-seed' } }],
    ]);
    offline.provider = provider;

    const result = await runCreate({ repoRoot: root, briefPath, model: 'offline-test', log: () => {}, meta: { kicadCliVersion: 'offline: not needed' } });
    expect(result).toEqual({ ok: false, completed: ['spec-seed'] });
    expect(offline.calls.map((call) => call.request)).toEqual(['create pipeline stage: spec-seed', 'create pipeline stage: architecture']);
    expect(typeof offline.calls[0]!.stageGate).toBe('function');
    expect(provider.seen).toHaveLength(4);
    const committed = offline.results[0]!;
    expect(committed).toMatchObject({ outcome: 'success', exitPath: 'done', stats: { turnsUsed: 3 } });
    expect(committed.commit).toBeTruthy();
    expect(committed.commit).toBe(await git(root, 'rev-parse', 'HEAD'));
    expect(await git(root, 'rev-list', '--count', `${head}..HEAD`)).toBe('1');
    expect(await git(root, 'show', `HEAD:${specPath}`)).toBe(REPAIRED_SPEC.trimEnd());
    expect(await readFile(path.join(root, specPath), 'utf8')).toBe(REPAIRED_SPEC);
    expect(await specSeed.isComplete(root, docs)).toBe(true);
    expect(await specDocGap(root, docs)).toBeNull();
    const transcript = await readFile(path.join(committed.transcriptDir, 'transcript.jsonl'), 'utf8');
    expect(transcript).toContain('cannot finish yet');
    expect(transcript).toContain('all gates satisfied; run will commit');
    expect(transcript).toContain('run-committed');
  });
});
