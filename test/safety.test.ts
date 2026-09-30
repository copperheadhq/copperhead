import { describe, it, expect, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInRepo, SandboxError, isKicadFile } from '../src/util/paths.js';
import { redactSecrets } from '../src/util/redact.js';
import { withRetry } from '../src/util/retry.js';
import { toolWriteFile, toolEditFile, toolSearch } from '../src/agent/filetools.js';
import { Transcript } from '../src/agent/transcript.js';
import { isDirty, hasCommits, snapshot, restore } from '../src/util/git.js';
import { PreflightError } from '../src/util/preflight.js';
import { tempFixtureRepo } from './helpers.js';
import { execa } from 'execa';

describe('path sandbox (AC-4.2)', () => {
  it('rejects traversal outside the repo root', () => {
    expect(() => resolveInRepo('/repo', '../../etc/hosts')).toThrow(SandboxError);
    expect(() => resolveInRepo('/repo', '/etc/hosts')).toThrow(SandboxError);
  });

  it('accepts repo-relative paths including the root itself', () => {
    expect(resolveInRepo('/repo', 'docs/BOM.md')).toBe(path.resolve('/repo', 'docs/BOM.md'));
    expect(resolveInRepo('/repo', '.')).toBe(path.resolve('/repo'));
  });

  it('does not treat sibling dirs with a shared prefix as inside', () => {
    expect(() => resolveInRepo('/repo', '../repo-evil/x')).toThrow(SandboxError);
  });
});

describe('secret redaction (AC-4.1)', () => {
  it('redacts sk- keys and bearer tokens', () => {
    const input = 'key=sk-abc123DEF456ghi789jkl012 Authorization: Bearer abcdefghijklmnop123456';
    const out = redactSecrets(input);
    expect(out).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts registry and forge tokens, not just model keys', () => {
    // Synthetic tokens: correct shape, never valid.
    const input = [
      'npm_0000000000000000000000000000000000AA',
      'ghp_0000000000000000000000000000000000BB',
      'github_pat_0000000000000000000000_CCCC',
    ].join(' ');
    const out = redactSecrets(input);
    expect(out).not.toMatch(/npm_[A-Za-z0-9]{36,}/);
    expect(out).not.toMatch(/gh[pousr]_[A-Za-z0-9]{36,}/);
    expect(out).not.toMatch(/github_pat_/);
    expect(out).toBe('[REDACTED] [REDACTED] [REDACTED]');
  });

  it('redacts a base64 bearer token whole, leaving no tail', () => {
    // Synthetic token: correct shape, never valid. Standard base64 uses +, /
    // and =; a charset that stops at the first one writes the rest to disk.
    const input = 'Bearer ABCDEFGHIJKLMNOP+SECRETTAILabcdef/MORESECRET=';
    const out = redactSecrets(input);

    expect(out).toBe('[REDACTED]');
    expect(out).not.toContain('SECRETTAIL');
    expect(out).not.toContain('MORESECRET');
  });

  it('redacts bearer tokens regardless of scheme casing', () => {
    // HTTP auth schemes are case-insensitive (RFC 7235 §2.1).
    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
      const out = redactSecrets(`authorization: ${scheme} abcdefghijklmnopqrst`);
      expect(out, scheme).toBe('authorization: [REDACTED]');
    }
  });

  it('redacts npm tokens that contain dashes', () => {
    // npm also issues UUID-shaped tokens. Synthetic, never valid.
    const out = redactSecrets('npm_0123456789abcdef-0123-4567-89ab-cdef01234567');
    expect(out).toBe('[REDACTED]');
  });

  it('redacts Gemini and Groq keys', () => {
    // Synthetic, correctly-shaped, never valid.
    const input = [
      'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBc',
      'gsk_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
    ].join(' ');
    const out = redactSecrets(input);
    expect(out).not.toMatch(/AIzaSy[A-Za-z0-9_-]{10,}/);
    expect(out).not.toMatch(/gsk_[A-Za-z0-9]{10,}/);
    expect(out).toBe('[REDACTED] [REDACTED]');
  });

  it('redacts a Google key with a prefix other than AIzaSy — regression', () => {
    // AIzaSy is the common fifth/sixth pair but not the only one Google
    // issues; the pattern must match on AIza alone.
    const out = redactSecrets('AIzaBcD1234567890abcdefghijklmnopqrstu');
    expect(out).toBe('[REDACTED]');
  });

  it('leaves ordinary prose alone', () => {
    // The patterns are deliberately broad, but not so broad that a run summary
    // loses readable text.
    for (const text of [
      'the bearer of this note',
      'Bearer token missing',
      'a npm_ package name',
      'see the github_pat docs',
      'a gsk_ prefixed identifier',
      'an AIza-prefixed placeholder',
    ]) {
      expect(redactSecrets(text), text).toBe(text);
    }
  });

  it('transcript and summary are redacted at write time', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    const t = new Transcript(dir);
    await t.init();
    await t.event('test', { secret: 'sk-abc123DEF456ghi789jkl012' });
    const summaryPath = await t.writeSummary({
      request: 'uses sk-abc123DEF456ghi789jkl012',
      changeId: null,
      plan: null,
      filesTouched: [],
      ercResult: null,
      drcResult: null,
      decisions: [],
      tokensIn: 0,
      tokensOut: 0,
      outcome: 'success',
      openObligations: null,
    });
    const jsonl = await readFile(t.jsonlPath, 'utf8');
    const summary = await readFile(summaryPath, 'utf8');
    expect(jsonl).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(summary).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
  });

  it('recreates its audit directory when rollback removed it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    const t = new Transcript(dir);
    await t.init();
    await rm(t.dir, { recursive: true, force: true });

    await t.event('run-failed', { reason: 'repair budget exhausted' });
    const summaryPath = await t.writeSummary({
      request: 'test rollback recovery',
      changeId: null,
      plan: null,
      filesTouched: [],
      ercResult: null,
      drcResult: null,
      decisions: [],
      tokensIn: 0,
      tokensOut: 0,
      outcome: 'failure',
      openObligations: null,
    });

    expect(await readFile(t.jsonlPath, 'utf8')).toContain('run-failed');
    expect(await readFile(summaryPath, 'utf8')).toContain('# Run summary');
  });
});

