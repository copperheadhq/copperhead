import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import path from 'node:path';
import { tempFixtureRepo } from './helpers.js';
import { prepareFirmwareBuildArtifacts } from '../src/commands/firmware-build.js';

describe('explicit SDK compiler artifact bookkeeping (real local Git, no provider)', () => {
  it('untracks only managed build copies, retaining bytes, source and original commit history', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const artifact = '.copperhead/firmware-build/old/attempt-1/build/app.bin';
      await mkdir(path.dirname(path.join(repo, artifact)), { recursive: true });
      await writeFile(path.join(repo, artifact), 'test binary bytes');
      await writeFile(path.join(repo, '.gitignore'), '# existing ignore\n');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-m', 'fixture with old managed build copy'], { cwd: repo });
      const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout;
      const board = await readFile(path.join(repo, 'hardware/open-key.kicad_sch'));
      await prepareFirmwareBuildArtifacts(repo);
      expect((await execa('git', ['ls-files', '--', artifact], { cwd: repo })).stdout).toBe('');
      expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout).toBe(head);
      expect(await readFile(path.join(repo, artifact), 'utf8')).toBe('test binary bytes');
      expect(await readFile(path.join(repo, 'hardware/open-key.kicad_sch'))).toEqual(board);
      expect((await execa('git', ['check-ignore', artifact], { cwd: repo })).stdout).toBe(artifact);
      await prepareFirmwareBuildArtifacts(repo);
      expect((await readFile(path.join(repo, '.gitignore'), 'utf8')).match(/\.copperhead\/firmware-build\//g)).toHaveLength(1);
    } finally { await cleanup(); }
  });
});
