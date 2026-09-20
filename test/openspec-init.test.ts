import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { openspecInit } from '../src/openspec/cli.js';

const mockedExeca = vi.mocked(execa);

describe('openspecInit', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  it('no-ops when openspec/ already exists', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-opsx-'));
    try {
      await mkdir(path.join(repo, 'openspec'));
      const res = await openspecInit(repo);
      expect(res.ok).toBe(true);
      expect(mockedExeca).not.toHaveBeenCalled();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('inits with --no-interactive when the CLI accepts it', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-opsx-'));
    try {
      mockedExeca.mockResolvedValue({ stdout: 'initialized', stderr: '' } as never);
      const res = await openspecInit(repo);
      expect(res.ok).toBe(true);
      expect(mockedExeca).toHaveBeenCalledTimes(1);
      expect(mockedExeca).toHaveBeenCalledWith('openspec', ['init', '--no-interactive'], { cwd: repo });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('falls back to `--tools none` when --no-interactive is rejected', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-opsx-'));
    try {
      // openspec ≥1.13 rejects --no-interactive; init must still be
      // non-interactive, so the fallback matters rather than a bare retry.
      mockedExeca
        .mockRejectedValueOnce(
          Object.assign(new Error('Command failed'), {
            stdout: '',
            stderr: "error: unknown option '--no-interactive'",
            exitCode: 1,
          }) as never,
        )
        .mockResolvedValueOnce({ stdout: 'OpenSpec Setup Complete', stderr: '' } as never);
      const res = await openspecInit(repo);
      expect(res.ok).toBe(true);
      expect(mockedExeca).toHaveBeenNthCalledWith(2, 'openspec', ['init', '--tools', 'none'], {
        cwd: repo,
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports failure when neither invocation works', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-opsx-'));
    try {
      mockedExeca.mockRejectedValue(
        Object.assign(new Error('Command failed'), {
          stdout: '',
          stderr: 'error: something else',
          exitCode: 1,
        }) as never,
      );
      const res = await openspecInit(repo);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('something else');
      expect(mockedExeca).toHaveBeenCalledTimes(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
