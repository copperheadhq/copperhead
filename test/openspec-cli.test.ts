import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockExeca = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: mockExeca }));

import { openspecInit } from '../src/openspec/cli.js';

describe('OpenSpec initialization', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'copperhead-openspec-'));
    mockExeca.mockReset();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('uses the supported non-interactive tools selection without installing editor integrations', async () => {
    mockExeca.mockResolvedValue({ stdout: 'Initialized OpenSpec', stderr: '' });
    expect(await openspecInit(repo)).toEqual({ ok: true, output: 'Initialized OpenSpec' });
    expect(mockExeca).toHaveBeenCalledWith('openspec', ['init', '--tools', 'none'], { cwd: repo });
  });

  it('does not reinitialize an existing workspace', async () => {
    await mkdir(path.join(repo, 'openspec'));
    expect((await openspecInit(repo)).ok).toBe(true);
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('reports initialization diagnostics to the caller', async () => {
    mockExeca.mockRejectedValue({ exitCode: 1, stderr: 'error: unknown option', message: 'Command failed' });
    expect(await openspecInit(repo)).toEqual({ ok: false, output: 'error: unknown option' });
  });

  it('reports the missing prerequisite without calling a provider', async () => {
    mockExeca.mockRejectedValue({ code: 'ENOENT', message: 'spawn openspec ENOENT' });
    expect(await openspecInit(repo)).toEqual({
      ok: false,
      output: 'openspec CLI not found on PATH (npm i -g @fission-ai/openspec)',
    });
  });
});