describe('file tools', () => {
  it('write_file refuses KiCad files and overwrites', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    await expect(toolWriteFile(dir, 'x.kicad_sch', 'nope')).rejects.toThrow(/refuses KiCad/);
    await toolWriteFile(dir, 'a.md', 'hello');
    await expect(toolWriteFile(dir, 'a.md', 'again')).rejects.toThrow(/overwrite/);
  });

  it('edit_file requires a unique anchor with actionable errors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    await writeFile(path.join(dir, 'f.txt'), 'aaa\nbbb\naaa\n');
    await expect(toolEditFile(dir, 'f.txt', 'zzz', 'x')).rejects.toThrow(/not found/);
    await expect(toolEditFile(dir, 'f.txt', 'aaa', 'x')).rejects.toThrow(/matched 2 times/);
    await toolEditFile(dir, 'f.txt', 'bbb', 'ccc');
    expect(await readFile(path.join(dir, 'f.txt'), 'utf8')).toBe('aaa\nccc\naaa\n');
  });

  it('search finds regex matches with glob filtering', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    await writeFile(path.join(dir, 'a.md'), 'KEY_DAH here');
    await writeFile(path.join(dir, 'b.txt'), 'KEY_DAH there');
    const all = await toolSearch(dir, 'KEY_DAH');
    expect(all).toHaveLength(2);
    const mdOnly = await toolSearch(dir, 'KEY_DAH', '**/*.md');
    expect(mdOnly).toHaveLength(1);
    expect(mdOnly[0]!.file).toBe('a.md');
  });

  it('isKicadFile covers the design formats', () => {
    expect(isKicadFile('a/b.kicad_sch')).toBe(true);
    expect(isKicadFile('a/b.kicad_pcb')).toBe(true);
    expect(isKicadFile('a/b.md')).toBe(false);
  });
});

describe('retry', () => {
  it('backs off on 429 then succeeds', async () => {
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('rate'), { status: 429 });
        return 'ok';
      },
      { sleep: async () => {} },
    );
    expect(res).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry non-429 errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('boom');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});

