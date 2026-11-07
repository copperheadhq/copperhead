import { describe, it, expect } from 'vitest';
import { readFile, writeFile, appendFile, readdir, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import { runInit } from '../src/memory/scaffold.js';
import { toolSearch } from '../src/agent/filetools.js';
import { saveConstraint } from '../src/memory/constraints.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * Live agent-loop tests (AC-3.x). These call a real LLM: they run only when an
 * provider is configured, and each asserts on repo state and the transcript.
 * Provider parity (AC-3.10): the suite runs for every configured provider.
 */
const providers: { model: string; key: string | undefined }[] = [
  { model: process.env.COPPERHEAD_TEST_OPENAI_MODEL ?? 'gpt-5', key: process.env.OPENAI_API_KEY },
  { model: process.env.COPPERHEAD_TEST_ANTHROPIC_MODEL ?? 'claude', key: process.env.ANTHROPIC_API_KEY },
  {
    model: process.env.COPPERHEAD_TEST_CODEX_MODEL ?? 'codex',
    key: process.env.COPPERHEAD_TEST_CODEX === '1' ? 'saved-codex-login' : undefined,
  },
  // Saved-login Claude Code (AC-3.10, AC-3.11): runs only when a Claude Code
  // OAuth token is present AND the optional SDK is installed; needs no
  // ANTHROPIC_API_KEY. Gating on both avoids a hard failure when the token is
  // set but the (undeclared) SDK dependency is missing.
  {
    model: process.env.COPPERHEAD_TEST_CLAUDE_CODE_MODEL ?? 'claude-code',
    key: claudeCodeSdkInstalled() ? process.env.CLAUDE_CODE_OAUTH_TOKEN : undefined,
  },
  {
    model: process.env.COPPERHEAD_TEST_CURSOR_MODEL ?? 'cursor',
    key: process.env.COPPERHEAD_TEST_CURSOR === '1' ? 'saved-cursor-login' : undefined,
  },
  // OpenAI-compatible endpoint: Groq, OpenRouter, Gemini's compat endpoint,
  // or a local Ollama. Runs only when both the
  // endpoint and its model id are configured, so it stays skipped by default.
  // This is the gate the documented zero-cost stack has to pass before it can
  // be recommended: weaker free-tier models are worse at byte-exact anchored
  // edits, so AC-3.x is where that shows up rather than in review.
  {
    model: process.env.COPPERHEAD_TEST_COMPAT_MODEL ?? 'compat',
    key:
      process.env.COPPERHEAD_TEST_COMPAT_MODEL && process.env.COPPERHEAD_BASE_URL
        ? (process.env[process.env.COPPERHEAD_API_KEY_ENV ?? 'OPENAI_API_KEY'] ?? 'local-endpoint-no-key')
        : undefined,
  },
];

function claudeCodeSdkInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

async function setupRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const { repo, cleanup } = await tempFixtureRepo();
  await runInit({ repoRoot: repo, installHooks: false });
  // the 25 µA sleep budget that powers AC-3.4
  await saveConstraint(repo, 'power.sleep_current_uA', {
    max: 25,
    source: 'docs/SPEC.md#budgets',
    affects: ['KEY_DAH', 'GPIO-pullups'],
  });
  await appendFile(
    path.join(repo, 'docs', 'SPEC.md'),
    '\n## Budgets\n\n- sleep_current_uA: 25 (hard budget; 3.3 V rail; every leakage path counts)\n',
  );
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init docs'], { cwd: repo });
  return { repo, cleanup };
}

