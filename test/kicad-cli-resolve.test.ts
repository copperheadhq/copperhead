import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveKicadCli,
  resetKicadCliCache,
  setKicadFallbackBinaries,
  kicadCliVersion,
  KicadCliBadOverrideError,
  KicadCliMissingError,
} from '../src/kicad/cli.js';

/**
 * Binary resolution is pure local logic (an env var plus filesystem probes),
 * so it is testable without KiCad installed. `check` depends on it, and check
 * is contractually LLM-free and network-free: nothing here reaches out.
 */
describe('kicad-cli binary resolution', () => {
  const saved = process.env.COPPERHEAD_KICAD_CLI;
  let dir: string;

  beforeEach(async () => {
    resetKicadCliCache();
    dir = await mkdtemp(path.join(tmpdir(), 'copperhead-kicad-'));
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.COPPERHEAD_KICAD_CLI;
    else process.env.COPPERHEAD_KICAD_CLI = saved;
    resetKicadCliCache();
    setKicadFallbackBinaries();
    await rm(dir, { recursive: true, force: true });
  });

  it('falls back to the PATH name when no override is set', () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    expect(resolveKicadCli()).toBe('kicad-cli');
  });

  it('honours COPPERHEAD_KICAD_CLI when the path exists', async () => {
    const bin = path.join(dir, 'kicad-cli');
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(bin, 0o755);
    process.env.COPPERHEAD_KICAD_CLI = bin;
    expect(resolveKicadCli()).toBe(bin);
  });

  it('trims surrounding whitespace in the override', async () => {
    const bin = path.join(dir, 'kicad-cli');
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8');
    process.env.COPPERHEAD_KICAD_CLI = `  ${bin}  `;
    expect(resolveKicadCli()).toBe(bin);
  });

  it('refuses, naming the bad path, when the override does not exist', () => {
    // Regression: this used to fall through to a bare PATH lookup, so a typo
    // produced "kicad-cli not found on PATH" plus advice to set the very
    // variable the user had already set.
    const missing = path.join(dir, 'typo', 'kicad-cli');
    process.env.COPPERHEAD_KICAD_CLI = missing;
    expect(() => resolveKicadCli()).toThrow(KicadCliBadOverrideError);
    try {
      resolveKicadCli();
    } catch (err) {
      const e = err as KicadCliBadOverrideError;
      expect(e.message).toContain(missing);
      // It must not tell you to set what you already set.
      expect(e.message).not.toMatch(/not found on PATH/);
    }
  });

  it('treats an empty or whitespace-only override as unset', () => {
    process.env.COPPERHEAD_KICAD_CLI = '   ';
    expect(resolveKicadCli()).toBe('kicad-cli');
  });

  it('reports the binary as missing when PATH has no kicad-cli and no bundle matches', async () => {
    // Drives the real ENOENT chain: PATH lookup fails, fallbackAfterMissing
    // finds no macOS app bundle, and the run is refused with the install
    // instructions rather than a raw spawn error.
    delete process.env.COPPERHEAD_KICAD_CLI;
    // The probe list is emptied rather than left to the host: with the real
    // list, this assertion would fail on any macOS machine that has KiCad in
    // /Applications, because the fallback would resolve and the run succeed.
    setKicadFallbackBinaries([]);
    const savedPath = process.env.PATH;
    process.env.PATH = dir; // an empty directory: nothing resolvable on it
    try {
      await expect(kicadCliVersion()).rejects.toBeInstanceOf(KicadCliMissingError);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('falls back to an app-bundle path when PATH has no kicad-cli', async () => {
    // The macOS install case, made testable on every platform by pointing the
    // probe at a fixture. Covers the retry: the first spawn ENOENTs on the
    // bare PATH name, the second runs the resolved bundle binary.
    delete process.env.COPPERHEAD_KICAD_CLI;
    const bundle = path.join(dir, 'KiCad.app', 'Contents', 'MacOS', 'kicad-cli');
    await mkdir(path.dirname(bundle), { recursive: true });
    await writeFile(bundle, '#!/bin/sh\necho "9.0.1"\n', 'utf8');
    if (process.platform === 'win32') {
      await writeFile(bundle + '.cmd', '@echo 9.0.1\n', 'utf8');
    }
    await chmod(bundle, 0o755);
    setKicadFallbackBinaries([path.join(dir, 'absent', 'kicad-cli'), bundle]);
    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(await kicadCliVersion()).toBe('9.0.1');
      // ...and the bundle path is cached, so the miss is not re-paid per call.
      expect(resolveKicadCli()).toBe(bundle);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('refuses when an override that existed at resolve time disappears mid-session', async () => {
    // The refusal only means something if a fallback was available to take:
    // a working `kicad-cli` sits on PATH under a different name from the
    // override, and the bundle probes are emptied, so PATH is the one route
    // that could still succeed. Reaching KicadCliMissingError therefore proves
    // the fallback was never attempted, rather than attempted and also empty.
    const onPath = path.join(dir, 'path-bin');
    await mkdir(onPath, { recursive: true });
    const pathBinary = path.join(onPath, 'kicad-cli');
    await writeFile(pathBinary, '#!/bin/sh\necho "8.0.4"\n', 'utf8');
    if (process.platform === 'win32') {
      await writeFile(pathBinary + '.cmd', '@echo 8.0.4\n', 'utf8');
    }
    await chmod(pathBinary, 0o755);

    const override = path.join(dir, 'custom-kicad'); // deliberately not "kicad-cli"
    await writeFile(override, '#!/bin/sh\necho "9.9.9"\n', 'utf8');
    if (process.platform === 'win32') {
      await writeFile(override + '.cmd', '@echo 9.9.9\n', 'utf8');
    }
    await chmod(override, 0o755);

    setKicadFallbackBinaries([]);
    const savedPath = process.env.PATH;
    process.env.PATH = onPath;
    try {
      process.env.COPPERHEAD_KICAD_CLI = override;
      expect(resolveKicadCli()).toBe(override);
      expect(await kicadCliVersion()).toBe('9.9.9'); // Confirm it executes the override successfully
      await rm(override, { force: true });
      if (process.platform === 'win32') {
        await rm(override + '.cmd', { force: true });
      }

      // An explicit override that vanished must not silently fall back, even
      // though the PATH binary right there would have answered.
      await expect(kicadCliVersion()).rejects.toBeInstanceOf(KicadCliMissingError);

      // Control: that PATH binary really is usable, so the refusal above was a
      // refusal and not a second missing binary.
      delete process.env.COPPERHEAD_KICAD_CLI;
      resetKicadCliCache();
      expect(await kicadCliVersion()).toBe('8.0.4');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('caches the resolved binary until the cache is reset', async () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    expect(resolveKicadCli()).toBe('kicad-cli');
    // A later override is ignored while the cache stands, then honoured after
    // a reset — which is what makes these tests independent of each other.
    const bin = path.join(dir, 'kicad-cli');
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8');
    process.env.COPPERHEAD_KICAD_CLI = bin;
    expect(resolveKicadCli()).toBe('kicad-cli');
    resetKicadCliCache();
    expect(resolveKicadCli()).toBe(bin);
  });
});
