import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableTools, dispatchTool, dispatchToolResult, registry, runSkillSubRun } from '../src/agent/tools.js';
import { flatten } from '../src/agent/envelope.js';
import { defineSkill } from '../src/capabilities/define.js';
import { ToolRegistry } from '../src/agent/registry.js';
import {
  runSkill,
  listSkills,
  catalogNameFromCli,
  providerForSkillRun,
  formatSkillEnvelope,
} from '../src/commands/skill.js';
import { parseToolCalls } from '../src/agent/providers/tool-protocol.js';
import type { Provider, Turn } from '../src/agent/types.js';
import { runInit } from '../src/memory/scaffold.js';
import { loadConfig } from '../src/config.js';
import { Transcript } from '../src/agent/transcript.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import type { RunContext } from '../src/agent/context.js';
import { tempFixtureRepo } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  private i = 0;
  calls = 0;
  constructor(private readonly turns: Turn[]) {}
  async chat(): Promise<Turn> {
    this.calls++;
    const t = this.turns[Math.min(this.i, this.turns.length - 1)]!;
    this.i++;
    return t;
  }
}

async function makeCtx(repo: string, unlocked = false): Promise<RunContext> {
  const transcript = new Transcript(repo);
  await transcript.init();
  return {
    repoRoot: repo,
    config: await loadConfig(repo),
    transcript,
    ledger: new ObligationsLedger(),
    runId: 'reg',
    interactive: false,
    confirm: async () => true,
    editsUnlocked: unlocked,
    changeId: null,
    proposalValidated: unlocked,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    lastLegibility: null,
    lastScore: null,
    lastDrift: null,
    repairCycles: 0,
    finishRequest: null,
  };
}

const reportTurn = (): Turn => ({
  text: null,
  toolCalls: [
    { id: '1', name: 'run_erc', args: {} },
    { id: '2', name: 'run_drc', args: {} },
    { id: '3', name: 'check_drift', args: {} },
    { id: '4', name: 'list_nets', args: {} },
  ],
  usage: { inputTokens: 1, outputTokens: 1 },
});

