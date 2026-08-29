import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableTools, dispatchTool, dispatchToolResult, registry } from '../src/agent/tools.js';
import { flatten } from '../src/agent/envelope.js';
import { defineSkill } from '../src/capabilities/define.js';
import { ToolRegistry } from '../src/agent/registry.js';
import { runSkill, listSkills, catalogNameFromCli, providerForSkillRun } from '../src/commands/skill.js';
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
  constructor(private readonly turns: Turn[]) {}
  async chat(): Promise<Turn> {
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
      const env = await dispatchToolResult(ctx, 'generate_report', { scope: 'all' }, {
        provider: new ScriptedProvider([reportTurn()]),
      });
      expect(env.detail ?? env.summary).toBeTruthy();
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
      const listed = await listSkills(repo);
      expect(listed.some((s) => s.name === 'generate_report' && s.available)).toBe(true);
    } finally {
      await cleanup();
    }
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
    const res = await execa('npx', ['tsx', 'src/cli.ts', '--help'], {
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
      const res = await execa('npx', ['tsx', 'src/cli.ts', '--repo', repo, 'skill', 'list'], {
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
});
