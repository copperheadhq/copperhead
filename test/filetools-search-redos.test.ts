import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  toolSearch,
  compileSafeSearchRegex,
  hasCatastrophicBacktracking,
} from '../src/agent/filetools.js';

describe('toolSearch ReDoS and complexity guards (#366)', () => {
  it('detects nested quantifiers and backreferences prone to catastrophic backtracking', () => {
    expect(hasCatastrophicBacktracking('(a+)+$')).toBe(true);
    expect(hasCatastrophicBacktracking('([a-z]+)*b')).toBe(true);
    expect(hasCatastrophicBacktracking('(?:\\w+){2,}')).toBe(true);
    expect(hasCatastrophicBacktracking('(a+)\\1+')).toBe(true);

    // Normal safe regexes used during KiCad and doc inspection must pass
    expect(hasCatastrophicBacktracking('^##\\s+1\\.\\s+Electrical')).toBe(false);
    expect(hasCatastrophicBacktracking('\\(property\\s+"Reference"\\s+"R[0-9]+"')).toBe(false);
    expect(hasCatastrophicBacktracking('([A-Z]+[0-9]+)')).toBe(false);
    expect(hasCatastrophicBacktracking('[a+]+')).toBe(false);
  });

  it('rejects pathological, overlong, or syntactically invalid patterns before walking the repo', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'copperhead-search-redos-'));
    try {
      await writeFile(path.join(root, 'notes.md'), `${'a'.repeat(5000)}!\n`, 'utf8');

      const t0 = Date.now();
      await expect(toolSearch(root, '(a+)+$')).rejects.toThrow(/catastrophic backtracking/i);
      expect(Date.now() - t0).toBeLessThan(100);

      await expect(toolSearch(root, 'x'.repeat(600))).rejects.toThrow(/exceeds maximum/i);
      await expect(toolSearch(root, '[unclosed')).rejects.toThrow(/invalid regular expression/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds per-line evaluation length and returns normal matches accurately', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'copperhead-search-ok-'));
    try {
      await writeFile(
        path.join(root, 'SPEC.md'),
        '# Board\n\n- vbus_max_V: 5.5\n- continuous_current_A: 3.0\n',
        'utf8',
      );
      const hits = await toolSearch(root, 'vbus_max_V:\\s*5\\.5');
      expect(hits).toEqual([{ file: 'SPEC.md', line: 3, text: '- vbus_max_V: 5.5' }]);
      expect(() => compileSafeSearchRegex('continuous_current_A')).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