describe('tool-registry catalog', () => {
  it('exposes a positive protocol version and rejects duplicate names', () => {
    expect(registry.protocolVersion).toBeGreaterThanOrEqual(1);
    const first = registry.all()[0]!;
    expect(() => new ToolRegistry([first, first])).toThrow(/duplicate catalog name/);
  });

  it('combined catalog: read tools and generate_report present, edits absent while locked', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const names = registry.list(ctx).map((e) => e.name);
      expect(names).toContain('read_file');
      expect(names).toContain('generate_report');
      expect(names).not.toContain('edit_file');
      expect(names).not.toContain('write_file');
    } finally {
      await cleanup();
    }
  });

  it('unknown name is unavailable; dispatch of generate_report is a skill', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const miss = await dispatchToolResult(ctx, 'not_a_tool', {});
      expect(miss.error?.kind).toBe('unavailable');
      const skill = registry.get('generate_report');
      expect(skill?.kind).toBe('skill');
      ctx.lastErc = { ok: true, source: 'erc', violations: [] };
      ctx.lastDrc = { ok: true, source: 'drc', violations: [] };
      ctx.lastDrift = 'drift: clean';
      const provider = new ScriptedProvider([reportTurn()]);
      const env = await dispatchToolResult(ctx, 'generate_report', { scope: 'all' }, {
        provider,
      });
      expect(env.detail ?? env.summary).toBeTruthy();
      expect(provider.calls).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('a skill without a provider returns a validation envelope', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const env = await dispatchToolResult(ctx, 'generate_report', {});
      expect(env.ok).toBe(false);
      expect(env.error?.kind).toBe('validation');
      expect(flatten(env)).toContain('requires a provider');
    } finally {
      await cleanup();
    }
  });

  it('an off-list skill tool names the real reason, not the proposal lock', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const env = await dispatchToolResult(ctx, 'edit_file', {}, { only: new Set(['read_file']) });
      expect(flatten(env)).toContain('not part of this skill');
      expect(flatten(env)).not.toContain('proposal validates');
    } finally {
      await cleanup();
    }
  });

  it('unlock is presence of edit tools', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      expect(availableTools(ctx).map((t) => t.name)).not.toContain('edit_file');
      ctx.editsUnlocked = true;
      expect(availableTools(ctx).map((t) => t.name)).toContain('edit_file');
    } finally {
      await cleanup();
    }
  });

  it('a skill listing edit_file is absent while locked', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const smuggle = defineSkill({
        schema: { name: 'smuggle_edits', description: 'x', parameters: { type: 'object', properties: {} } },
        version: 1,
        viewHint: 'mutation',
        tools: ['edit_file', 'read_file'],
        prompt: () => '',
        isComplete: () => true,
      });
      const reg = new ToolRegistry([...registry.all(), smuggle]);
      expect(reg.list(ctx).map((e) => e.name)).not.toContain('smuggle_edits');
    } finally {
      await cleanup();
    }
  });

  it('generate_report cannot write and its report is the envelope', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const skill = registry.get('generate_report');
      expect(skill?.kind).toBe('skill');
      if (skill?.kind !== 'skill') return;
      expect(skill.tools).not.toContain('edit_file');
      expect(skill.tools).not.toContain('write_file');
      expect(skill.tools).not.toContain('propose_change');
      expect(skill.tools).not.toContain('finish');
      const before = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      const result = await runSkill({
        repoRoot: repo,
        name: 'generate-report',
        provider: new ScriptedProvider([reportTurn()]),
      });
      expect(result.summary.length).toBeGreaterThan(0);
      expect(skill.tools.every((n) => !['edit_file', 'write_file'].includes(n))).toBe(true);
      const after = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      expect(after.stdout).toBe(before.stdout);
    } finally {
      await cleanup();
    }
  });

  it('nested skill does not set parent finishRequest', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.finishRequest = { outcome: 'done', summary: 'parent' };
      await dispatchToolResult(ctx, 'generate_report', {}, { provider: new ScriptedProvider([reportTurn()]) });
      expect(ctx.finishRequest).toEqual({ outcome: 'done', summary: 'parent' });
    } finally {
      await cleanup();
    }
  });

  it('validation results are not retried (empty search is one validation envelope)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const r = await dispatchToolResult(ctx, 'search', { pattern: '' });
      expect(r.error?.kind).toBe('validation');
      expect(flatten(r)).toContain('pattern');
    } finally {
      await cleanup();
    }
  });

  it('a failing diagnostic carries ok false instead of a success glyph', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await writeFile(path.join(repo, 'docs', 'BOM.md'), '| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R2 | wrong | x | x | x |\n');
      const ctx = await makeCtx(repo);
      const env = await dispatchToolResult(ctx, 'check_drift', {});
      expect(env.ok).toBe(false);
      expect(flatten(env)).toContain('claims');
    } finally {
      await cleanup();
    }
  });

  it('a thrown 429 retries through withRetry; a plain exception surfaces once (design D10)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const entry = registry.get('list_nets');
      expect(entry?.kind).toBe('tool');
      if (entry?.kind !== 'tool') return;
      const orig = entry.handler;
      try {
        let rateLimited = 0;
        entry.handler = async () => {
          rateLimited++;
          if (rateLimited < 3) throw Object.assign(new Error('rate limited'), { status: 429 });
          return { ok: true, summary: 'nets: 2' };
        };
        const recovered = await dispatchToolResult(ctx, 'list_nets', {});
        expect(recovered.ok).toBe(true);
        expect(rateLimited).toBe(3);

        let plain = 0;
        entry.handler = async () => {
          plain++;
          throw new Error('kicad-cli exploded');
        };
        const failed = await dispatchToolResult(ctx, 'list_nets', {});
        expect(failed.error?.kind).toBe('exception');
        expect(plain).toBe(1);
      } finally {
        entry.handler = orig;
      }
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('a provider throw inside a skill sub-run becomes an exception envelope', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const exploding: Provider = {
        name: 'exploding',
        async chat() {
          throw new Error('provider 502');
        },
      };
      const env = await dispatchToolResult(ctx, 'generate_report', {}, { provider: exploding });
      expect(env.ok).toBe(false);
      expect(env.error?.kind).toBe('exception');
      expect(flatten(env)).toContain('provider 502');
    } finally {
      await cleanup();
    }
  });

  it('a skill provider 429 retries with backoff and then resumes the sub-run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      let calls = 0;
      const skill = defineSkill({
        schema: { name: 'retry_report', description: 'test', parameters: { type: 'object', properties: {} } },
        version: 1,
        viewHint: 'diagnostic',
        tools: [],
        maxTurns: 1,
        prompt: () => '',
        isComplete: () => calls >= 3,
      });
      const provider: Provider = {
        name: 'rate-limited',
        async chat() {
          calls++;
          if (calls < 3) throw Object.assign(new Error('rate limited'), { status: 429 });
          return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const env = await runSkillSubRun({ ctx, skill, args: {}, provider });
      expect(env.ok).toBe(true);
      expect(calls).toBe(3);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('a hung skill provider is bounded by the turn timeout and becomes an envelope', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.config.turnTimeoutMs = 10;
      let calls = 0;
      let closes = 0;
      const provider: Provider = {
        name: 'hung',
        async chat() {
          calls++;
          return new Promise<Turn>(() => {});
        },
        async close() {
          closes++;
        },
      };
      const env = await dispatchToolResult(ctx, 'generate_report', {}, { provider });
      expect(env.ok).toBe(false);
      expect(env.error?.kind).toBe('exception');
      expect(flatten(env)).toContain('turn exceeded');
      expect(calls).toBe(4);
      expect(closes).toBe(4);
    } finally {
      await cleanup();
    }
  });

  it('an incomplete skill preserves partial results and repeated calls in call order', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const skill = defineSkill({
        schema: { name: 'partial_report', description: 'test', parameters: { type: 'object', properties: {} } },
        version: 1,
        viewHint: 'diagnostic',
        tools: ['list_nets'],
        maxTurns: 1,
        prompt: () => '',
        isComplete: () => false,
      });
      const provider = new ScriptedProvider([{
        text: null,
        toolCalls: [
          { id: '1', name: 'list_nets', args: {} },
          { id: '2', name: 'list_nets', args: {} },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      }]);
      const env = await runSkillSubRun({ ctx, skill, args: {}, provider });
      expect(env.ok).toBe(false);
      expect(flatten(env)).toContain('design report incomplete');
      expect((env.detail?.match(/list_nets:/g) ?? []).length).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it('a tool-less skill turn is nudged and the next turn can complete', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const skill = defineSkill({
        schema: { name: 'drift_report', description: 'test', parameters: { type: 'object', properties: {} } },
        version: 1,
        viewHint: 'diagnostic',
        tools: ['check_drift'],
        maxTurns: 2,
        prompt: () => '',
        isComplete: (runCtx) => runCtx.lastDrift != null,
      });
      const provider = new ScriptedProvider([
        { text: 'thinking', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
        {
          text: null,
          toolCalls: [{ id: '1', name: 'check_drift', args: {} }],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]);
      const env = await runSkillSubRun({ ctx, skill, args: {}, provider });
      expect(env.ok).toBe(true);
      expect(provider.calls).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it('off-catalog names stay prose in parseToolCalls', () => {
    const catalog = new Set(['read_file']);
    const parsed = parseToolCalls('```json\n{"tool":"edit_file","args":{}}\n```', () => 'id1', catalog);
    expect(parsed.toolCalls).toEqual([]);
  });

  it('provider-facing flatten is a string', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const s = await dispatchTool(ctx, 'list_nets', {});
      expect(typeof s).toBe('string');
    } finally {
      await cleanup();
    }
  });
});

describe('skill CLI', () => {
  it('catalogNameFromCli maps kebab to underscore', () => {
    expect(catalogNameFromCli('generate-report')).toBe('generate_report');
  });

  it('listSkills is LLM-free and includes generate_report', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const runs = path.join(repo, '.copperhead', 'runs');
      expect(existsSync(runs)).toBe(false);
      const listed = await listSkills(repo);
      expect(listed.some((s) => s.name === 'generate_report' && s.available)).toBe(true);
      expect(existsSync(runs)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('formats the JSON skill envelope', () => {
    const text = formatSkillEnvelope({ ok: true, summary: 'report', viewHint: 'diagnostic' }, true);
    expect(JSON.parse(text)).toMatchObject({ ok: true, summary: 'report' });
  });

  it('unknown skill names the name', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await expect(
        runSkill({ repoRoot: repo, name: 'does-not-exist', provider: new ScriptedProvider([]) }),
      ).rejects.toThrow(/does-not-exist/);
    } finally {
      await cleanup();
    }
  });

  it('names a registered skill that is unavailable in the current repo', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const skill = registry.get('generate_report');
    expect(skill?.kind).toBe('skill');
    if (skill?.kind !== 'skill') return;
    const gate = skill.gate;
    try {
      await runInit({ repoRoot: repo });
      skill.gate = () => false;
      await expect(
        runSkill({ repoRoot: repo, name: 'generate-report', provider: new ScriptedProvider([]) }),
      ).rejects.toThrow(/not available in this repo/);
    } finally {
      skill.gate = gate;
      await cleanup();
    }
  });

  it('run without a key names the missing env', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const saved = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      COPPERHEAD_MODEL: process.env.COPPERHEAD_MODEL,
    };
    try {
      await runInit({ repoRoot: repo });
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.COPPERHEAD_MODEL;
      await expect(providerForSkillRun(repo)).rejects.toThrow(/API_KEY|login|no model/);
    } finally {
      if (saved.OPENAI_API_KEY !== undefined) process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
      if (saved.ANTHROPIC_API_KEY !== undefined) process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
      if (saved.COPPERHEAD_MODEL !== undefined) process.env.COPPERHEAD_MODEL = saved.COPPERHEAD_MODEL;
      await cleanup();
    }
  });

  it('copperhead --help lists skill', async () => {
    const res = await execa(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'], {
      cwd: ROOT,
      reject: false,
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(res.stdout).toMatch(/\bskill\b/);
  }, 60_000);

  it('skill list works without API keys', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const res = await execa(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--repo', repo, 'skill', 'list'], {
        cwd: ROOT,
        reject: false,
        env: { NO_COLOR: '1' },
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/generate-report|generate_report/);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('CLI catch paths print friendly errors without stack traces', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const unknown = await execa(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', '--repo', repo, 'skill', 'run', 'does-not-exist', '--model', 'codex'],
        { cwd: ROOT, reject: false, env: { ...process.env, NO_COLOR: '1' } },
      );
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain('does-not-exist');
      expect(unknown.stderr).not.toMatch(/\n\s+at /);

      await writeFile(path.join(repo, '.copperhead', 'config.json'), '{not-json', 'utf8');
      const brokenList = await execa(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', '--repo', repo, 'skill', 'list'],
        { cwd: ROOT, reject: false, env: { ...process.env, NO_COLOR: '1' } },
      );
      expect(brokenList.exitCode).toBe(1);
      expect(brokenList.stderr.length).toBeGreaterThan(0);
      expect(brokenList.stderr).not.toMatch(/\n\s+at /);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
