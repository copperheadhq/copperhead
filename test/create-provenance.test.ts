import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tempFixtureRepo } from './helpers.js';
import { writeBriefHash } from '../src/commands/create.js';
import { checkBriefProvenance, reconcileBriefHash } from '../src/memory/drift.js';
import { syncVerify } from '../src/commands/sync.js';

describe('writeBriefHash', () => {
  it('writes BRIEF.sha256', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
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

  it('detects when BRIEF.md diverges from BRIEF.sha256 and clears after reconcileBriefHash (#413)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      const initialBrief = '# Design Brief\n- 3.3V LDO regulator\n';
      const initialHash = createHash('sha256').update(initialBrief).digest('hex');
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), initialBrief, 'utf8');
      await writeBriefHash(repo, 'docs', {
        path: 'docs/BRIEF.md',
        sha256: initialHash,
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

      const afterReconcile = await checkBriefProvenance(repo, 'docs');
      expect(afterReconcile?.ok).toBe(true);
      expect(afterReconcile?.origin).toBe(initialHash);
      expect(afterReconcile?.recorded).toBe(updatedHash);
    } finally {
      await cleanup();
    }
  });
});
