import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveKicadCli,
  resetKicadCliCache,
  setKicadFallbackBinaries,
  setKicadFallbackWinRoots,
  defaultFallbackBinaries,
  kicadCliVersion,
  KicadCliBadOverrideError,
  KicadCliMissingError,
} from '../src/kicad/cli.js';

/**
 * Binary resolution is pure local logic (an env var plus filesystem probes),
 * so it is testable without KiCad installed. `check` depends on it, and check
 * is contractually LLM-free and network-free: nothing here reaches out.
 */
async function writeMockExecutable(binPath: string, output = '9.0.1'): Promise<string> {
  await mkdir(path.dirname(binPath), { recursive: true });
  if (process.platform === 'win32') {
    const isBat = binPath.endsWith('.bat') || binPath.endsWith('.cmd');
    const target = isBat ? binPath : `${binPath}.cmd`;
    await writeFile(target, `@echo ${output}\r\n`, 'utf8');
    return target;
  } else {
    await writeFile(binPath, `#!/bin/sh\necho "${output}"\n`, 'utf8');
    await chmod(binPath, 0o755);
    return binPath;
  }
}

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
    setKicadFallbackWinRoots();
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
    // finds no macOS app bundle or Windows install, and the run is refused
    // with install instructions rather than a raw spawn error.
    delete process.env.COPPERHEAD_KICAD_CLI;
    // The probe list is emptied rather than left to the host: with the real
    // list, this assertion would fail on any machine that has KiCad installed.
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
    const bundleBase = path.join(dir, 'KiCad.app', 'Contents', 'MacOS', 'kicad-cli');
    const bundle = await writeMockExecutable(bundleBase, '9.0.1');
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
    const pathBinaryBase = path.join(onPath, 'kicad-cli');
    await writeMockExecutable(pathBinaryBase, '8.0.4');

    const overrideBase = path.join(dir, 'custom-kicad'); // deliberately not "kicad-cli"
    const override = await writeMockExecutable(overrideBase, '9.9.9');

    setKicadFallbackBinaries([]);
    const savedPath = process.env.PATH;
    process.env.PATH = onPath;
    try {
      process.env.COPPERHEAD_KICAD_CLI = override;
      expect(resolveKicadCli()).toBe(override);
      await rm(override, { force: true });

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

  it('discovers kicad-cli from standard Windows versioned installation paths', async () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    const winRoot = path.join(dir, 'KiCad');
    const binBase = path.join(winRoot, '10.0', 'bin', 'kicad-cli');
    const bin = await writeMockExecutable(binBase, '10.0.5');

    setKicadFallbackWinRoots([winRoot]);
    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(await kicadCliVersion()).toBe('10.0.5');
      expect(resolveKicadCli()).toBe(bin);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('prefers the newest version when multiple Windows versions are installed', async () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    const winRoot = path.join(dir, 'KiCad');
    const bin8 = path.join(winRoot, '8.0', 'bin', 'kicad-cli.exe');
    const bin9 = path.join(winRoot, '9.0', 'bin', 'kicad-cli.exe');
    const bin10 = path.join(winRoot, '10.0', 'bin', 'kicad-cli.exe');

    for (const b of [bin8, bin9, bin10]) {
      await mkdir(path.dirname(b), { recursive: true });
      await writeFile(b, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(b, 0o755);
    }

    setKicadFallbackWinRoots([winRoot]);
    const candidates = defaultFallbackBinaries([winRoot]);
    const winCandidates = candidates.filter((c) => c.startsWith(winRoot));

    expect(winCandidates[0]).toBe(bin10);
    expect(winCandidates[4]).toBe(bin9);
    expect(winCandidates[8]).toBe(bin8);
  });

  it('falls back to unversioned Windows installation path (bin/kicad-cli.exe)', async () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    const winRoot = path.join(dir, 'KiCad');
    const binBase = path.join(winRoot, 'bin', 'kicad-cli');
    const bin = await writeMockExecutable(binBase, '8.0.0');

    setKicadFallbackWinRoots([winRoot]);
    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(await kicadCliVersion()).toBe('8.0.0');
      expect(resolveKicadCli()).toBe(bin);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('formats platform-specific hints in KicadCliMissingError', () => {
    const winErr = new KicadCliMissingError('win32');
    expect(winErr.remedy.some((h) => h.includes('kicad-cli.exe') && h.includes('Program Files'))).toBe(true);

    const macErr = new KicadCliMissingError('darwin');
    expect(macErr.remedy.some((h) => h.includes('KiCad.app'))).toBe(true);

    const linuxErr = new KicadCliMissingError('linux');
    expect(linuxErr.remedy.some((h) => h.includes('/usr/bin/kicad-cli'))).toBe(true);
  });

  it('formats platform-specific hints in KicadCliBadOverrideError', () => {
    const badPath = 'C:\\bad\\path\\kicad-cli.exe';
    const winErr = new KicadCliBadOverrideError(badPath, 'win32');
    expect(winErr.message).toContain(badPath);
    expect(winErr.remedy.some((h) => h.includes('Test-Path'))).toBe(true);
    expect(winErr.remedy.some((h) => h.includes('Program Files'))).toBe(true);
    expect(winErr.remedy.some((h) => h.includes('& $env:COPPERHEAD_KICAD_CLI version'))).toBe(true);

    const macErr = new KicadCliBadOverrideError('/bad/path', 'darwin');
    expect(macErr.remedy.some((h) => h.includes('ls -l'))).toBe(true);
    expect(macErr.remedy.some((h) => h.includes('KiCad.app'))).toBe(true);
    expect(macErr.remedy.some((h) => h.includes('"$COPPERHEAD_KICAD_CLI" version'))).toBe(true);

    const linuxErr = new KicadCliBadOverrideError('/bad/path', 'linux');
    expect(linuxErr.remedy.some((h) => h.includes('ls -l'))).toBe(true);
    expect(linuxErr.remedy.some((h) => h.includes('/usr/bin'))).toBe(true);
    expect(linuxErr.remedy.some((h) => h.includes('"$COPPERHEAD_KICAD_CLI" version'))).toBe(true);
  });
});
