import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';
import { emitJlcpcbAfterOutputs } from '../src/commands/create.js';
import { commitAll } from '../src/util/git.js';

// #379: the JLCPCB BOM is emitted after the outputs stage commits. Left dirty,
// the next commit (stage 7's, or a resume's "commit completed stage
// spec-seed") swept it in under another stage's name.

const BOM =
  '# b\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | RC0603FR-0710KL | bias |\n';

async function seedBom(repo: string): Promise<void> {
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  await writeFile(path.join(repo, 'docs', 'BOM.md'), BOM, 'utf8');
  // Through commitAll, as the real stage commit is.
  await commitAll(repo, 'copperhead: create pipeline stage: outputs');
}

async function run(repo: string): Promise<string[]> {
  const lines: string[] = [];
  await emitJlcpcbAfterOutputs('outputs', {
    repoRoot: repo,
    briefPath: '',
    model: 'gpt-5',
    log: (s) => lines.push(s),
  });
  return lines;
}

const git = async (repo: string, args: string[]) => (await execa('git', args, { cwd: repo })).stdout;

describe('JLCPCB BOM commit after the outputs stage (#379)', () => {
  it('commits the CSV under the outputs stage, leaving the tree clean', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await seedBom(repo);
      await run(repo);
      expect(await git(repo, ['status', '--porcelain'])).toBe('');
      expect(await git(repo, ['log', '-1', '--format=%s'])).toBe(
        'copperhead: create pipeline stage: outputs (JLCPCB assembly BOM)',
      );
      expect(await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe('outputs/jlcpcb-bom.csv');
    } finally {
      await cleanup();
    }
  });

  it('makes no commit when a resumed run re-emits an unchanged CSV', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await seedBom(repo);
      await run(repo);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      await run(repo);
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    } finally {
      await cleanup();
    }
  });

  it('leaves the CSV uncommitted when other paths are dirty, sweeping nothing in', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await seedBom(repo);
      await writeFile(path.join(repo, 'my-notes.txt'), 'do not touch\n', 'utf8');
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const lines = await run(repo);
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(lines.join('\n')).toContain('left outputs/jlcpcb-bom.csv uncommitted');
    } finally {
      await cleanup();
    }
  });

  it('does nothing for any other stage', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await seedBom(repo);
      const lines: string[] = [];
      await emitJlcpcbAfterOutputs('firmware', { repoRoot: repo, briefPath: '', model: 'gpt-5', log: (s) => lines.push(s) });
      expect(lines).toEqual([]);
      expect(await git(repo, ['status', '--porcelain'])).toBe('');
    } finally {
      await cleanup();
    }
  });
});
