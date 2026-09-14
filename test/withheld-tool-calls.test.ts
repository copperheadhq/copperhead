import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, ToolSchema, Turn } from '../src/agent/types.js';
import { parseToolCalls } from '../src/agent/providers/tool-protocol.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { loadConfig } from '../src/config.js';
import { contractGapDetail, STAGES } from '../src/commands/create.js';

/**
 * Text-protocol test provider that simulates claude-code / cursor:
 * It receives text replies from a script, parses them using the REAL parseToolCalls
 * with the per-turn advertised catalog, and returns the resulting Turn (including withheld).
 */
function textProtocolProvider(rawReplies: string[]): Provider & { seen: Msg[][] } {
  let i = 0;
  let callSeq = 0;
  const seen: Msg[][] = [];
  return {
    name: 'claude-code',
    seen,
    async chat(messages: Msg[], tools: ToolSchema[]): Promise<Turn> {
      seen.push([...messages]);
      const reply = rawReplies[Math.min(i, rawReplies.length - 1)]!;
      i++;
      const catalog = new Set(tools.map((t) => t.name));
      const parsed = parseToolCalls(reply, () => `test-${++callSeq}`, catalog);
      return {
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        withheld: parsed.withheld,
        usage: { inputTokens: 50, outputTokens: 50 },
        nudge: parsed.nudge,
      };
    },
  };
}

