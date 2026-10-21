import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transcript, type IncrementalRunMetrics } from '../src/agent/transcript.js';

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
});
