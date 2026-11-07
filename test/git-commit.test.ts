import { describe, it, expect } from 'vitest';
import { writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';
import { commitAll } from '../src/util/git.js';

describe('git commitAll with pre-commit hooks', () => {
  it('bypasses the pre-commit hook using --no-verify', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const hooksDir = path.join(repo, '.git', 'hooks');
      const hookPath = path.join(hooksDir, 'pre-commit');
      
      // Install a pre-commit hook that always fails
      const script = `#!/bin/sh\nexit 1\n`;
      await writeFile(hookPath, script, 'utf8');
      await chmod(hookPath, 0o755);

      // Create a change in the repo
      await writeFile(path.join(repo, 'dummy.txt'), 'hello', 'utf8');

      // Call commitAll, which should succeed because it bypasses the hook
      const commitSha = await commitAll(repo, 'test commit bypassing hook');
      expect(commitSha).toBeDefined();
      expect(commitSha.length).toBeGreaterThan(0);

      // Verify the commit actually exists in git log
      const { stdout } = await execa('git', ['log', '-1', '--format=%s'], { cwd: repo });
      expect(stdout.trim()).toBe('test commit bypassing hook');
    } finally {
      await cleanup();
    }
  });
});