for (const { model, key } of providers) {
  describe.skipIf(!key)(`agent loop with ${model}`, () => {
    it(
      'AC-3.1: net rename propagates, ERC clean, one commit, surgical diff (AC-3.7)',
      async () => {
        const { repo, cleanup } = await setupRepo();
        try {
          const { stdout: before } = await execa('git', ['rev-list', 'HEAD', '--count'], { cwd: repo });
          const schBefore = await readFile(path.join(repo, 'hardware', 'open-key.kicad_sch'), 'utf8');
          const res = await runAgentLoop({
            repoRoot: repo,
            request: 'rename net KEY_DAH to KEY_DASH',
            model,
            log: () => {},
          });
          expect(res.outcome).toBe('success');

          const sch = await readFile(path.join(repo, 'hardware', 'open-key.kicad_sch'), 'utf8');
          expect(sch).not.toContain('"KEY_DAH"');
          expect(sch).toContain('KEY_DASH');
          const pinout = await readFile(path.join(repo, 'docs', 'PINOUT.md'), 'utf8');
          expect(pinout).toContain('KEY_DASH');
          expect(pinout).not.toContain('KEY_DAH');

          // exactly one design commit (archive commits excluded by message filter)
          const { stdout: after } = await execa('git', ['rev-list', 'HEAD', '--count'], { cwd: repo });
          const { stdout: subjects } = await execa('git', ['log', '--format=%s', '-n', String(Number(after) - Number(before))], { cwd: repo });
          const designCommits = subjects.split('\n').filter((s) => s.startsWith('copperhead: rename'));
          expect(designCommits).toHaveLength(1);

          // AC-3.7: surgical edit, < 5% of schematic lines changed
          const changed = diffLineCount(schBefore, sch);
          expect(changed / schBefore.split('\n').length).toBeLessThan(0.05);
        } finally {
          await cleanup();
        }
      },
      600_000,
    );

    it(
      'AC-3.4: budget-violating pullup is refused, citing the budget',
      async () => {
        const { repo, cleanup } = await setupRepo();
        try {
          const schBefore = await readFile(path.join(repo, 'hardware', 'open-key.kicad_sch'), 'utf8');
          const res = await runAgentLoop({
            repoRoot: repo,
            request: 'add a 100kΩ pullup to 3V3 on KEY_DAH',
            model,
            maxTurns: 60,
            log: () => {},
          });
          // must not silently comply: either refuse outright or finish without the pullup
          expect(['refused', 'success']).toContain(res.outcome);
          const sch = await readFile(path.join(repo, 'hardware', 'open-key.kicad_sch'), 'utf8');
          if (res.outcome === 'refused') {
            expect(sch).toBe(schBefore);
            expect(res.summary.toLowerCase()).toMatch(/budget|25|sleep|µa|ua/);
          } else {
            // if it "succeeded", it must have been an alternative that did not add the 100k pullup
            expect(sch).not.toContain('"100k"');
          }
        } finally {
          await cleanup();
        }
      },
      600_000,
    );

    it(
      'AC-3.6: a structurally forced failure rolls back to a byte-identical tree',
      async () => {
        const { repo, cleanup } = await setupRepo();
        try {
          // One turn forces failure structurally for every provider: edit tools
          // cannot be exposed until a proposal validates during that first turn.
          const res = await runAgentLoop({
            repoRoot: repo,
            request: 'rename net KEY_DAH to KEY_DASH',
            model,
            maxTurns: 1,
            log: () => {},
          });
          expect(res.outcome).toBe('failure');
          const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: repo });
          expect(status).toBe('');
          expect(res.transcriptDir).toContain('.copperhead');
        } finally {
          await cleanup();
        }
      },
      600_000,
    );
  });
}

async function scanTreeForSecret(dir: string, pattern: RegExp, root = dir): Promise<string[]> {
  const matches: string[] = [];
  const skip = new Set(['.git', 'node_modules', 'dist']);
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current)) {
      if (skip.has(entry)) continue;
      const abs = path.join(current, entry);
      const rel = path.relative(root, abs);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await walk(abs);
      } else {
        const text = await readFile(abs, 'utf8');
        if (pattern.test(text)) {
          matches.push(rel);
        }
      }
    }
  }
  await walk(dir);
  return matches;
}

describe.skipIf(!providers.some((p) => p.key))('safety net', () => {
  it(
    'AC-4.1: no API key material anywhere in the tree after a real run',
    async () => {
      // Scanning a freshly created repo that no run ever touched cannot fail
      // for the reason this test exists — there is nothing in it to leak. Run
      // one real turn first so the transcript and summary this check is meant
      // to guard actually exist on disk before the scan.
      const { model } = providers.find((p) => p.key)!;
      const { repo, cleanup } = await setupRepo();
      try {
        // One turn is enough: edit tools are gated off on the first turn for
        // every provider (spec-gated-in), so this fails fast and deterministically
        // while still writing a transcript + summary under .copperhead/runs/.
        await runAgentLoop({
          repoRoot: repo,
          request: 'rename net KEY_DAH to KEY_DASH',
          model,
          maxTurns: 1,
          log: () => {},
        });
        const matches = await scanTreeForSecret(repo, /sk-[A-Za-z0-9_-]+/);
        expect(matches).toEqual([]);
      } finally {
        await cleanup();
      }
    },
    600_000,
  );
});

function diffLineCount(a: string, b: string): number {
  const aLines = a.split('\n');
  const bLines = new Set(b.split('\n'));
  return aLines.filter((l) => !bLines.has(l)).length;
}
