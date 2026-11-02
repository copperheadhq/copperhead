import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import type { RunOptions } from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { runCreate } from '../src/commands/create.js';
import { parseBomTable } from '../src/memory/bom-table.js';
import { PART_CACHE_PATH } from '../src/util/git.js';
import { partCachePath } from '../src/util/part-cache.js';
import { tempFixtureRepo } from './helpers.js';

const SYMLIB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'symlib');

/** Per-attempt scripts for the part-selection stage, plus what each attempt was given. */
const script = vi.hoisted(() => ({
  attempts: [] as Array<{ stagePrompt: string | undefined; maxTurns: number | undefined }>,
  providers: [] as Array<() => unknown>,
}));
const mockDiagnosis = vi.hoisted(() => vi.fn());

// The real agent loop runs; only its provider seam is filled with a scripted
// model, so dispatch, onToolResult, snapshot, and rollback are all exercised.
vi.mock('../src/agent/loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/loop.js')>();
  return {
    ...actual,
    makeProvider: async () => ({ name: 'unused', chat: async () => ({}) }),
    runAgentLoop: async (opts: RunOptions) => {
      const index = script.attempts.length;
      script.attempts.push({ stagePrompt: opts.stagePrompt, maxTurns: opts.maxTurns });
      const make = script.providers[index];
      if (!make) throw new Error(`no scripted provider for attempt ${index + 1}`);
      return actual.runAgentLoop({ ...opts, provider: make() as Provider });
    },
  };
});
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  diagnoseStageFailure: mockDiagnosis,
}));
vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: async () => ({ ok: true, output: 'mocked' }),
}));
vi.mock('../src/commands/check.js', () => ({
  runCheck: async () => ({ ok: true }),
}));
vi.mock('../src/kicad/bootstrap.js', () => ({
  bootstrapKicadProject: async () => null,
  markCreateOrigin: async () => {},
}));

class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  private index = 0;

  constructor(
    private readonly turns: Turn[],
    private readonly beforeTurn?: (index: number) => Promise<void>,
  ) {}

  async chat(_messages: Msg[]): Promise<Turn> {
    await this.beforeTurn?.(this.index);
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)]!;
    this.index++;
    return turn;
  }
}

const usage = { inputTokens: 10, outputTokens: 5 };
const call = (name: string, args: Record<string, unknown>): Turn => ({
  text: null,
  toolCalls: [{ id: name, name, args }],
  usage,
});
const finish = (outcome: 'done' | 'refuse', summary: string): Turn => call('finish', { outcome, summary });

/** What `copperhead init` scaffolds for a project with no schematic yet: the header only. */
const SCAFFOLD_BOM = '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n';

/** A 100-row BOM, the failed attempt's output: one active part and 99 resistors. */
const LARGE_BOM = [
  '# BOM',
  '',
  '| Refdes | Value | Footprint | MPN | Rationale |',
  '|---|---|---|---|---|',
  '| U1 | MCU8 | TestLib:FP_A | MCU8 | controller |',
  ...Array.from({ length: 99 }, (_, i) => `| R${i + 1} | 10k | TestLib:R_0603 | RC0603-10K | pull-up ${i + 1} |`),
  '',
].join('\n');

async function setupRepo(bom: string | null): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const fixture = await tempFixtureRepo();
  const { repo } = fixture;
  const docs = path.join(repo, 'docs');
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(repo, 'brief.md'), '# Controller board\n', 'utf8');
  await writeFile(path.join(docs, 'SPEC.md'), '# Spec\n\n## Budgets\n\n- current: 100 mA\n', 'utf8');
  await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# Architecture\n\n## Control\n\nOne MCU.\n', 'utf8');
  if (bom !== null) await writeFile(path.join(docs, 'BOM.md'), bom, 'utf8');
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'create pipeline at part selection'], { cwd: repo });
  return fixture;
}

let footprints: string;
let kicadConfig: string;

