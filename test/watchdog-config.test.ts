import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig } from '../src/config.js';

/** Load a config from a throwaway repo whose `.copperhead/config.json` is `raw`. */
async function configWith(raw: Record<string, unknown>) {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-config-'));
  try {
    await mkdir(path.join(repo, '.copperhead'), { recursive: true });
    await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify(raw), 'utf8');
    return await loadConfig(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

describe('turn watchdog config', () => {
  it('defaults to a 10-minute inactivity deadline and a 60-minute cap', async () => {
    const config = await configWith({});
    expect(config.turnTimeoutMs).toBe(DEFAULTS.turnTimeoutMs);
    expect(config.turnMaxMs).toBe(DEFAULTS.turnMaxMs);
    expect(DEFAULTS.turnTimeoutMs).toBe(600000);
    expect(DEFAULTS.turnMaxMs).toBe(3600000);
  });

  it('turns the default cap off when the watchdog is switched off', async () => {
    // Before the cap existed, turnTimeoutMs <= 0 meant no deadline at all.
    expect((await configWith({ turnTimeoutMs: 0 })).turnMaxMs).toBe(0);
    expect((await configWith({ turnTimeoutMs: -1 })).turnMaxMs).toBe(0);
  });

  it('keeps an explicit cap even with the watchdog switched off', async () => {
    expect((await configWith({ turnTimeoutMs: 0, turnMaxMs: 5000 })).turnMaxMs).toBe(5000);
  });

  it('keeps the default cap when only the inactivity deadline is raised', async () => {
    expect((await configWith({ turnTimeoutMs: 5400000 })).turnMaxMs).toBe(DEFAULTS.turnMaxMs);
  });
});
