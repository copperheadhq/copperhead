import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';
import { withWorktreeOwnership, writeFile } from '../src/util/worktree-ownership.js';
import { commitAll } from '../src/util/git.js';
const transport = vi.hoisted(() => ({ intercept: vi.fn(), seen: [] as string[][] }));
vi.mock('execa', async (original) => {
  const actual = await original<typeof import('execa')>();
  return { ...actual, execa: (command: string, args: string[], options: object) => {
    if (command === 'git') {
      transport.seen.push([...args]);
      const replaced = transport.intercept(args, options, actual.execa);
      if (replaced !== undefined) return replaced;
    }
    return actual.execa(command, args, options);
  } };
});
afterEach(() => { transport.intercept.mockReset(); transport.seen.length = 0; });
const git = async (repo: string, ...args: string[]) => (await execa('git', args, { cwd: repo })).stdout;
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

describe('scoped commit hooks and publication', () => {
  it('refuses unsupported Git before entering the mutation callback', async () => {
    const f = await tempFixtureRepo(); let entered = false;
    try {
      transport.intercept.mockImplementation((args) => args.join(' ') === '--version' ? Promise.resolve({ stdout: 'git version 2.35.9' }) : undefined);
      await expect(withWorktreeOwnership(f.repo, async () => { entered = true; })).rejects.toThrow(/Git 2.36 or newer/);
      expect(entered).toBe(false);
    } finally { await f.cleanup(); }
  });
  it('requests signing when configured, without requiring a test signing key', async () => {
    const f = await tempFixtureRepo();
    try {
      transport.intercept.mockImplementation((args, options, real) => {
        if (args.join(' ') === 'config --bool commit.gpgsign') return Promise.resolve({ stdout: 'true' });
        if (args[0] === 'commit-tree') return real('git', args.filter((arg: string) => arg !== '-S'), options);
      });
      await withWorktreeOwnership(f.repo, async () => {
        await writeFile(path.join(f.repo, 'owned.txt'), 'owned');
        expect(await commitAll(f.repo, 'signed request')).toBeTruthy();
        expect(transport.seen.find((args) => args[0] === 'commit-tree')).toContain('-S');
      });
    } finally { await f.cleanup(); }
  });
  it('runs prepare-commit-msg, commit-msg and post-commit in order', async () => {
    const f = await tempFixtureRepo(); const log = f.repo + '-hooks.log';
    try {
      for (const [hook, body] of [
        ['prepare-commit-msg', `printf 'prepared\\n' >> ${quote(log)}\nprintf 'prepared message\\n' > "$1"`],
        ['commit-msg', `printf 'checked\\n' >> ${quote(log)}`],
        ['post-commit', `printf 'posted\\n' >> ${quote(log)}`],
      ]) {
        const file = path.join(f.repo, '.git', 'hooks', hook);
        await fs.writeFile(file, '#!/bin/sh\n' + body + '\n'); await fs.chmod(file, 0o755);
      }
      await withWorktreeOwnership(f.repo, async () => {
        await writeFile(path.join(f.repo, 'owned.txt'), 'owned'); await commitAll(f.repo, 'original');
        expect(await git(f.repo, 'log', '-1', '--format=%s')).toBe('prepared message');
        expect(await fs.readFile(log, 'utf8')).toBe('prepared\nchecked\nposted\n');
      });
    } finally { await fs.rm(log, { force: true }); await f.cleanup(); }
  });
  for (const race of ['HEAD', 'index'] as const) {
    it(`preserves an external ${race} change during commit publication`, async () => {
      const f = await tempFixtureRepo(); let expectedHead = '';
      try {
        transport.intercept.mockImplementation((args, options, real) => {
          if (args[0] !== 'update-ref') return;
          return (async () => {
            const result = await real('git', args, options);
            if (race === 'HEAD') {
              const tree = (await real('git', ['rev-parse', 'HEAD^{tree}'], { cwd: f.repo })).stdout;
              const parent = (await real('git', ['rev-parse', 'HEAD'], { cwd: f.repo })).stdout;
              expectedHead = (await real('git', ['commit-tree', tree, '-p', parent, '-m', 'external'], { cwd: f.repo })).stdout;
              await real('git', ['update-ref', 'HEAD', expectedHead, parent], { cwd: f.repo });
            } else {
              await fs.writeFile(path.join(f.repo, 'human.txt'), 'staged outside');
              await real('git', ['add', 'human.txt'], { cwd: f.repo });
            }
            return result;
          })();
        });
        await withWorktreeOwnership(f.repo, async () => {
          await writeFile(path.join(f.repo, 'owned.txt'), 'owned');
          await expect(commitAll(f.repo, 'run')).rejects.toThrow(/changed during commit/);
          if (race === 'HEAD') expect(await git(f.repo, 'rev-parse', 'HEAD')).toBe(expectedHead);
          else expect(await git(f.repo, 'show', ':human.txt')).toBe('staged outside');
        });
      } finally { await f.cleanup(); }
    });
  }
});
