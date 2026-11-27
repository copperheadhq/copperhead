import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transcript, type IncrementalRunMetrics } from '../src/agent/transcript.js';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Provider, Turn } from '../src/agent/types.js';
import { tempFixtureRepo } from './helpers.js';

describe('incremental per-LLM-call metrics flush (#140)', () => {
  it('appends turn-metrics events to transcript.jsonl and flushes metrics.json after each turn', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-inc-metrics-'));
    try {
      const tr = new Transcript(repo, new Date('2026-10-21T00:00:00.000Z'));
      await tr.init();

      await tr.recordTurnMetrics({ turn: 1, in: 120, out: 45, durationMs: 850, stage: 'schematic' });
      const snap1 = JSON.parse(await readFile(tr.metricsPath, 'utf8')) as IncrementalRunMetrics;
      expect(snap1.turnsUsed).toBe(1);
      expect(snap1.tokensIn).toBe(120);
      expect(snap1.tokensOut).toBe(45);
      expect(snap1.durationMs).toBe(850);

      await tr.recordTurnMetrics({ turn: 2, in: 300, out: 95, durationMs: 1150, stage: 'schematic' });
      const snap2 = JSON.parse(await readFile(tr.metricsPath, 'utf8')) as IncrementalRunMetrics;
      expect(snap2.turnsUsed).toBe(2);
      expect(snap2.tokensIn).toBe(420);
      expect(snap2.tokensOut).toBe(140);
      expect(snap2.durationMs).toBe(2000);
      expect(snap2.perTurn).toHaveLength(2);

      const jsonl = (await readFile(tr.jsonlPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(jsonl.map((e) => e.type)).toEqual(['turn-metrics', 'turn-metrics']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('redacts secret tokens when flushing incremental metrics', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-inc-redact-'));
    try {
      const tr = new Transcript(repo, new Date('2026-10-21T00:00:00.000Z'));
      await tr.init();
      await tr.recordTurnMetrics({ turn: 1, in: 10, out: 20, stage: 'sk-proj-secret123456789' });
      const raw = await readFile(tr.metricsPath, 'utf8');
      expect(raw).not.toContain('sk-proj-secret123456789');
      expect(raw).toContain('[REDACTED]');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not throw when metrics.json cannot be overwritten, while still appending turn-metrics to transcript.jsonl', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-inc-nowrite-'));
    try {
      const tr = new Transcript(repo, new Date('2026-10-21T00:00:00.000Z'));
      await tr.init();
      await mkdir(tr.metricsPath, { recursive: true });

      const snap = await tr.recordTurnMetrics({ turn: 1, in: 55, out: 15, durationMs: 100 });
      expect(snap.turnsUsed).toBe(1);
      expect(snap.tokensIn).toBe(55);
      expect(snap.tokensOut).toBe(15);

      const jsonl = (await readFile(tr.jsonlPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(jsonl.map((e) => e.type)).toEqual(['turn-metrics']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('flushes turn 1 metrics from runAgentLoop before a turn-2 provider error aborts the run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      let calls = 0;
      const provider: Provider = {
        name: 'fail-on-turn-2',
        async chat(): Promise<Turn> {
          calls++;
          if (calls === 1) {
            return {
              text: 'working on turn 1',
              toolCalls: [{ id: 'c1', name: 'bogus_tool', args: {} }],
              usage: { inputTokens: 250, outputTokens: 75 },
            };
          }
          throw new Error('simulated mid-run crash on turn 2');
        },
      };

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'mid-run failure test',
        model: 'gpt-5',
        provider,
        log: () => {},
        meta: {
          command: 'create',
          modelSource: 'flag',
          version: '9.9.9',
          kicadCliVersion: '9.0.0',
          stage: { name: 'schematic', index: 4, total: 5 },
        },
      });

      expect(res.exitPath).toBe('provider-error');
      const snap = JSON.parse(await readFile(path.join(res.transcriptDir, 'metrics.json'), 'utf8')) as IncrementalRunMetrics;
      expect(snap.turnsUsed).toBe(1);
      expect(snap.tokensIn).toBe(250);
      expect(snap.tokensOut).toBe(75);
      expect(snap.perTurn).toHaveLength(1);
      expect(snap.perTurn[0]?.stage).toBe('schematic');

      const events = (await readFile(path.join(res.transcriptDir, 'transcript.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
      const turnMetricsEvents = events.filter((e) => e.type === 'turn-metrics');
      expect(turnMetricsEvents).toHaveLength(1);
      const runEnd = events.find((e) => e.type === 'run-end')!.data;
      expect(snap.tokensIn).toBe(runEnd.tokensIn);
      expect(snap.tokensOut).toBe(runEnd.tokensOut);
    } finally {
      await cleanup();
    }
  });
});
