import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { electricalFixture, SCHEMATIC } from './support/electrical-diff.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = (repo: string, ...args: string[]) => execa(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--repo', repo, ...args], {
  cwd: ROOT, reject: false, env: { NO_COLOR: '1' },
});

describe('copperhead diff CLI', () => {
  it('runs the real CLI with prose, JSON, default base, and an invalid revision', async () => {
    const { repo, cleanup } = await electricalFixture();
    try {
      const file = path.join(repo, SCHEMATIC);
      await writeFile(file, (await readFile(file, 'utf8')).replaceAll('KEY_DAH', 'KEY_DASH'));
      const prose = await cli(repo, 'diff', '--base', 'HEAD');
      expect(prose.exitCode).toBe(0);
      expect(prose.stdout).toContain('Electrical changes since HEAD');
      expect(prose.stdout).toContain('Renamed: KEY_DAH → KEY_DASH');
      const json = await cli(repo, 'diff', '--base', 'HEAD', '--json');
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout).nets.renamed).toEqual([{ before: 'KEY_DAH', after: 'KEY_DASH' }]);
      expect((await cli(repo, 'diff')).stdout).toContain('Electrical changes since HEAD~1');
      const invalid = await cli(repo, 'diff', '--base', 'not-a-real-revision');
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain('cannot resolve base revision "not-a-real-revision"');
      expect(invalid.stderr).not.toContain('Command failed');
      expect(invalid.stdout).toBe('');
    } finally { await cleanup(); }
  }, 120_000);
});
