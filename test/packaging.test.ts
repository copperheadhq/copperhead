import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('npm package manifest', () => {
  // The working checkout always has examples/ on disk, so a test that merely
  // checks existsSync(defaultBriefPath()) stays green whether or not
  // package.json's `files` actually ships it — that's exactly how the
  // "demo brief missing" bug (fixed by this PR) went unnoticed through the
  // whole 0.10.0 release. Asserting on the real tarball contents, not the
  // `files` array literal, is what makes this a guard rather than a restatement
  // of the diff.
  it('ships the demo brief that defaultBriefPath() resolves to', () => {
    const stdout = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: root, encoding: 'utf8' },
    );
    const parsed: unknown = JSON.parse(stdout);
    // npm's `pack --json` shape has changed across major versions: an array
    // of pack results (older npm) vs. an object keyed by package name (npm
    // 12+). Accept either so this test isn't pinned to one npm version.
    const [pack] = (Array.isArray(parsed) ? parsed : Object.values(parsed as object)) as {
      files: { path: string }[];
    }[];
    const paths = pack!.files.map((f) => f.path);
    expect(paths).toContain('examples/simple/usb-c-breakout.md');
  });
});
