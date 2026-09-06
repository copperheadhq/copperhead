import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { runCheck } from '../src/commands/check.js';
import { syncVerify } from '../src/commands/sync.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The MCP server calls the command entry points directly rather than shelling
 * out to the CLI, which is only safe while both produce the same object. These
 * tests pin that: if a CLI action starts reshaping its result before printing,
 * the server would silently start reporting something else, and this fails.
 */
const cli = (repo: string, args: string[]) =>
  execa('npx', ['tsx', 'src/cli.ts', '--repo', repo, '--json', ...args], {
    cwd: ROOT,
    reject: false,
    env: { NO_COLOR: '1' },
  });

describe('entry-point results are byte-identical to the CLI --json output', () => {
  it('runCheck matches `check --json`', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, force: false, installHooks: false });
      const direct = JSON.stringify(await runCheck(repo, () => {}), null, 2);
      const res = await cli(repo, ['check']);
      expect(res.stdout.trim()).toBe(direct.trim());
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('syncVerify matches `sync --dry-run --json`', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, force: false, installHooks: false });
      const direct = JSON.stringify(await syncVerify(repo), null, 2);
      const res = await cli(repo, ['sync', '--dry-run']);
      expect(res.stdout.trim()).toBe(direct.trim());
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('runInit matches `init --json`', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // Run the CLI first on a virgin repo, then the entry point on a second
      // virgin repo: init is idempotent, so a second run on the same repo would
      // report "unchanged" and compare nothing useful.
      const res = await cli(repo, ['init']);
      const second = await tempFixtureRepo();
      try {
        const direct = JSON.stringify(
          await runInit({ repoRoot: second.repo, searchPath: '.', force: false, installHooks: true }),
          null,
          2,
        );
        expect(res.stdout.trim()).toBe(direct.trim());
      } finally {
        await second.cleanup();
      }
    } finally {
      await cleanup();
    }
  }, 120_000);
});
