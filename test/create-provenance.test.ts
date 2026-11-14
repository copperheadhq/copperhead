import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { tempFixtureRepo } from './helpers.js';
import { writeBriefHash } from '../src/commands/create.js';

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
});