beforeEach(async () => {
  script.attempts = [];
  script.providers = [];
  mockDiagnosis.mockReset();
  mockDiagnosis.mockImplementation(async (_provider: unknown, input: { stageName: string; attempt: number }) =>
    input.stageName === 'part-selection' && input.attempt === 1
      ? { verdict: 'retry', reason: 'the cache should let the next attempt finish', guidance: 'Continue.' }
      : { verdict: 'abort', reason: 'stop after the part-selection retry' },
  );
  // A one-library footprint install and an empty KiCad config, so check_footprints
  // resolves the same ids on every machine.
  footprints = await mkdtemp(path.join(tmpdir(), 'copperhead-446-fp-'));
  await mkdir(path.join(footprints, 'TestLib.pretty'), { recursive: true });
  await writeFile(
    path.join(footprints, 'TestLib.pretty', 'FP_A.kicad_mod'),
    '(footprint "FP_A"\n  (layer "F.Cu")\n  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))\n)\n',
    'utf8',
  );
  kicadConfig = await mkdtemp(path.join(tmpdir(), 'copperhead-446-cfg-'));
  vi.stubEnv('KICAD_SYMBOL_DIR', SYMLIB);
  vi.stubEnv('KICAD_FOOTPRINT_DIR', footprints);
  vi.stubEnv('KICAD_CONFIG_HOME', kicadConfig);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(footprints, { recursive: true, force: true });
  await rm(kicadConfig, { recursive: true, force: true });
});

describe('issue #446 part-selection retry through runCreate and the real agent loop', () => {
  it('sizes the retry from the rolled-back attempt and injects its cached verification', async () => {
    const { repo, cleanup } = await setupRepo(SCAFFOLD_BOM);
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      // attempt 1: writes the large BOM (the model's write, done directly here),
      // verifies U1, then refuses for want of turns until the escalation cap
      // ends it as turn-budget-exhausted, which rolls the tree back
      script.providers.push(
        () =>
          new ScriptedProvider(
            [
              call('search_symbols', { query: 'MCU8' }),
              call('symbol_pins', { lib_id: 'CopperMCU:MCU8' }),
              call('check_footprints', { footprints: ['TestLib:FP_A'] }),
              finish('refuse', "I can't finish the BOM in the turns left"),
            ],
            async (index) => {
              if (index === 0) await writeFile(bomPath, LARGE_BOM, 'utf8');
            },
          ),
      );
      // attempt 2: stops at once; its inputs are what this test checks
      script.providers.push(() => new ScriptedProvider([finish('refuse', 'design gap: stop for the test')]));

      const res = await runCreate({ repoRoot: repo, briefPath: path.join(repo, 'brief.md'), model: 'gpt-5', log: () => {} });

      expect(res.ok).toBe(false);
      expect(script.attempts).toHaveLength(2);
      const [first, second] = script.attempts;
      // the stage starts from the 0-row scaffold: the configured default
      expect(first!.maxTurns).toBe(40);
      expect(first!.stagePrompt).not.toContain('Cached part-selection verification');
      // the rollback put the scaffold back...
      expect(parseBomTable(await readFile(bomPath, 'utf8'))).toHaveLength(0);
      // ...yet the retry is sized from the failed attempt's 100 rows: ceil(100 * 0.4) + 10
      expect(second!.maxTurns).toBe(50);
      // and carries its verified part as one compact line
      expect(second!.stagePrompt).toContain('## Cached part-selection verification');
      expect(second!.stagePrompt).toMatch(
        /^- U1: MCU8; CopperMCU:MCU8; \d+ pins; footprint TestLib:FP_A OK; fully verified$/m,
      );
      expect(second!.stagePrompt).not.toContain('installed symbols matching');
      // the cache survived the rollback under the default target .gitignore
      expect(existsSync(partCachePath(repo))).toBe(true);
      // (split on CRLF too: the rollback's checkout honors core.autocrlf)
      expect((await readFile(path.join(repo, '.gitignore'), 'utf8')).split(/\r?\n/)).toContain(PART_CACHE_PATH);
      const tracked = (await execa('git', ['ls-files'], { cwd: repo })).stdout;
      expect(tracked).not.toContain(PART_CACHE_PATH);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('records nothing for failed tool results or while BOM.md is absent', async () => {
    const { repo, cleanup } = await setupRepo(null);
    try {
      mockDiagnosis.mockResolvedValue({ verdict: 'abort', reason: 'one attempt is enough here' });
      script.providers.push(
        () =>
          new ScriptedProvider([
            call('not_a_tool', {}),
            call('search_symbols', { query: 'MCU8' }),
            finish('refuse', 'design gap: stop for the test'),
          ]),
      );

      const res = await runCreate({ repoRoot: repo, briefPath: path.join(repo, 'brief.md'), model: 'gpt-5', log: () => {} });

      expect(res.ok).toBe(false);
      expect(script.attempts).toHaveLength(1);
      expect(script.attempts[0]!.maxTurns).toBe(40);
      expect(existsSync(partCachePath(repo))).toBe(false);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
