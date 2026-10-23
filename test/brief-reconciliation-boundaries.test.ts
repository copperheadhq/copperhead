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
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { briefSha256, inspectBriefFreshness, writeReconciliationRecord } from '../src/memory/brief-reconciliation.js';
import { tempFixtureRepo } from './helpers.js';

async function installOrigin(repo: string, briefPath: string, brief: string): Promise<void> {
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  await writeFile(path.join(repo, 'docs', 'BRIEF.md'), brief, 'utf8');
  await writeFile(path.join(repo, 'docs', 'BRIEF.sha256'), `brief: ${briefPath}\nsha256: ${briefSha256(brief)}\n`, 'utf8');
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'install brief origin'], { cwd: repo });
}

describe('brief reconciliation path and git boundaries', () => {
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

      const result = await inspectBriefFreshness(repo, 'docs');
      const blobReads = vi.mocked(execa).mock.calls.filter((call) => {
        const [command, args] = call;
        return command === 'git' && Array.isArray(args) && args[0] === 'cat-file';
      });

      expect(result).toMatchObject({ status: 'current', ok: true });
      expect(blobReads.length).toBeGreaterThan(0);
      expect(JSON.stringify(blobReads)).toContain('"GIT_NO_LAZY_FETCH":"1"');
    } finally {
      await cleanup();
    }
  });
});
