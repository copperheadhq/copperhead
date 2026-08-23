import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import {
  budgetExtraTurns,
  budgetPromptText,
  parseMaxTurns,
  repoOf,
} from '../src/util/cli-args.js';
import { setColorEnabled, styleOutcome, styleHeaderLines } from '../src/agent/theme.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('--max-turns parsing', () => {
  it('accepts positive integers, including exponent notation', () => {
    expect(parseMaxTurns('1')).toBe(1);
    expect(parseMaxTurns('40')).toBe(40);
    expect(parseMaxTurns('1e3')).toBe(1000);
  });

  it('refuses anything that is not a positive integer', () => {
    for (const bad of ['0', '-1', '2.5', 'NaN', '5oops', 'Infinity', ' ']) {
      expect(() => parseMaxTurns(bad), bad).toThrow(/positive integer/);
    }
  });

  it('names the offending value so the refusal is actionable', () => {
    expect(() => parseMaxTurns('5oops')).toThrow('"5oops"');
  });
});

describe('--repo resolution', () => {
  it('resolves a relative path against the working directory', () => {
    expect(repoOf({ repo: '.' })).toBe(path.resolve('.'));
  });

  it('passes an absolute path through unchanged', () => {
    expect(repoOf({ repo: '/tmp/some-repo' })).toBe(path.resolve('/tmp/some-repo'));
  });

  it('defaults to the working directory', () => {
    expect(repoOf({})).toBe(path.resolve(process.cwd()));
  });
});

describe('budget-exhausted prompt (design D1)', () => {
  const stats = {
    maxTurns: 40,
    turnsUsed: 40,
    tokensIn: 12_345,
    tokensOut: 6_789,
    filesTouched: ['a.kicad_sch', 'b.md'],
    openObligations: 1,
  };

  it('offers half the ORIGINAL budget, so repeat extensions do not escalate', () => {
    expect(budgetExtraTurns({ maxTurns: 40 })).toBe(20);
    expect(budgetExtraTurns({ maxTurns: 41 })).toBe(21); // ceil, never zero
    expect(budgetExtraTurns({ maxTurns: 1 })).toBe(1);
  });

  it('spells out the cost of the run so far', () => {
    const q = budgetPromptText(stats);
    expect(q).toContain('40 turns');
    expect(q).toContain('12.3k in / 6.8k out');
    expect(q).toContain('2 file(s) touched');
    expect(q).toContain('1 open obligation(s)');
    expect(q).toContain('Continue with 20 more turns?');
  });
});

describe('theme styling (color on)', () => {
  // These branches early-return when color is off, which is how every other
  // suite runs them, so they need their own explicit color-on coverage.
  beforeEach(() => setColorEnabled(true));

  it('colors a successful outcome differently from a refusal', () => {
    const done = styleOutcome('done · 3 turns');
    const refused = styleOutcome('refused · over budget');
    expect(done).toContain('done');
    expect(refused).toContain('refused');
    expect(done).not.toBe(refused);
    // The head is painted and the tail dimmed, so both carry SGR.
    expect(done).toMatch(/\x1b\[/);
    expect(refused).toMatch(/\x1b\[/);
  });

  it('treats every failure token as a failure', () => {
    for (const head of ['refused', 'failed', 'error', 'exhausted', 'stalled']) {
      expect(styleOutcome(`${head} · x`), head).toBe(styleOutcome('refused · x').replace('refused', head));
    }
  });

  it('paints the brand in the header and dims the rest', () => {
    const [first, second] = styleHeaderLines(['copperhead v0.7.0 · gpt-5 · repo', 'second line']);
    expect(first).toContain('copperhead v0.7.0');
    expect(first).toMatch(/\x1b\[/);
    expect(second).toContain('second line');
  });

  it('dims a first line that does not match the brand pattern', () => {
    const [only] = styleHeaderLines(['not the banner']);
    expect(only).toContain('not the banner');
    expect(only).toMatch(/\x1b\[/);
  });

  it('is a pass-through when color is off', () => {
    setColorEnabled(false);
    expect(styleOutcome('done · 3 turns')).toBe('done · 3 turns');
    expect(styleHeaderLines(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('demo --tour honours --json', () => {
  // The only end-to-end check of the CLI wiring: --tour short-circuits before
  // the try block, so it used to print prose even under --json. Runs the real
  // entry point through tsx; --tour touches no network and no kicad-cli.
  it('emits structured JSON, not prose, under --json', async () => {
    const res = await execa('npx', ['tsx', 'src/cli.ts', '--json', 'demo', '--tour'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1' },
    });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { tour: string[] };
    expect(Array.isArray(parsed.tour)).toBe(true);
    expect(parsed.tour.join('\n')).toContain('copperhead');
    // Machine-readable means no leftover SGR in the payload.
    expect(res.stdout).not.toMatch(/\x1b\[/);
  }, 60_000);

  it('still prints prose without --json', async () => {
    const res = await execa('npx', ['tsx', 'src/cli.ts', 'demo', '--tour'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1' },
    });
    expect(res.exitCode).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow();
    expect(res.stdout).toContain('copperhead');
  }, 60_000);
});
