import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { tempFixtureRepo } from './helpers.js';
import { writeBriefHash } from '../src/commands/create.js';
import { checkBriefProvenance, reconcileBriefHash } from '../src/memory/drift.js';
import { syncVerify } from '../src/commands/sync.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('writeBriefHash', () => {
  it('writes BRIEF.sha256', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });

      await writeBriefHash(repo, 'docs', {
        path: 'brief.md',
        sha256: 'abc123',
      });

      const text = await readFile(
        path.join(repo, 'docs', 'BRIEF.sha256'),
        'utf8',
      );

      expect(text).toContain('brief.md');
      expect(text).toContain('abc123');
    } finally {
      await cleanup();
    }
  });

  it('does not overwrite an existing BRIEF.sha256', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });

      await writeBriefHash(repo, 'docs', {
        path: 'brief.md',
        sha256: '111111',
      });

      await writeBriefHash(repo, 'docs', {
        path: 'other.md',
        sha256: '222222',
      });

      const text = await readFile(
        path.join(repo, 'docs', 'BRIEF.sha256'),
        'utf8',
      );

      expect(text).toContain('111111');
      expect(text).not.toContain('222222');
      expect(text).not.toContain('other.md');
    } finally {
      await cleanup();
    }
  });

  it('snapshots an external brief into docs/BRIEF.md so in-repo checks succeed', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      const content = '# External Brief\n- USB-C PD sink\n';
      const digest = createHash('sha256').update(content).digest('hex');
      await writeBriefHash(
        repo,
        'docs',
        { path: 'external:outside.md', sha256: digest },
        content,
      );

      expect(existsSync(path.join(repo, 'docs', 'BRIEF.md'))).toBe(true);
      const status = await checkBriefProvenance(repo, 'docs');
      expect(status?.ok).toBe(true);
      expect(status?.recorded).toBe(digest);
    } finally {
      await cleanup();
    }
  });

  it('detects when BRIEF.md diverges from BRIEF.sha256 and clears after reconcileBriefHash (#413)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'DECISIONS.md'), '# Decision log\n', 'utf8');
      await writeFile(path.join(repo, 'docs', 'CHANGELOG.md'), '# Design changelog\n', 'utf8');
      const initialBrief = '# Design Brief\n- 3.3V LDO regulator\n';
      const initialHash = createHash('sha256').update(initialBrief).digest('hex');
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), initialBrief, 'utf8');
      await writeBriefHash(repo, 'docs', {
        path: 'docs/BRIEF.md',
        sha256: initialHash.toUpperCase(),
      });

      const cleanStatus = await checkBriefProvenance(repo, 'docs');
      expect(cleanStatus).toEqual({
        ok: true,
        path: 'docs/BRIEF.md',
        recorded: initialHash,
        origin: initialHash,
        current: initialHash,
      });

      const updatedBrief = initialBrief + '- 100 nF ceramic decoupling cap near U1\n';
      const updatedHash = createHash('sha256').update(updatedBrief).digest('hex');
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), updatedBrief, 'utf8');

      const divergedStatus = await checkBriefProvenance(repo, 'docs');
      expect(divergedStatus?.ok).toBe(false);
      expect(divergedStatus?.recorded).toBe(initialHash);
      expect(divergedStatus?.current).toBe(updatedHash);

      const syncReport = await syncVerify(repo);
      expect(syncReport.resolvable.some((item) => item.doc === 'docs/BRIEF.md')).toBe(true);

      const reconciled = await reconcileBriefHash(repo, 'docs');
      expect(reconciled.ok).toBe(true);
      expect(reconciled.recorded).toBe(updatedHash);
      expect(reconciled.origin).toBe(initialHash);

      const decisions = await readFile(path.join(repo, 'docs', 'DECISIONS.md'), 'utf8');
      const changelog = await readFile(path.join(repo, 'docs', 'CHANGELOG.md'), 'utf8');
      expect(decisions).toContain(updatedHash.slice(0, 8));
      expect(changelog).toContain(updatedHash.slice(0, 8));

      const afterReconcile = await checkBriefProvenance(repo, 'docs');
      expect(afterReconcile?.ok).toBe(true);
      expect(afterReconcile?.origin).toBe(initialHash);
      expect(afterReconcile?.recorded).toBe(updatedHash);
    } finally {
      await cleanup();
    }
  });

  it('rejects brief paths that escape the repository and flags missing brief files (#413)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(
        path.join(repo, 'docs', 'BRIEF.sha256'),
        'brief: ../../../etc/passwd\nsha256: aabbccddeeff\n',
        'utf8',
      );
      const traversal = await checkBriefProvenance(repo, 'docs');
      expect(traversal?.ok).toBe(false);
      expect(traversal?.current).toBe('outside-repo');

      const report = await syncVerify(repo);
      expect(report.violations.some((v) => v.description.includes('outside the repository'))).toBe(true);

      await writeFile(
        path.join(repo, 'docs', 'BRIEF.sha256'),
        'brief: docs/MISSING_BRIEF.md\nsha256: aabbccddeeff\n',
        'utf8',
      );
      await rm(path.join(repo, 'docs', 'BRIEF.md'), { force: true });
      const missing = await checkBriefProvenance(repo, 'docs');
      expect(missing?.ok).toBe(false);
      expect(missing?.current).toBe('missing');
    } finally {
      await cleanup();
    }
  });

  it('supports sync --brief --dry-run without modifying BRIEF.sha256 (#413)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      const b1 = '# Brief v1\n';
      const h1 = createHash('sha256').update(b1).digest('hex');
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), b1, 'utf8');
      await writeBriefHash(repo, 'docs', { path: 'docs/BRIEF.md', sha256: h1 });

      const b2 = '# Brief v2\n';
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), b2, 'utf8');
      const beforeShaFile = await readFile(path.join(repo, 'docs', 'BRIEF.sha256'), 'utf8');

      const res = await execa(
        'npx',
        ['tsx', 'src/cli.ts', '--repo', repo, '--json', 'sync', '--brief', '--dry-run'],
        { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } },
      );
      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout) as { brief?: { ok: boolean; recorded: string; current: string } };
      expect(parsed.brief?.ok).toBe(false);
      expect(parsed.brief?.recorded).toBe(h1);
      expect(await readFile(path.join(repo, 'docs', 'BRIEF.sha256'), 'utf8')).toBe(beforeShaFile);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
