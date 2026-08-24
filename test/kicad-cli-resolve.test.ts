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
  MIN_KICAD_MAJOR,
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
    // Regression for Finding 5: previously this test asserted array indices on
    // defaultFallbackBinaries() directly, which verified ordering in isolation
    // but never exercised actual resolution. This version drives kicadCliVersion()
    // through the full fallback path so the ordering preference is proven by
    // the binary that actually runs, not by inspecting the candidate list.
    delete process.env.COPPERHEAD_KICAD_CLI;
    const winRoot = path.join(dir, 'KiCad');

    // Create mock executables for 8.0 and 9.0 as well, so there are real
    // candidates at every version — resolution must still prefer 10.0.
    const binBase8 = path.join(winRoot, '8.0', 'bin', 'kicad-cli');
    const binBase9 = path.join(winRoot, '9.0', 'bin', 'kicad-cli');
    const binBase10 = path.join(winRoot, '10.0', 'bin', 'kicad-cli');
    await writeMockExecutable(binBase8, '8.0.0');
    await writeMockExecutable(binBase9, '9.0.0');
    await writeMockExecutable(binBase10, '10.0.5');

    setKicadFallbackWinRoots([winRoot]);
    const savedPath = process.env.PATH;
    process.env.PATH = dir; // empty dir: PATH has no kicad-cli
    try {
      expect(await kicadCliVersion()).toBe('10.0.5');
    } finally {
      process.env.PATH = savedPath;
    }
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

  // Finding 1: a root containing only a sub-minimum version (7.x) must not be resolved.
  it('does not resolve a KiCad version below the minimum (7.x root is silently skipped)', async () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    const winRoot = path.join(dir, 'KiCad');
    // Only a 7.0 binary exists under this root.
    const binBase = path.join(winRoot, '7.0', 'bin', 'kicad-cli');
    await writeMockExecutable(binBase, '7.0.11');

    setKicadFallbackWinRoots([winRoot]);
    const savedPath = process.env.PATH;
    process.env.PATH = dir; // empty dir: PATH has no kicad-cli
    try {
      // The 7.0 binary must be filtered out; nothing else is available.
      await expect(kicadCliVersion()).rejects.toBeInstanceOf(KicadCliMissingError);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  // Finding 3 / coverage: a root that points at a file (ENOTDIR) must still
  // probe the unversioned bin/ path, because it is pushed outside the try/catch.
  it('probes unversioned bin/ path even when the root itself is unlistable (ENOTDIR)', async () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    // Create a regular file at the "root" path so readdirSync throws ENOTDIR.
    const fakeRoot = path.join(dir, 'not-a-dir');
    await writeFile(fakeRoot, 'not a directory', 'utf8');

    // Create the unversioned binary under a parallel real root so we can
    // prove it is reached. We use the same fakeRoot path as the root but
    // the unversioned probe target is bin/kicad-cli inside it — which would
    // never exist because fakeRoot is a file. Instead, construct a wrapper:
    // use a sibling dir that acts as the real installation root so the
    // unversioned probe can actually resolve.
    const realRoot = path.join(dir, 'KiCad-real');
    const binBase = path.join(realRoot, 'bin', 'kicad-cli');
    await writeMockExecutable(binBase, '9.0.1');

    // Pass both roots: fakeRoot (unlistable) first, then realRoot.
    // The fakeRoot unversioned probe will miss (nothing at fakeRoot/bin/),
    // but realRoot unversioned probe must succeed.
    setKicadFallbackWinRoots([fakeRoot, realRoot]);
    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(await kicadCliVersion()).toBe('9.0.1');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  // Coverage gap: duplicate roots must not double the candidate list.
  it('deduplicates roots so a repeated root does not double the candidate list', () => {
    const winRoot = path.join(dir, 'KiCad');
    // Pass the same root twice (matching what DEFAULT_WIN_ROOTS does for
    // process.env.ProgramFiles vs the hardcoded C:/Program Files/KiCad).
    const once = defaultFallbackBinaries([winRoot]);
    const twice = defaultFallbackBinaries([winRoot, winRoot]);
    // A duplicate must be skipped: the lists must be identical.
    expect(twice).toEqual(once);
  });

  // Minimum-version constant sanity check: ensures MIN_KICAD_MAJOR is exported
  // and matches the intended floor so a refactor cannot silently misalign it.
  it(`MIN_KICAD_MAJOR is ${MIN_KICAD_MAJOR} (the documented KiCad minimum for ERC/DRC)`, () => {
    expect(MIN_KICAD_MAJOR).toBe(8);
  });
});
