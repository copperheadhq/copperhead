import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toolSearch } from '../src/agent/filetools.js';

describe('search directory globs across platforms', () => {
  it('finds nested OpenSpec files with slash-separated globs and excludes other directories', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-search-'));
    try {
      await mkdir(path.join(repo, 'openspec/specs/power'), { recursive: true });
      await mkdir(path.join(repo, 'docs'));
      await writeFile(path.join(repo, 'openspec/config.yaml'), 'schema: spec-driven\n', 'utf8');
      await writeFile(path.join(repo, 'openspec/specs/power/spec.md'), 'power requirement\n', 'utf8');
      await writeFile(path.join(repo, 'docs/SPEC.md'), 'power requirement\n', 'utf8');
      const hits = await toolSearch(repo, '.', 'openspec/**/*');
      expect(hits.map((hit) => hit.file).sort()).toEqual([
        path.join('openspec', 'config.yaml'), path.join('openspec', 'specs', 'power', 'spec.md'),
      ].sort());
      const narrow = await toolSearch(repo, 'power', 'openspec/specs/**/*.md');
      expect(narrow).toHaveLength(1);
      expect(narrow[0]!.file).toBe(path.join('openspec', 'specs', 'power', 'spec.md'));
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});
