import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockExeca = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: mockExeca }));

import { openspecInit } from '../src/openspec/cli.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'copperhead-openspec-test-'));
  mockExeca.mockReset();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('OpenSpec initialization', () => {
  it('initializes noninteractively without configuring any AI tools', async () => {
    mockExeca.mockResolvedValue({ stdout: 'OpenSpec Setup Complete', stderr: '' });

    expect(await openspecInit(repo)).toEqual({ ok: true, output: 'OpenSpec Setup Complete' });
    expect(mockExeca).toHaveBeenCalledWith('openspec', ['init', '--tools', 'none'], { cwd: repo });
  });

  it('preserves subprocess diagnostics when initialization fails', async () => {
    mockExeca.mockRejectedValue({ exitCode: 1, stdout: 'Creating OpenSpec structure...', stderr: 'permission denied' });

    expect(await openspecInit(repo)).toEqual({
      ok: false,
      output: 'Creating OpenSpec structure...\npermission denied',
    });
  });

  it('keeps an existing workspace without running initialization again', async () => {
    await mkdir(path.join(repo, 'openspec'));

    expect((await openspecInit(repo)).ok).toBe(true);
    expect(mockExeca).not.toHaveBeenCalled();
  });
});