describe('git guard (AC-3.8, AC-3.6)', () => {
  it('hasCommits distinguishes an unborn HEAD from a committed repo', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    expect(await hasCommits(dir)).toBe(false); // not a repo at all
    await execa('git', ['init', '-q'], { cwd: dir });
    expect(await hasCommits(dir)).toBe(false); // repo, but no commits yet
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await hasCommits(repo)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('a rollback gives back untracked work instead of deleting it', async () => {
    // Regression: `git stash create` only ever captures tracked changes, so
    // restore()'s `git clean -fd` used to wipe every file the user had not
    // added yet, with nothing to recover them from. The dirty-tree preflight
    // promises the opposite ("copperhead preserve them via git stash create").
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const tracked = await readFile(sch, 'utf8');
      await writeFile(sch, tracked.replace('KEY_DAH', 'KEY_EDITED'), 'utf8');
      await writeFile(path.join(repo, 'hand-written-notes.md'), 'do not lose me\n', 'utf8');
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'new-doc.md'), 'nested and untracked\n', 'utf8');

      // The snapshot is taken with the tree already dirty, exactly as a run
      // started with --allow-dirty does.
      const snap = await snapshot(repo);
      await writeFile(sch, tracked.replace('KEY_DAH', 'KEY_RUINED_BY_THE_AGENT'), 'utf8');
      await writeFile(path.join(repo, 'agent-scratch.txt'), 'created by the failed run\n', 'utf8');

      await restore(repo, snap);

      // The user's uncommitted edit and both untracked files come back...
      expect(await readFile(sch, 'utf8')).toBe(tracked.replace('KEY_DAH', 'KEY_EDITED'));
      expect(await readFile(path.join(repo, 'hand-written-notes.md'), 'utf8')).toBe('do not lose me\n');
      expect(await readFile(path.join(repo, 'docs', 'new-doc.md'), 'utf8')).toBe('nested and untracked\n');
      // ...and the failed run's own scratch file does not.
      expect(existsSync(path.join(repo, 'agent-scratch.txt'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('a failed untracked restore still rolls back the tracked state', async () => {
    // The untracked replay is best-effort: it runs after `stash apply`, so if
    // it throws, the tracked rollback is already done and must be kept. A
    // corrupt snapshot (tree sha that no longer resolves) is the real-world
    // shape of that failure — an unreachable object pruned before rollback.
    const { repo, cleanup } = await tempFixtureRepo();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const tracked = await readFile(sch, 'utf8');
      await writeFile(sch, tracked.replace('KEY_DAH', 'KEY_EDITED'), 'utf8');
      await writeFile(path.join(repo, 'hand-written-notes.md'), 'do not lose me\n', 'utf8');

      const snap = await snapshot(repo);
      expect(snap.untracked).not.toBeNull();
      await writeFile(sch, tracked.replace('KEY_DAH', 'KEY_RUINED_BY_THE_AGENT'), 'utf8');

      // A tree sha that does not resolve: read-tree fails, restoreUntracked throws.
      await expect(restore(repo, { ...snap, untracked: '0'.repeat(40) })).resolves.toBeUndefined();

      expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringContaining('could not restore untracked files after rollback'),
      );
      // The tracked rollback survived the failure, up to and including the
      // user's uncommitted edit replayed from the stash object.
      expect(await readFile(sch, 'utf8')).toBe(tracked.replace('KEY_DAH', 'KEY_EDITED'));
      // The untracked file is the part that is genuinely lost: pinned so a
      // future partial replay cannot pass this test by half-restoring.
      expect(existsSync(path.join(repo, 'hand-written-notes.md'))).toBe(false);
    } finally {
      warn.mockRestore();
      await cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('refuses the run, naming the file, when an untracked path cannot be read', async () => {
    // Regression: every untracked path went straight into `git update-index`,
    // which aborts the whole batch on the first it cannot open. snapshot() runs
    // before the first turn, so one stray root-owned or mode-000 file refused
    // the run with a bare "fatal: Unable to process path ..." and no hint that
    // copperhead was taking a snapshot.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, 'tracked-change.txt'), 'x', 'utf8');
      const locked = path.join(repo, 'unreadable.bin');
      await writeFile(locked, 'secret\n', 'utf8');
      await chmod(locked, 0o000);

      await expect(snapshot(repo)).rejects.toThrow(PreflightError);
      await expect(snapshot(repo)).rejects.toThrow(/unreadable\.bin/);
      // The refusal has to be actionable, not just a git error surfaced raw.
      await expect(snapshot(repo)).rejects.toThrow(/--allow-dirty/);

      // Readable again: the snapshot goes through and captures it.
      await chmod(locked, 0o644);
      const snap = await snapshot(repo);
      const tree = await execa('git', ['ls-tree', '-r', '--name-only', snap.untracked!], { cwd: repo });
      expect(tree.stdout.split('\n')).toContain('unreadable.bin');
    } finally {
      await cleanup();
    }
  });

  it('ignores an untracked file that vanishes between listing and snapshot', async () => {
    // The benign half of the same race: a watcher or build step deleting its
    // own temp file must not refuse the run, because a file that no longer
    // exists cannot be lost to the rollback.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, 'keep-me.txt'), 'keep\n', 'utf8');
      const doomed = path.join(repo, 'vanishes.tmp');
      await writeFile(doomed, 'transient\n', 'utf8');
      // Deleted after git listed it, which is what the race amounts to.
      const listed = await execa('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repo });
      expect(listed.stdout.split('\n')).toContain('vanishes.tmp');
      await rm(doomed, { force: true });

      const snap = await snapshot(repo);
      const tree = await execa('git', ['ls-tree', '-r', '--name-only', snap.untracked!], { cwd: repo });
      expect(tree.stdout.split('\n')).toContain('keep-me.txt');
      expect(tree.stdout).not.toContain('vanishes.tmp');
    } finally {
      await cleanup();
    }
  });

  it('does not resurrect gitignored files, which the rollback never deletes', async () => {
    // Symmetry check: `ls-files --exclude-standard` skips ignored paths and
    // plain `clean -fd` (no -x) leaves them alone, so neither side touches
    // them and .env cannot be swept into a snapshot object.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, '.env'), 'OPENAI_API_KEY=sk-should-never-be-captured\n', 'utf8');
      await writeFile(path.join(repo, 'tracked-change.txt'), 'x', 'utf8');
      const snap = await snapshot(repo);
      expect(snap.untracked).not.toBeNull();

      await restore(repo, snap);

      // Untouched on disk, and absent from the captured tree.
      expect(await readFile(path.join(repo, '.env'), 'utf8')).toContain('sk-should-never-be-captured');
      const tree = await execa('git', ['ls-tree', '-r', '--name-only', snap.untracked!], { cwd: repo });
      expect(tree.stdout.split('\n')).toContain('tracked-change.txt');
      expect(tree.stdout).not.toContain('.env');
    } finally {
      await cleanup();
    }
  });

  it('snapshot and restore leave the tree byte-identical', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await isDirty(repo)).toBe(false);
      const snap = await snapshot(repo);
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const before = await readFile(sch, 'utf8');
      await writeFile(sch, before.replace('KEY_DAH', 'KEY_RUINED'), 'utf8');
      await writeFile(path.join(repo, 'junk.txt'), 'junk', 'utf8');
      expect(await isDirty(repo)).toBe(true);
      await restore(repo, snap);
      expect(await isDirty(repo)).toBe(false);
      expect(await readFile(sch, 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('preserves a staged in-flight audit trail during rollback', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const snap = await snapshot(repo);
      const runFile = path.join(repo, '.copperhead', 'runs', 'in-flight', 'transcript.jsonl');
      await mkdir(path.dirname(runFile), { recursive: true });
      await writeFile(runFile, '{"type":"run-start"}\n', 'utf8');
      await execa('git', ['add', '-f', '.copperhead/runs/in-flight/transcript.jsonl'], { cwd: repo });

      await restore(repo, snap);

      expect(await readFile(runFile, 'utf8')).toBe('{"type":"run-start"}\n');
    } finally {
      await cleanup();
    }
  });

  it('preserves the audit trail even when rollback fails', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const snap = await snapshot(repo);
      const runFile = path.join(repo, '.copperhead', 'runs', 'in-flight', 'transcript.jsonl');
      await mkdir(path.dirname(runFile), { recursive: true });
      await writeFile(runFile, '{"type":"run-start"}\n', 'utf8');
      await execa('git', ['add', '-f', '.copperhead/runs/in-flight/transcript.jsonl'], { cwd: repo });

      await expect(restore(repo, { ...snap, stash: 'not-a-stash' })).rejects.toThrow();

      expect(await readFile(runFile, 'utf8')).toBe('{"type":"run-start"}\n');
    } finally {
      await cleanup();
    }
  });

  it('still rolls back when temporary audit backup storage is unavailable', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const originalTmpDir = process.env.TMPDIR;
    try {
      const snap = await snapshot(repo);
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const before = await readFile(sch, 'utf8');
      await writeFile(sch, before.replace('KEY_DAH', 'KEY_RUINED'), 'utf8');
      process.env.TMPDIR = path.join(repo, 'missing-temp-directory');

      await expect(restore(repo, snap)).resolves.toBeUndefined();

      expect(await readFile(sch, 'utf8')).toBe(before);
    } finally {
      process.env.TMPDIR = originalTmpDir;
      await cleanup();
    }
  });
});
