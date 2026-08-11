import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import { runCreate } from '../src/commands/create.js';
import { gitPreflight } from '../src/util/git.js';
import { PreflightError, isNotFoundError } from '../src/util/preflight.js';
import { KicadCliMissingError } from '../src/kicad/cli.js';
import { tempFixtureRepo } from './helpers.js';

// The git preflight throws before the provider is constructed and before
// transcript.init(), so these run the real loop offline: no API key is read,
// no network is touched, no run dir is written.

const loopOpts = (repoRoot: string) => ({
  repoRoot,
  model: 'gpt-5',
  request: 'test request',
  log: () => {},
});

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ch-preflight-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('git preflight (unborn HEAD, AC-3.8)', () => {
  it('non-git directory: friendly error, not raw git output', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await expect(runAgentLoop(loopOpts(dir))).rejects.toThrow(
        /not a git repository; copperhead requires git/,
      );
    } finally {
      await cleanup();
    }
  });

  it('unborn HEAD: friendly error with the fix spelled out, no exit-128 noise', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      const err = await runAgentLoop(loopOpts(dir)).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/repository has no commits/);
      expect(err!.message).toMatch(/git add -A && git commit/);
      expect(err!.message).not.toMatch(/exit code 128|ambiguous argument/);
    } finally {
      await cleanup();
    }
  });

  it('staged-but-uncommitted files still count as no commits', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      await writeFile(path.join(dir, 'brief.md'), 'a brief', 'utf8');
      await execa('git', ['add', '-A'], { cwd: dir });
      await expect(runAgentLoop(loopOpts(dir))).rejects.toThrow(/repository has no commits/);
    } finally {
      await cleanup();
    }
  });

  it('detection is independent of the default branch name', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      await expect(runAgentLoop(loopOpts(dir))).rejects.toThrow(/repository has no commits/);
    } finally {
      await cleanup();
    }
  });

  it('a failed preflight leaves no .copperhead footprint', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      await runAgentLoop(loopOpts(dir)).catch(() => {});
      expect(existsSync(path.join(dir, '.copperhead'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('checks run in order repo -> commits -> dirty: a committed repo passes the commit gate', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, 'junk.txt'), 'dirty', 'utf8');
      // reaching the dirty-tree error proves both git gates before it passed
      await expect(runAgentLoop(loopOpts(repo))).rejects.toThrow(/working tree is dirty/);
    } finally {
      await cleanup();
    }
  });
});

describe('copperhead create without a git setup (bug-report path)', () => {
  const createOpts = (repoRoot: string) => ({
    repoRoot,
    briefPath: path.join(repoRoot, 'brief.md'),
    model: 'gpt-5',
    log: () => {},
  });

  it('unborn HEAD: create fails with the no-commits message instead of crashing in spec-seed', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await writeFile(path.join(dir, 'brief.md'), 'A tiny USB macro keypad', 'utf8');
      await execa('git', ['init', '-q'], { cwd: dir });
      await expect(runCreate(createOpts(dir))).rejects.toThrow(/repository has no commits/);
    } finally {
      await cleanup();
    }
  });

  it('non-git directory: create fails with the not-a-repository message', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await writeFile(path.join(dir, 'brief.md'), 'A tiny USB macro keypad', 'utf8');
      await expect(runCreate(createOpts(dir))).rejects.toThrow(/not a git repository/);
    } finally {
      await cleanup();
    }
  });
});

describe('preflight failures explain why and how to fix', () => {
  async function preflightError(dir: string, allowDirty = false): Promise<PreflightError> {
    const err = await gitPreflight(dir, { allowDirty }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PreflightError);
    return err as PreflightError;
  }

  it('non-git directory: why line plus numbered remedy steps ending in a rerun', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const err = await preflightError(dir);
      expect(err.message).toMatch(/why it failed: .*snapshot/);
      expect(err.message).toMatch(/to fix:\n  1\. git init\n  2\. git add -A && git commit/);
      expect(err.message).toMatch(/rerun the same copperhead command/);
    } finally {
      await cleanup();
    }
  });

  it('unborn HEAD: explains there is nothing to roll back to, remedy is the first commit', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      const err = await preflightError(dir);
      expect(err.message).toMatch(/why it failed: .*nothing to roll back to/);
      expect(err.message).toMatch(/1\. git add -A && git commit/);
    } finally {
      await cleanup();
    }
  });

  it('dirty tree: explains rollback would destroy uncommitted work, offers commit/stash/--allow-dirty', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, 'junk.txt'), 'dirty', 'utf8');
      const err = await preflightError(repo);
      expect(err.message).toMatch(/why it failed: .*destroy your uncommitted work/);
      expect(err.message).toMatch(/git add -A && git commit/);
      expect(err.message).toMatch(/git stash/);
      expect(err.message).toMatch(/--allow-dirty/);
      // the offered flag actually works
      await expect(gitPreflight(repo, { allowDirty: true })).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('exposes reason/why/remedy as structured fields for programmatic callers', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const err = await preflightError(dir);
      expect(err.reason).toMatch(/not a git repository/);
      expect(err.why).toBeTruthy();
      expect(err.remedy.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it('missing kicad-cli is a PreflightError with install steps', () => {
    const err = new KicadCliMissingError();
    expect(err).toBeInstanceOf(PreflightError);
    expect(err.message).toMatch(/why it failed: .*ERC\/DRC/);
    expect(err.message).toMatch(/1\. install KiCad/);
    expect(err.message).toMatch(/kicad-cli version/);
  });

  it('the loop surfaces the full explanation, not just the reason line', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      const err = await runAgentLoop(loopOpts(dir)).then(
        () => null,
        (e: Error) => e,
      );
      expect(err!.message).toMatch(/why it failed:/);
      expect(err!.message).toMatch(/to fix:/);
    } finally {
      await cleanup();
    }
  });
});

describe('isNotFoundError helper', () => {
  const originalPlatform = process.platform;

  it('identifies ENOENT as not found on any platform', () => {
    expect(isNotFoundError({ code: 'ENOENT' })).toBe(true);
    expect(isNotFoundError({ code: 'EACCES' })).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });

  it('identifies Windows command missing errors under win32 platform override', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(isNotFoundError({
        exitCode: 9009,
        stderr: "'kicad-cli' is not recognized as an internal or external command"
      })).toBe(true);

      expect(isNotFoundError({
        exitCode: 9009,
        stderr: 'The system cannot find the path specified.',
      })).toBe(true);



      expect(isNotFoundError({
        exitCode: 1,
        stderr: "'openspec' is not recognized as an internal or external command, operable program or batch file."
      })).toBe(true);

      expect(isNotFoundError({
        exitCode: 1,
        stderr: 'The file format is not recognized.'
      })).toBe(false);

      // Negative cases
      expect(isNotFoundError({
        exitCode: 1,
        stderr: "ERC violations found"
      })).toBe(false);

      expect(isNotFoundError({
        exitCode: 2,
        stderr: "some random error"
      })).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('classifies a real execa spawn failure as not-found', async () => {
    const err = await execa('copperhead-does-not-exist', []).catch((e) => e);
    expect(isNotFoundError(err)).toBe(true);
  });

  it('classifies a non-rejecting execa failure result as not-found', async () => {
    const res = await execa('copperhead-does-not-exist', [], { reject: false });
    expect(isNotFoundError(res)).toBe(true);
  });
});