describe('Issue #296: Withheld tool calls and finish guard', () => {
  it('parseToolCalls populates withheld for off-catalog tools in mixed batch', () => {
    const catalog = new Set(['propose_change', 'validate_change', 'finish']);
    const reply = [
      '```json',
      JSON.stringify({
        tool: 'propose_change',
        args: { id: 'test-change', why: 'test', what_changes: 'test', tasks: 'test' },
      }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'write_file',
        args: { path: 'docs/SPEC.md', content: '# Spec\n' },
      }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'finish',
        args: { outcome: 'done', summary: 'done' },
      }),
      '```',
    ].join('\n\n');

    let seq = 0;
    const parsed = parseToolCalls(reply, () => `call-${++seq}`, catalog);

    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['propose_change', 'finish']);
    expect(parsed.withheld.length).toBe(1);
    expect(parsed.withheld[0]!.name).toBe('write_file');
    expect(parsed.withheld[0]!.reason).toContain('not in this turn\'s tool catalog');
  });

  it('blocks finish when a batched reply contains withheld tool calls, surfaces feedback, and succeeds on next turn', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

      // Turn 1: Model batches propose_change, validate_change, write_file, check_drift, finish.
      // At parse time, edits are locked (catalog does not include write_file).
      // Turn 2: Model sees write_file was withheld, and now edits are unlocked. Model runs write_file, check_drift, finish.
      const turn1 = [
        '```json',
        JSON.stringify({
          tool: 'propose_change',
          args: { id: 'add-spec', why: 'needed', what_changes: '- write spec', tasks: '- [ ] write spec' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'validate_change', args: {} }),
        '```',
        '```json',
        JSON.stringify({
          tool: 'write_file',
          args: { path: 'docs/EXTRA.md', content: '# Extra Documentation\n\nSome content.' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'check_drift', args: {} }),
        '```',
        '```json',
        JSON.stringify({
          tool: 'finish',
          args: { outcome: 'done', summary: 'all work complete' },
        }),
        '```',
      ].join('\n\n');

      const turn2 = [
        '```json',
        JSON.stringify({
          tool: 'write_file',
          args: { path: 'docs/EXTRA.md', content: '# Extra Documentation\n\nSome content.' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'check_drift', args: {} }),
        '```',
        '```json',
        JSON.stringify({
          tool: 'finish',
          args: { outcome: 'done', summary: 'all work complete on retry' },
        }),
        '```',
      ].join('\n\n');

      const provider = textProtocolProvider([turn1, turn2]);

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'add extra documentation',
        model: 'claude-code',
        provider,
        maxTurns: 5,
        log: () => {},
      });

      expect(res.outcome).toBe('success');
      expect(res.exitPath).toBe('done');
      expect(res.filesTouched).toContain('docs/EXTRA.md');

      // The created file should exist and contain the expected content
      const extraContent = await readFile(path.join(repo, 'docs', 'EXTRA.md'), 'utf8');
      expect(extraContent).toBe('# Extra Documentation\n\nSome content.');

      // Check the messages seen by the provider in turn 2:
      // It should have received a tool message for finish explaining why it didn't run,
      // and a user message explaining that write_file was withheld.
      const turn2Messages = provider.seen[1]!;
      const toolMessages = turn2Messages.filter((m) => m.role === 'tool');
      const finishToolMsg = toolMessages.find((m) => m.content.includes('finish not run'));
      expect(finishToolMsg).toBeDefined();
      expect(finishToolMsg!.content).toContain('"write_file"');

      const userMessages = turn2Messages.filter((m) => m.role === 'user');
      const lastUserMsg = userMessages[userMessages.length - 1]!;
      expect(lastUserMsg.content).toContain('withheld');
      expect(lastUserMsg.content).toContain('"write_file"');
    } finally {
      await cleanup();
    }
  });

  it('finishGuard rejects premature finish and continues loop', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

      let guardChecked = 0;
      const provider = textProtocolProvider([
        // Turn 1: try to finish immediately
        '```json\n{"tool": "finish", "args": {"outcome": "done", "summary": "premature finish"}}\n```',
        // Turn 2: try to finish again after condition met
        '```json\n{"tool": "finish", "args": {"outcome": "done", "summary": "proper finish"}}\n```',
      ]);

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'test guard',
        model: 'claude-code',
        provider,
        maxTurns: 5,
        log: () => {},
        finishGuard: async () => {
          guardChecked++;
          if (guardChecked === 1) {
            return 'stage requirement not met: missing SPEC.md';
          }
          return null;
        },
      });

      expect(guardChecked).toBe(2);
      expect(res.outcome).toBe('success');

      // Verify the model received the finish rejection feedback
      const turn2Messages = provider.seen[1]!;
      const userMessages = turn2Messages.filter((m) => m.role === 'user');
      const feedbackMsg = userMessages.find((m) => m.content.includes('Cannot finish yet: stage requirement not met'));
      expect(feedbackMsg).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it('F1: a throw inside finishGuard routes through fail() with exitPath finish-guard-error', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

      const turn1 = [
        '```json',
        JSON.stringify({
          tool: 'propose_change',
          args: { id: 'test-f1', why: 'needed', what_changes: '- write note', tasks: '- [ ] write note' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'validate_change', args: {} }),
        '```',
      ].join('\n\n');

      const turn2 = [
        '```json',
        JSON.stringify({
          tool: 'write_file',
          args: { path: 'docs/NOTE.md', content: '# Note\n' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'check_drift', args: {} }),
        '```',
        '```json',
        JSON.stringify({
          tool: 'finish',
          args: { outcome: 'done', summary: 'done' },
        }),
        '```',
      ].join('\n\n');

      const provider = textProtocolProvider([turn1, turn2]);

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'test throwing guard',
        model: 'claude-code',
        provider,
        maxTurns: 5,
        log: () => {},
        finishGuard: async () => {
          throw new Error('corrupted stage validation');
        },
      });

      expect(res.outcome).toBe('failure');
      expect(res.exitPath).toBe('finish-guard-error');
      expect(res.summary).toContain('corrupted stage validation');

      // Working tree is restored (docs/NOTE.md should not exist in working tree)
      expect(existsSync(path.join(repo, 'docs', 'NOTE.md'))).toBe(false);

      // summary.md exists in transcript dir
      const summaryFile = path.join(res.transcriptDir, 'summary.md');
      expect(existsSync(summaryFile)).toBe(true);
      const summaryText = await readFile(summaryFile, 'utf8');
      expect(summaryText).toContain('finish-guard-error');
    } finally {
      await cleanup();
    }
  });

  it('F2: locked-only tool call replies end stalled within 3 turns', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

      // Model keeps emitting locked write_file without propose/validate
      const lockedReply = '```json\n{"tool": "write_file", "args": {"path": "docs/SPEC.md", "content": "# Spec"}}\n```';
      const provider = textProtocolProvider([lockedReply, lockedReply, lockedReply, lockedReply]);

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'locked only test',
        model: 'claude-code',
        provider,
        maxTurns: 12,
        log: () => {},
      });

      expect(res.outcome).toBe('failure');
      expect(res.exitPath).toBe('stalled');
      expect(res.stats.turnsUsed).toBeLessThanOrEqual(3);
    } finally {
      await cleanup();
    }
  });

  it('F3: contractGapDetail returns actionable per-stage reasons', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const config = { ...(await loadConfig(repo)), docs: 'docs', schematic: 'test.kicad_sch', board: 'test.kicad_pcb' };

      const gapSpecMissing = await contractGapDetail('spec-seed', repo, config);
      expect(gapSpecMissing).toBe('docs/SPEC.md does not exist');

      const gapArchMissing = await contractGapDetail('architecture', repo, config);
      expect(gapArchMissing).toBe('docs/SUBSYSTEMS.md does not exist');

      const gapBomMissing = await contractGapDetail('part-selection', repo, config);
      expect(gapBomMissing).toBe('docs/BOM.md does not exist');
    } finally {
      await cleanup();
    }
  });

  it('F3: bounds consecutive guard rejections with no intervening file changes to 3 turns', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

      // Model keeps trying to finish without making any edits
      const finishReply = '```json\n{"tool": "finish", "args": {"outcome": "done", "summary": "premature finish"}}\n```';
      const provider = textProtocolProvider([finishReply, finishReply, finishReply, finishReply, finishReply]);

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'test bounded guard rejections',
        model: 'claude-code',
        provider,
        maxTurns: 10,
        log: () => {},
        finishGuard: async () => 'SPEC.md needs Budgets section',
      });

      expect(res.outcome).toBe('failure');
      expect(res.exitPath).toBe('stalled');
      expect(res.stats.turnsUsed).toBe(3);
      expect(res.summary).toContain('SPEC.md needs Budgets section');
    } finally {
      await cleanup();
    }
  });

  it('F6: mixed-reply with withheld tool call and no finish surfaces withheld notice', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

      // Turn 1: propose_change + validate_change + locked write_file (no finish)
      const turn1 = [
        '```json',
        JSON.stringify({
          tool: 'propose_change',
          args: { id: 'test-mixed', why: 'test', what_changes: '- test', tasks: '- [ ] test' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'validate_change', args: {} }),
        '```',
        '```json',
        JSON.stringify({
          tool: 'write_file',
          args: { path: 'docs/TEST.md', content: '# Test' },
        }),
        '```',
      ].join('\n\n');

      // Turn 2: write_file + finish
      const turn2 = [
        '```json',
        JSON.stringify({
          tool: 'write_file',
          args: { path: 'docs/TEST.md', content: '# Test' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'check_drift', args: {} }),
        '```',
        '```json',
        JSON.stringify({ tool: 'finish', args: { outcome: 'done', summary: 'complete' } }),
        '```',
      ].join('\n\n');

      const provider = textProtocolProvider([turn1, turn2]);

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'test mixed notice',
        model: 'claude-code',
        provider,
        maxTurns: 5,
        log: () => {},
      });

      expect(res.outcome).toBe('success');

      // Verify turn 2 received the withheld notice in user message
      const turn2Messages = provider.seen[1]!;
      const userMessages = turn2Messages.filter((m) => m.role === 'user');
      const noticeMsg = userMessages.find((m) => m.content.includes('withheld because it was not in this turn\'s tool catalog'));
      expect(noticeMsg).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it('F6: issue #296 brief-only repro creates docs/ and appends changelog from uninitialized repo', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // In this test, runInit is NOT called; docs/ does not exist.
      const turn1 = [
        '```json',
        JSON.stringify({ tool: 'read_file', args: { path: 'docs/SPEC.md' } }),
        '```',
        '```json',
        JSON.stringify({ tool: 'search', args: { pattern: 'BirdBox' } }),
        '```',
      ].join('\n\n');

      const turn2 = [
        '```json',
        JSON.stringify({
          tool: 'propose_change',
          args: { id: 'spec-seed', why: 'seed requirements', what_changes: '- docs/SPEC.md', tasks: '- [ ] write docs/SPEC.md' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'validate_change', args: {} }),
        '```',
        '```json',
        JSON.stringify({
          tool: 'write_file',
          args: { path: 'docs/SPEC.md', content: '# BirdBox\n\n## Budgets\n\n- board: 50x50 mm (ASSUMED)\n' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'check_drift', args: {} }),
        '```',
        '```json',
        JSON.stringify({ tool: 'finish', args: { outcome: 'done', summary: 'SPEC.md seeded' } }),
        '```',
      ].join('\n\n');

      const turn3 = [
        '```json',
        JSON.stringify({
          tool: 'write_file',
          args: { path: 'docs/SPEC.md', content: '# BirdBox\n\n## Budgets\n\n- board: 50x50 mm (ASSUMED)\n' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'check_drift', args: {} }),
        '```',
        '```json',
        JSON.stringify({ tool: 'finish', args: { outcome: 'done', summary: 'SPEC.md seeded on turn 3' } }),
        '```',
      ].join('\n\n');

      const provider = textProtocolProvider([turn1, turn2, turn3]);

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'create pipeline stage: spec-seed',
        stagePrompt: 'Stage 1: write docs/SPEC.md',
        model: 'claude-code',
        provider,
        maxTurns: 5,
        log: () => {},
      });

      expect(res.outcome).toBe('success');
      expect(res.exitPath).toBe('done');
      expect(existsSync(path.join(repo, 'docs', 'SPEC.md'))).toBe(true);
      const specContent = await readFile(path.join(repo, 'docs', 'SPEC.md'), 'utf8');
      expect(specContent).toContain('## Budgets');

      // CHANGELOG.md should also exist in docs/
      expect(existsSync(path.join(repo, 'docs', 'CHANGELOG.md'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('F6: create wiring of finishGuard checks real stage contract and provides per-stage rejection', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const config = await loadConfig(repo);
      const stage = STAGES[0]!; // spec-seed

      // Turn 1: Unlock edits
      const turn1 = [
        '```json',
        JSON.stringify({
          tool: 'propose_change',
          args: { id: 'test-seed', why: 'seed', what_changes: '- spec', tasks: '- [ ] spec' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'validate_change', args: {} }),
        '```',
      ].join('\n\n');

      // Turn 2: Write incomplete SPEC.md without Budgets content and try to finish
      const turn2 = [
        '```json',
        JSON.stringify({
          tool: 'write_file',
          args: {
            path: 'docs/SPEC.md',
            content: '# Incomplete Spec\n\n## Overview\nNo budgets here.\n',
          },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'check_drift', args: {} }),
        '```',
        '```json',
        JSON.stringify({ tool: 'finish', args: { outcome: 'done', summary: 'incomplete spec' } }),
        '```',
      ].join('\n\n');

      // Turn 3: Edit SPEC.md to add Budgets and finish
      const turn3 = [
        '```json',
        JSON.stringify({
          tool: 'edit_file',
          args: {
            path: 'docs/SPEC.md',
            old_string: 'No budgets here.',
            new_string: '## Budgets\n\n- board: 50x50 mm\n- power: 100mA\n',
          },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'check_drift', args: {} }),
        '```',
        '```json',
        JSON.stringify({ tool: 'finish', args: { outcome: 'done', summary: 'completed spec' } }),
        '```',
      ].join('\n\n');

      const provider = textProtocolProvider([turn1, turn2, turn3]);

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'create pipeline stage: spec-seed',
        model: 'claude-code',
        provider,
        maxTurns: 5,
        log: () => {},
        finishGuard: async () => {
          if (await stage.isComplete(repo, config.docs)) return null;
          const gap = await contractGapDetail(stage.name, repo, config);
          return `stage completion contract for "${stage.name}" is not yet satisfied: ${gap}`;
        },
      });

      expect(res.outcome).toBe('success');
      expect(res.exitPath).toBe('done');

      // Check turn 3 feedback message contains the specific stage contract gap from turn 2's rejection
      const turn3Messages = provider.seen[2]!;
      const userMessages = turn3Messages.filter((m) => m.role === 'user');
      const rejectionMsg = userMessages.find((m) => m.content.includes("Cannot finish yet: stage completion contract for \"spec-seed\" is not yet satisfied: docs/SPEC.md needs a heading containing 'Budgets'"));
      expect(rejectionMsg).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it('record_decision creates docs/ directory recursively if absent', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const transcript = new Transcript(repo);
      await transcript.init();
      const ctx: RunContext = {
        repoRoot: repo,
        config: { ...(await loadConfig(repo)), docs: 'nested/docs' },
        transcript,
        ledger: new ObligationsLedger(),
        runId: 'test-run',
        interactive: false,
        confirm: async () => true,
        editsUnlocked: true,
        changeId: 'test-change',
        proposalValidated: true,
        filesTouched: new Set(),
        decisions: [],
        lastErc: null,
        lastDrc: null,
        lastLegibility: null,
        lastScore: null,
        repairCycles: 0,
        finishRequest: null,
      };

      const res = await dispatchTool(ctx, 'record_decision', {
        decision: 'Use 3.3V LDO',
        rationale: 'lower noise',
        affects: 'power',
      });

      expect(res).toBe('decision recorded');
      expect(existsSync(path.join(repo, 'nested', 'docs', 'DECISIONS.md'))).toBe(true);
      const content = await readFile(path.join(repo, 'nested', 'docs', 'DECISIONS.md'), 'utf8');
      expect(content).toContain('Use 3.3V LDO');
    } finally {
      await cleanup();
    }
  });
});
