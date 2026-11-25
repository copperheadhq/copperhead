import { describe, expect, it, vi } from 'vitest';

const redirectedRealpaths = vi.hoisted(() => new Map<string, string>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: vi.fn(async (input: Parameters<typeof actual.realpath>[0]) => {
      const redirected = typeof input === 'string' ? redirectedRealpaths.get(input) : undefined;
      return redirected ?? actual.realpath(input);
    }),
  };
});

vi.mock('execa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('execa')>();
  return { ...actual, execa: vi.fn(actual.execa) };
});

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { briefSha256, compareBrief, inspectBriefFreshness, resolveRepositoryLocalBriefPath, writeReconciliationRecord } from '../src/memory/brief-reconciliation.js';
import { tempFixtureRepo } from './helpers.js';

async function installOrigin(repo: string, briefPath: string, brief: string): Promise<void> {
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  await writeFile(path.join(repo, 'docs', 'BRIEF.md'), brief, 'utf8');
  await writeFile(path.join(repo, 'docs', 'BRIEF.sha256'), `brief: ${briefPath}\nsha256: ${briefSha256(brief)}\n`, 'utf8');
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'install brief origin'], { cwd: repo });
}

describe('brief reconciliation path and git boundaries', () => {
  it('accepts the physical brief path when the repository is given through a link', async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brief-alias-')));
    try {
      const repo = path.join(base, 'repo');
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      const brief = path.join(repo, 'docs', 'BRIEF.md');
      await writeFile(brief, '# Brief\n', 'utf8');
      const alias = path.join(base, 'alias');
      const kind = process.platform === 'win32' ? 'junction' : 'dir';
      await symlink(repo, alias, kind);
      expect(await resolveRepositoryLocalBriefPath(alias, brief, { fallbackToRepoRoot: true })).toBe(brief);
      await symlink(path.join(repo, 'docs'), path.join(repo, 'linked'), kind);
      expect(await resolveRepositoryLocalBriefPath(alias, path.join(repo, 'linked', 'BRIEF.md'))).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('reports unknown for an external origin whose conventional brief resolves outside the repo', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await installOrigin(repo, 'external:brief.md', '# Local copy\n');
      const briefPath = path.join(repo, 'docs', 'BRIEF.md');
      redirectedRealpaths.set(briefPath, path.resolve(repo, '..', 'outside-brief.md'));

      const result = await inspectBriefFreshness(repo, 'docs');

      expect(result).toMatchObject({ status: 'unknown', ok: false, reasonCode: 'invalid-origin' });
      expect(result.detail).toContain('symlink');
      expect(existsSync(briefPath)).toBe(true);
    } finally {
      redirectedRealpaths.clear();
      await cleanup();
    }
  });

  it('reports unknown when an in-repo origin brief is missing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await installOrigin(repo, 'docs/BRIEF.md', '# Origin brief\n');
      await unlink(path.join(repo, 'docs', 'BRIEF.md'));

      const result = await inspectBriefFreshness(repo, 'docs');

      expect(result).toMatchObject({ status: 'unknown', ok: false, reasonCode: 'invalid-origin', path: 'docs/BRIEF.md' });
      expect(result.detail).toContain('missing or unreadable');
    } finally {
      await cleanup();
    }
  });

  it('reports unknown for a conventional brief that resolves outside the repo', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = path.join(repo, 'docs', 'BRIEF.md');
      await mkdir(path.dirname(briefPath), { recursive: true });
      await writeFile(briefPath, '# Untrackable brief\n', 'utf8');
      redirectedRealpaths.set(briefPath, path.resolve(repo, '..', 'outside-brief.md'));

      const result = await inspectBriefFreshness(repo, 'docs');

      expect(result).toMatchObject({ status: 'unknown', ok: false, reasonCode: 'invalid-origin' });
      expect(result.detail).toContain('symlink');
      expect(existsSync(briefPath)).toBe(true);
    } finally {
      redirectedRealpaths.clear();
      await cleanup();
    }
  });

  it('passes GIT_NO_LAZY_FETCH to local git blob reads', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const brief = '# Tracked brief\n';
      await installOrigin(repo, 'docs/BRIEF.md', brief);
      const { stdout: blob } = await execa('git', ['rev-parse', 'HEAD:docs/BRIEF.md'], { cwd: repo });
      await writeReconciliationRecord(repo, {
        schemaVersion: 1,
        briefPath: 'docs/BRIEF.md',
        sha256: briefSha256(brief),
        gitBlob: blob.trim(),
        refusals: [],
      });
      vi.mocked(execa).mockClear();

      const result = await compareBrief(repo, 'docs');
      const blobReads = vi.mocked(execa).mock.calls.filter((call) => {
        const [command, args] = call;
        return command === 'git' && Array.isArray(args) && args[0] === 'cat-file';
      });

      expect(result).toMatchObject({ status: 'current' });
      expect(blobReads.length).toBeGreaterThan(0);
      expect(JSON.stringify(blobReads)).toContain('"GIT_NO_LAZY_FETCH":"1"');
    } finally {
      await cleanup();
    }
  });

  it('does not read a Git blob when an older Git cannot disable lazy fetch in a partial clone', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const brief = '# Tracked brief\n';
      await installOrigin(repo, 'docs/BRIEF.md', brief);
      const { stdout: blob } = await execa('git', ['rev-parse', 'HEAD:docs/BRIEF.md'], { cwd: repo });
      await writeReconciliationRecord(repo, {
        schemaVersion: 1,
        briefPath: 'docs/BRIEF.md',
        sha256: briefSha256(brief),
        gitBlob: blob.trim(),
        refusals: [],
      });
      vi.mocked(execa).mockClear();
      vi.mocked(execa)
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'origin' } as never)
        .mockResolvedValueOnce({ exitCode: 129, stdout: '' } as never);

      const result = await compareBrief(repo, 'docs');

      expect(result).toMatchObject({ status: 'unknown', baseline: 'reconciled' });
      expect(result.detail).toContain('Git 2.45 or newer');
      expect(vi.mocked(execa).mock.calls.some(([, args]) => Array.isArray(args) && args[0] === 'cat-file')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')('accepts repository paths whose casing differs from the on-disk casing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), '# Brief\n', 'utf8');

      expect(await resolveRepositoryLocalBriefPath(repo, path.join(repo, 'DOCS', 'brief.md'))).toBe(path.join(repo, 'docs', 'BRIEF.md'));
    } finally {
      await cleanup();
    }
  });
});
