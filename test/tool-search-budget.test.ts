import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  toolSearch,
  SearchError,
  SearchTimeoutError,
  MAX_SEARCH_PATTERN_CHARS,
  DEFAULT_SEARCH_BUDGET_MS,
} from '../src/agent/filetools.js';
import { isRateLimit, withRetry } from '../src/util/retry.js';
import { dispatchToolResult } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { loadConfig } from '../src/config.js';
import type { RunContext } from '../src/agent/context.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * A pattern that makes V8's backtracking engine run effectively forever:
 * `(a+)+$` against a long run of `a` ending in `b` has exponentially many
 * suffix partitions to try. This is the issue #366 reproducer. It is only ever
 * evaluated inside a budgeted worker thread that the test then verifies is
 * terminated; it is never run unguarded on the main thread or against a
 * production file.
 */
function pathologicalPattern(): string {
  return '(a+)+$';
}

async function makeRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ch-toolsearch-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function workerPorts(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'MessagePort').length;
}

/** Poll until no worker MessagePort remains from a finished search (cleanup check). */
async function expectPortsReturned(): Promise<void> {
  const baseline = workerPorts();
  for (let i = 0; i < 200; i++) {
    if (workerPorts() <= baseline) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(workerPorts()).toBeLessThanOrEqual(baseline);
}

describe('toolSearch budget (issue #366)', () => {
  it('ordinary patterns keep matching, with and without a glob filter', async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await writeFile(path.join(dir, 'a.md'), 'KEY_DAH here\n');
      await writeFile(path.join(dir, 'b.txt'), 'KEY_DAH there\n');
      await writeFile(path.join(dir, 'c.txt'), 'nothing\n');
      const all = await toolSearch(dir, 'KEY_DAH');
      expect(all.map((m) => m.file).sort()).toEqual(['a.md', 'b.txt']);
      const mdOnly = await toolSearch(dir, 'KEY_DAH', '**/*.md');
      expect(mdOnly.map((m) => m.file)).toEqual(['a.md']);
      expect(mdOnly[0]!.text).toBe('KEY_DAH here');
    } finally {
      await cleanup();
    }
  });

  it('an invalid pattern fails closed as a typed invalid-pattern error', async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await writeFile(path.join(dir, 'a.txt'), 'x\n');
      await expect(toolSearch(dir, '(')).rejects.toMatchObject({ code: 'invalid-pattern' });
    } finally {
      await cleanup();
    }
  });

  it('a pattern over the length cap is rejected before any worker work', async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await writeFile(path.join(dir, 'a.txt'), 'x\n');
      const long = 'a'.repeat(MAX_SEARCH_PATTERN_CHARS + 1);
      await expect(toolSearch(dir, long)).rejects.toMatchObject({ code: 'pattern-too-long' });
    } finally {
      await cleanup();
    }
  });

  it('a catastrophic pattern is stopped by the budget with a typed timeout error', async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await writeFile(path.join(dir, 'evil.txt'), 'a'.repeat(64) + 'b\n');
      const started = Date.now();
      const err = await toolSearch(dir, pathologicalPattern(), undefined, 100, { budgetMs: 150 }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SearchTimeoutError);
      expect((err as SearchError).code).toBe('timeout');
      expect((err as SearchError).message).toContain('150 ms');
      // Termination bounds the caller's wait: far below the time the pattern
      // would otherwise block for, even on a slow runner.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await cleanup();
    }
  });

  it('releases worker threads after success and after a timeout', async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await writeFile(path.join(dir, 'a.txt'), 'KEY_DAH here\n');
      await writeFile(path.join(dir, 'evil.txt'), 'a'.repeat(64) + 'b\n');
      await toolSearch(dir, 'KEY_DAH');
      await expect(toolSearch(dir, pathologicalPattern(), undefined, 100, { budgetMs: 80 })).rejects.toBeInstanceOf(
        SearchTimeoutError,
      );
      await expectPortsReturned();
    } finally {
      await cleanup();
    }
  });

  it('aborts and cleans up an in-flight search', async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await writeFile(path.join(dir, 'evil.txt'), 'a'.repeat(64) + 'b\n');
      const ac = new AbortController();
      const started = Date.now();
      const pending = toolSearch(dir, pathologicalPattern(), undefined, 100, {
        budgetMs: 60_000,
        signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await expect(pending).rejects.toMatchObject({ code: 'aborted' });
      expect(Date.now() - started).toBeLessThan(5_000);
      await expectPortsReturned();
    } finally {
      await cleanup();
    }
  });

  it('an already-aborted signal fails closed immediately and leaves no worker behind', async () => {
    const { dir, cleanup } = await makeRepo();
    try {
      await writeFile(path.join(dir, 'evil.txt'), 'a'.repeat(64) + 'b\n');
      const ac = new AbortController();
      ac.abort();
      const started = Date.now();
      const err = await toolSearch(dir, pathologicalPattern(), undefined, 100, {
        budgetMs: 60_000,
        signal: ac.signal,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SearchError);
      expect((err as SearchError).code).toBe('aborted');
      expect(Date.now() - started).toBeLessThan(1_000);
      await expectPortsReturned();
    } finally {
      await cleanup();
    }
  });
});

describe('search failure retry policy', () => {
  it('a timeout error is not a rate limit, so the dispatch retry policy does not retry it', async () => {
    expect(isRateLimit(new SearchTimeoutError(1))).toBe(false);
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new SearchTimeoutError(1);
        },
        { isRetryable: isRateLimit, baseMs: 1, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(SearchTimeoutError);
    expect(calls).toBe(1);
  });

  it('dispatch surfaces an over-cap pattern as a non-retried validation failure', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const transcript = new Transcript(repo);
      await transcript.init();
      const ctx: RunContext = {
        repoRoot: repo,
        config: await loadConfig(repo),
        transcript,
        ledger: new ObligationsLedger(),
        runId: 'tool-search-budget',
        interactive: false,
        confirm: async () => true,
        editsUnlocked: false,
        changeId: null,
        proposalValidated: false,
        filesTouched: new Set(),
        decisions: [],
        lastErc: null,
        lastDrc: null,
        lastLegibility: null,
        lastScore: null,
        repairCycles: 0,
        finishRequest: null,
      };
      const env = await dispatchToolResult(ctx, 'search', { pattern: 'a'.repeat(MAX_SEARCH_PATTERN_CHARS + 1) });
      expect(env.ok).toBe(false);
      expect(env.error?.kind).toBe('validation');
      expect(env.error?.message).toContain('pattern rejected');
      expect(await dispatchToolResult(ctx, 'search', { pattern: '' })).toMatchObject({
        ok: false,
        error: { kind: 'validation' },
      });
    } finally {
      await cleanup();
    }
  });

  it('exposes a sane default budget for production searches', () => {
    expect(DEFAULT_SEARCH_BUDGET_MS).toBeGreaterThanOrEqual(500);
  });
});