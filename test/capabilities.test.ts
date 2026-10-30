import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { Command } from 'commander';
import {
  COPPERHEAD_RUN_PROTOCOL,
  SUPPORTED_PROTOCOL_MAJOR,
  IMPLEMENTED_PROTOCOL_FEATURES,
  DEFAULT_PROBE_TIMEOUT_MS,
  collectCapabilities,
  defaultDeps,
  isProtocolCompatible,
  assertProtocolCompatible,
  formatCapabilities,
  parseKicadVersion,
  parseGitVersion,
  parseOpenspecVersion,
  extractPublicCommands,
  type CapabilityReport,
  type CapabilityDeps,
} from '../src/commands/capabilities.js';
import { runDoctor } from '../src/commands/doctor.js';
import {
  resetKicadCliCache,
  execBoundedProcess,
  killProcessTree,
  resolveTaskkillBinary,
  type ProcessTreeKillOps,
  kicadCliVersion,
} from '../src/kicad/cli.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_CLI = path.join(ROOT, 'dist', 'cli.js');
const SRC_CLI = path.join(ROOT, 'src', 'cli.ts');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * Standard hermetic unit-test dependencies that provide deterministic
 * stubbed responses for all external probes without spawning host binaries.
 */
function mockUnitDeps(over: Partial<CapabilityDeps> = {}): CapabilityDeps {
  return {
    nodeVersion: 'v20.19.0',
    cliVersion: '0.12.0',
    kicadVersion: async () => '10.0.4',
    gitVersion: async () => '2.43.0',
    openspecVersion: async () => '1.14.1',
    ...over,
  };
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Write a fake external executable for PATH-based probe tests.
 * `body` is a cmd batch body on Windows and a sh body elsewhere.
 */
async function writeFakeExecutable(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, IS_WINDOWS ? `${name}.cmd` : name);
  await writeFile(file, IS_WINDOWS ? body : `#!/bin/sh\n${body}\n`, 'utf8');
  if (!IS_WINDOWS) await chmod(file, 0o755);
  return file;
}

async function withPrependedPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved ?? ''}`;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('protocol constant and version semantics', () => {
  it('defines the protocol identifier as copperhead-run/1', () => {
    expect(COPPERHEAD_RUN_PROTOCOL).toBe('copperhead-run/1');
    expect(SUPPORTED_PROTOCOL_MAJOR).toBe(1);
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(5000);
  });

  it('advertises an empty feature array in Phase 0 (truthfulness invariant)', () => {
    expect(IMPLEMENTED_PROTOCOL_FEATURES).toEqual([]);
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('event-stream');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('result-document');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('run-id');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('sigterm');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('stream-compat');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('findings');
    expect(IMPLEMENTED_PROTOCOL_FEATURES).not.toContain('control');
  });

  it('accepts matching protocol major 1 with valid formats', () => {
    expect(isProtocolCompatible('copperhead-run/1')).toBe(true);
    expect(isProtocolCompatible('copperhead-run/1.0')).toBe(true);
    expect(isProtocolCompatible('copperhead-run/1.4')).toBe(true);
  });

  it('strictly rejects malformed protocol strings, leading zeros, and invalid suffixes', () => {
    expect(isProtocolCompatible('copperhead-run/01')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/1.01')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/1.00')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/1.anything')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/2')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/0')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/3.0')).toBe(false);
    expect(isProtocolCompatible('other-protocol/1')).toBe(false);
    expect(isProtocolCompatible('')).toBe(false);
    expect(isProtocolCompatible('copperhead-run')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/1.2.3')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/1 ')).toBe(false);
    expect(isProtocolCompatible(' copperhead-run/1')).toBe(false);
  });

  it('assertProtocolCompatible accepts valid report and rejects unknown major or invalid input', async () => {
    const validReport: CapabilityReport = {
      protocol: 'copperhead-run/1',
      cli: '0.12.0',
      commands: ['check', 'do'],
      features: [],
      tools: {
        kicadCli: '10.0.4',
        git: '2.43.0',
        openspec: '1.14.1',
        node: process.version,
      },
    };

    expect(() => assertProtocolCompatible(validReport, 1)).not.toThrow();

    // Compile-time and runtime assignability probe for producer-consumer handshake
    const collected: CapabilityReport = await collectCapabilities({
      commands: ['check'],
      deps: {
        nodeVersion: 'v20.19.0',
        cliVersion: '0.12.0',
        kicadVersion: async () => '10.0.4',
        gitVersion: async () => '2.43.0',
        openspecVersion: async () => '1.14.1',
      },
    });
    expect(() => assertProtocolCompatible(collected, 1)).not.toThrow();
    expect(() => assertProtocolCompatible(collected)).not.toThrow();

    expect(() =>
      assertProtocolCompatible({ ...validReport, protocol: 'copperhead-run/2' }, 1),
    ).toThrow(/unsupported protocol version/i);

    expect(() =>
      assertProtocolCompatible({ ...validReport, protocol: 'copperhead-run/99' }, 1),
    ).toThrow(/unsupported protocol version/i);

    expect(() =>
      assertProtocolCompatible({ ...validReport, protocol: 'unknown-protocol/1' }, 1),
    ).toThrow(/unsupported protocol version/i);

    // Structural negative assertions against null, non-objects, and missing protocol field
    expect(() => assertProtocolCompatible(null, 1)).toThrow(/unsupported protocol version/i);
    expect(() => assertProtocolCompatible(undefined, 1)).toThrow(/unsupported protocol version/i);
    expect(() => assertProtocolCompatible({}, 1)).toThrow(/unsupported protocol version/i);
    expect(() => assertProtocolCompatible('not-a-report', 1)).toThrow(
      /unsupported protocol version/i,
    );
    expect(() => assertProtocolCompatible({ protocol: 123 }, 1)).toThrow(
      /unsupported protocol version/i,
    );
  });

  it('consumer compatibility ignores unknown added JSON fields (extensibility)', () => {
    const extendedReport = {
      protocol: 'copperhead-run/1',
      cli: '0.12.0',
      commands: ['check', 'do'],
      features: [],
      tools: {
        kicadCli: null,
        git: null,
        openspec: null,
        node: process.version,
      },
      futureField: 'additive-payload',
      experimentalTelemetry: { active: false },
    };

    expect(() => assertProtocolCompatible(extendedReport, 1)).not.toThrow();
  });
});

describe('tool output version parsers', () => {
  describe('parseKicadVersion', () => {
    it('parses valid KiCad CLI version strings', () => {
      expect(parseKicadVersion('10.0.4')).toBe('10.0.4');
      expect(parseKicadVersion('kicad-cli 9.0.1')).toBe('9.0.1');
      expect(parseKicadVersion('kicad-cli v8.0.4')).toBe('8.0.4');
      expect(parseKicadVersion('10.0.5-rc1')).toBe('10.0.5-rc1');
      expect(parseKicadVersion('8.0.4+extra')).toBe('8.0.4+extra');
      expect(parseKicadVersion('10.0.5-rc1+extra')).toBe('10.0.5-rc1+extra');
    });

    it('rejects leading zeros, trailing punctuation, extra components, and ANSI decoration', () => {
      expect(parseKicadVersion('01.2.3')).toBeNull();
      expect(parseKicadVersion('1.02.3')).toBeNull();
      expect(parseKicadVersion('10.0.4.')).toBeNull();
      expect(parseKicadVersion('10.0.4.1')).toBeNull();
      expect(parseKicadVersion('10.0.4 (build)')).toBeNull();
      expect(parseKicadVersion('\u001b[32m10.0.4\u001b[0m')).toBeNull();
    });

    it('extracts version when preceded by diagnostic or warning lines', () => {
      expect(parseKicadVersion('OpenGL 3.2 unsupported\n10.0.4')).toBe('10.0.4');
      expect(parseKicadVersion('Gtk-Message: Failed to load module\nkicad-cli 9.0.1\n')).toBe(
        '9.0.1',
      );
    });

    it('returns null on empty, whitespace, or non-string input', () => {
      expect(parseKicadVersion('')).toBeNull();
      expect(parseKicadVersion('   \n  ')).toBeNull();
      expect(parseKicadVersion(null)).toBeNull();
      expect(parseKicadVersion(undefined)).toBeNull();
    });

    it('returns null and never leaks host filepaths from warning-only or malformed output', () => {
      const leakedPath =
        'WARNING: could not read C:\\Users\\victim\\AppData\\Roaming\\kicad\\secret-config.json';
      expect(parseKicadVersion(leakedPath)).toBeNull();
      expect(parseKicadVersion('C:\\Program Files\\KiCad\\bin\\kicad-cli.exe')).toBeNull();
      expect(parseKicadVersion('/usr/bin/kicad-cli')).toBeNull();
      expect(parseKicadVersion('kicad-cli: command not found')).toBeNull();
      expect(parseKicadVersion('Segmentation fault (core dumped)')).toBeNull();
    });
  });

  describe('parseGitVersion', () => {
    it('parses valid Git version strings including platform builds', () => {
      expect(parseGitVersion('git version 2.43.0')).toBe('2.43.0');
      expect(parseGitVersion('git version 2.52.0.windows.1')).toBe('2.52.0.windows.1');
      expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toBe('2.39.3');
      expect(parseGitVersion('git version 2.40.0.vfs.0.4')).toBe('2.40.0.vfs.0.4');
      expect(parseGitVersion('git version 2.43.0-rc1')).toBe('2.43.0-rc1');
    });

    it('rejects leading zeros and trailing garbage instead of returning a partial version', () => {
      expect(parseGitVersion('git version 02.43.0')).toBeNull();
      expect(parseGitVersion('git version 2.43.0.')).toBeNull();
      expect(parseGitVersion('git version 2.43.0 C:\\Users\\victim\\secret')).toBeNull();
      expect(parseGitVersion('git version 2.43.0 (Apple Git-146) trailing')).toBeNull();
    });

    it('returns null on empty, warning-only, or host-path output', () => {
      expect(parseGitVersion('')).toBeNull();
      expect(parseGitVersion('   ')).toBeNull();
      expect(parseGitVersion(null)).toBeNull();
      expect(parseGitVersion('warning: LF will be replaced by CRLF in file')).toBeNull();
      expect(parseGitVersion('fatal: not a git repository')).toBeNull();
      expect(parseGitVersion('git version /usr/local/bin/git')).toBeNull();
      expect(parseGitVersion('C:\\Program Files\\Git\\bin\\git.exe')).toBeNull();
    });
  });

  describe('parseOpenspecVersion', () => {
    it('parses valid OpenSpec version strings', () => {
      expect(parseOpenspecVersion('1.14.1')).toBe('1.14.1');
      expect(parseOpenspecVersion('openspec 1.8.0')).toBe('1.8.0');
      expect(parseOpenspecVersion('v1.14.1')).toBe('1.14.1');
      expect(parseOpenspecVersion('openspec v1.10.0-beta.2')).toBe('1.10.0-beta.2');
    });

    it('rejects leading zeros, trailing punctuation, and decorated output', () => {
      expect(parseOpenspecVersion('01.2.3')).toBeNull();
      expect(parseOpenspecVersion('1.14.1.')).toBeNull();
      expect(parseOpenspecVersion('1.14.1 (build)')).toBeNull();
      expect(parseOpenspecVersion('\u001b[32m1.14.1\u001b[0m')).toBeNull();
    });

    it('returns null on empty, warning-only, or host-path output', () => {
      expect(parseOpenspecVersion('')).toBeNull();
      expect(parseOpenspecVersion('   ')).toBeNull();
      expect(parseOpenspecVersion(null)).toBeNull();
      expect(parseOpenspecVersion('warning: update available from 1.10.0 to 1.14.1')).toBeNull();
      expect(parseOpenspecVersion('node: internal/modules/cjs/loader: not found')).toBeNull();
      expect(parseOpenspecVersion('C:\\Users\\dev\\AppData\\Roaming\\npm\\openspec')).toBeNull();
    });
  });
});

describe('hermetic collectCapabilities with injected dependencies', () => {
  it('returns well-formed schema when all tools report versions', async () => {
    const deps = mockUnitDeps({
      nodeVersion: 'v20.19.0',
      cliVersion: '0.12.0',
      kicadVersion: async () => '10.0.4',
      gitVersion: async () => '2.43.0',
      openspecVersion: async () => '1.14.1',
    });

    const report = await collectCapabilities({ deps, commands: ['check', 'do'] });

    expect(report).toEqual({
      protocol: 'copperhead-run/1',
      cli: '0.12.0',
      commands: ['check', 'do'],
      features: [],
      tools: {
        kicadCli: '10.0.4',
        git: '2.43.0',
        openspec: '1.14.1',
        node: 'v20.19.0',
      },
    });
  });

  it('reports missing kicadCli as null without failing', async () => {
    const deps = mockUnitDeps({ kicadVersion: async () => null });
    const report = await collectCapabilities({ deps, commands: ['check'] });
    expect(report.tools.kicadCli).toBeNull();
    expect(report.tools.git).toBe('2.43.0');
    expect(report.tools.openspec).toBe('1.14.1');
    expect(report.protocol).toBe('copperhead-run/1');
  });

  it('reports missing git as null without failing', async () => {
    const deps = mockUnitDeps({ gitVersion: async () => null });
    const report = await collectCapabilities({ deps, commands: ['check'] });
    expect(report.tools.git).toBeNull();
    expect(report.tools.kicadCli).toBe('10.0.4');
    expect(report.protocol).toBe('copperhead-run/1');
  });

  it('reports missing openspec as null without failing', async () => {
    const deps = mockUnitDeps({ openspecVersion: async () => null });
    const report = await collectCapabilities({ deps, commands: ['check'] });
    expect(report.tools.openspec).toBeNull();
    expect(report.tools.kicadCli).toBe('10.0.4');
    expect(report.protocol).toBe('copperhead-run/1');
  });

  it('isolates probe exceptions and never leaks host paths or stack traces', async () => {
    const deps = mockUnitDeps({
      kicadVersion: async () => {
        throw new Error('Command failed: /home/user/private/bin/kicad-cli (ENOENT)');
      },
      gitVersion: async () => {
        throw new Error('fatal: not a git repository');
      },
      openspecVersion: async () => {
        throw new Error('spawn openspec ENOENT');
      },
    });

    const report = await collectCapabilities({ deps, commands: ['check'] });
    expect(report.tools.kicadCli).toBeNull();
    expect(report.tools.git).toBeNull();
    expect(report.tools.openspec).toBeNull();
    expect(report.tools.node).toBe('v20.19.0');

    const jsonStr = JSON.stringify(report);
    expect(jsonStr).not.toContain('private');
    expect(jsonStr).not.toContain('ENOENT');
  });

  it('sorts commands deterministically across invocations', async () => {
    const deps = mockUnitDeps();

    const report1 = await collectCapabilities({
      deps,
      commands: ['sync', 'check', 'do', 'init', 'doctor'],
    });

    const report2 = await collectCapabilities({
      deps,
      commands: ['do', 'doctor', 'check', 'sync', 'init'],
    });

    expect(report1.commands).toEqual(['check', 'do', 'doctor', 'init', 'sync']);
    expect(report2.commands).toEqual(['check', 'do', 'doctor', 'init', 'sync']);
    expect(report1.commands).toEqual(report2.commands);
  });

  it('dynamically extracts public command names from a Commander program and filters internal/help', () => {
    const prog = new Command();
    prog.command('check').description('check command');
    prog.command('do').description('do command');
    prog.command('capabilities').description('capabilities command');
    prog.command('_internal').description('hidden command');
    prog.command('help').description('built-in help');

    const commands = extractPublicCommands(prog);
    expect(commands).toEqual(['capabilities', 'check', 'do']);
    expect(commands).not.toContain('_internal');
    expect(commands).not.toContain('help');
  });

  it('excludes aliases and nested subcommands from the top-level inventory', () => {
    const prog = new Command();
    prog.command('check').alias('verify');
    const skill = prog.command('skill');
    skill.command('list');
    prog.command('export').command('bom');

    expect(extractPublicCommands(prog)).toEqual(['check', 'export', 'skill']);
  });

  it('deduplicates and sorts explicit commands', () => {
    expect(extractPublicCommands(undefined, ['sync', 'check', 'sync', 'do'])).toEqual([
      'check',
      'do',
      'sync',
    ]);
  });

  it('returns empty array when neither program nor explicit commands are given', () => {
    expect(extractPublicCommands()).toEqual([]);
  });
});

describe('subprocess adapter and probe deadline enforcement', () => {
  it('prints a version then hangs, degrades to null, and terminates the process tree within the deadline', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-wrapper-hang-'));
    const pidFile = path.join(scratchDir, 'descendant.pid');
    const isWin = IS_WINDOWS;
    const fakeKicad = path.join(scratchDir, isWin ? 'fake-kicad.cmd' : 'fake-kicad.sh');

    if (isWin) {
      const nodeCode = `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('10.0.4'); setTimeout(() => {}, 10000);`;
      await writeFile(fakeKicad, `@node -e "${nodeCode}"\n`, 'utf8');
    } else {
      await writeFile(
        fakeKicad,
        `#!/bin/sh\necho "10.0.4"\nsleep 10 &\necho $! > "${pidFile}"\nwait\n`,
        'utf8',
      );
      await chmod(fakeKicad, 0o755);
    }

    const savedEnv = process.env.COPPERHEAD_KICAD_CLI;
    try {
      process.env.COPPERHEAD_KICAD_CLI = fakeKicad;
      resetKicadCliCache();
      const startTime = Date.now();

      const reportPromise = collectCapabilities({
        timeoutMs: 1500,
        commands: ['check'],
        deps: {
          nodeVersion: 'v20.19.0',
          cliVersion: '0.12.0',
          gitVersion: async () => '2.43.0',
          openspecVersion: async () => '1.14.1',
        },
      });

      // Give the wrapper time to start its descendant, but never beyond the probe deadline.
      for (let i = 0; i < 24 && !existsSync(pidFile); i++) {
        await delay(50);
      }

      const report = await reportPromise;
      const elapsed = Date.now() - startTime;

      // The version was printed before the hang, but a timed-out probe must still be null.
      expect(report.tools.kicadCli).toBeNull();
      expect(report.tools.git).toBe('2.43.0');

      // Handshake must complete well below the 10s child delay.
      expect(elapsed).toBeLessThan(6000);

      // Verify that the descendant process was terminated and not orphaned.
      if (existsSync(pidFile)) {
        const descendantPid = Number((await readFile(pidFile, 'utf8')).trim());
        if (Number.isInteger(descendantPid) && descendantPid > 0) {
          if (isWin) {
            let tasklistOutput = '';
            try {
              tasklistOutput = execFileSync('tasklist', ['/FI', `PID eq ${descendantPid}`], {
                encoding: 'utf8',
                windowsHide: true,
              });
            } catch {}
            expect(tasklistOutput).not.toContain(String(descendantPid));
          } else {
            let alive = true;
            for (let attempt = 0; attempt < 20 && alive; attempt++) {
              try {
                process.kill(descendantPid, 0);
                await delay(50);
              } catch {
                alive = false;
              }
            }
            expect(alive).toBe(false);
          }
        }
      }
    } finally {
      if (savedEnv !== undefined) {
        process.env.COPPERHEAD_KICAD_CLI = savedEnv;
      } else {
        delete process.env.COPPERHEAD_KICAD_CLI;
      }
      resetKicadCliCache();
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('enforces deadline on slow native executable within bounded time', async () => {
    const startTime = Date.now();
    const res = await execBoundedProcess(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000);'],
      300,
    );
    const elapsed = Date.now() - startTime;

    expect(res.failed).toBe(true);
    expect(res.timedOut).toBe(true);
    // Bounded execution: completes well before 10000ms delay
    expect(elapsed).toBeLessThan(3500);
  });

  it('force-kills a probe that ignores SIGTERM instead of waiting for the graceful shutdown delay', async () => {
    const startTime = Date.now();
    const res = await execBoundedProcess(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000);"],
      300,
    );
    const elapsed = Date.now() - startTime;

    expect(res.failed).toBe(true);
    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(3500);
  });

  it('handles responsive native executable cleanly and quickly', async () => {
    const res = await execBoundedProcess(process.execPath, ['-v'], 3000);
    expect(res.failed).toBe(false);
    expect(String(res.stdout).trim()).toMatch(/^v\d+/);
  });

  describe('resolveTaskkillBinary', () => {
    it('resolves taskkill.exe path using SystemRoot when defined', () => {
      expect(resolveTaskkillBinary({ SystemRoot: 'C:\\Windows' })).toBe(
        path.win32.join('C:\\Windows', 'System32', 'taskkill.exe'),
      );
    });

    it('resolves lower-case systemroot when SystemRoot is unset', () => {
      expect(resolveTaskkillBinary({ systemroot: 'D:\\WinSys' })).toBe(
        path.win32.join('D:\\WinSys', 'System32', 'taskkill.exe'),
      );
    });

    it('falls back to windir when SystemRoot and systemroot are unset or empty', () => {
      expect(resolveTaskkillBinary({ windir: 'D:\\WinNT' })).toBe(
        path.win32.join('D:\\WinNT', 'System32', 'taskkill.exe'),
      );
      expect(resolveTaskkillBinary({ SystemRoot: '', windir: 'C:\\Windows' })).toBe(
        path.win32.join('C:\\Windows', 'System32', 'taskkill.exe'),
      );
      expect(resolveTaskkillBinary({ SystemRoot: '   ', windir: 'C:\\Windows' })).toBe(
        path.win32.join('C:\\Windows', 'System32', 'taskkill.exe'),
      );
    });

    it('resolves upper-case WINDIR when other candidates are unset or empty', () => {
      expect(resolveTaskkillBinary({ WINDIR: 'E:\\LegacyWin' })).toBe(
        path.win32.join('E:\\LegacyWin', 'System32', 'taskkill.exe'),
      );
      expect(
        resolveTaskkillBinary({ SystemRoot: '', systemroot: '   ', windir: '', WINDIR: 'E:\\LegacyWin' }),
      ).toBe(path.win32.join('E:\\LegacyWin', 'System32', 'taskkill.exe'));
    });

    it('enforces mixed-case environment variable precedence', () => {
      expect(
        resolveTaskkillBinary({
          SystemRoot: 'C:\\RootPrimary',
          systemroot: 'C:\\RootSecondary',
          windir: 'C:\\WinDirLower',
          WINDIR: 'C:\\WinDirUpper',
        }),
      ).toBe(path.win32.join('C:\\RootPrimary', 'System32', 'taskkill.exe'));

      expect(
        resolveTaskkillBinary({
          systemroot: 'C:\\RootSecondary',
          windir: 'C:\\WinDirLower',
          WINDIR: 'C:\\WinDirUpper',
        }),
      ).toBe(path.win32.join('C:\\RootSecondary', 'System32', 'taskkill.exe'));

      expect(
        resolveTaskkillBinary({
          windir: 'C:\\WinDirLower',
          WINDIR: 'C:\\WinDirUpper',
        }),
      ).toBe(path.win32.join('C:\\WinDirLower', 'System32', 'taskkill.exe'));
    });

    it('falls back to bare taskkill command when all candidates are missing, empty, or whitespace', () => {
      expect(resolveTaskkillBinary({})).toBe('taskkill');
      expect(resolveTaskkillBinary({ SystemRoot: '', windir: '' })).toBe('taskkill');
      expect(resolveTaskkillBinary({ SystemRoot: '  ', windir: '  ' })).toBe('taskkill');
      expect(
        resolveTaskkillBinary({
          SystemRoot: '',
          systemroot: '   ',
          windir: '\t',
          WINDIR: ' ',
        }),
      ).toBe('taskkill');
    });
  });

  describe('killProcessTree execution on Windows', () => {
    it('invokes taskkill with /F /T /PID and the resolved executable for the target process', () => {
      const execSpy = vi.fn();
      killProcessTree(12345, false, {
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows' },
        execFileSync: execSpy,
      });

      expect(execSpy).toHaveBeenCalledTimes(1);
      expect(execSpy).toHaveBeenCalledWith(
        'C:\\Windows\\System32\\taskkill.exe',
        ['/F', '/T', '/PID', '12345'],
        { stdio: 'ignore', windowsHide: true, timeout: 2000 },
      );
    });

    it('passes bare taskkill when environment variables are unset', () => {
      const execSpy = vi.fn();
      killProcessTree(12345, false, {
        platform: 'win32',
        env: {},
        execFileSync: execSpy,
      });

      expect(execSpy).toHaveBeenCalledTimes(1);
      expect(execSpy).toHaveBeenCalledWith(
        'taskkill',
        ['/F', '/T', '/PID', '12345'],
        { stdio: 'ignore', windowsHide: true, timeout: 2000 },
      );
    });

    it('catches and suppresses errors from execFileSync without throwing', () => {
      const execSpy = vi.fn(() => {
        throw new Error('Command failed: taskkill');
      });
      expect(() =>
        killProcessTree(12345, false, {
          platform: 'win32',
          execFileSync: execSpy,
        }),
      ).not.toThrow();
      expect(execSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('safely handles undefined or 0 pid in killProcessTree without issuing process operations', () => {
    const winExecSpy = vi.fn();
    killProcessTree(undefined, false, { platform: 'win32', execFileSync: winExecSpy });
    killProcessTree(0, false, { platform: 'win32', execFileSync: winExecSpy });
    expect(winExecSpy).not.toHaveBeenCalled();

    const posixKillSpy = vi.fn();
    killProcessTree(undefined, true, { platform: 'linux', kill: posixKillSpy });
    killProcessTree(0, true, { platform: 'linux', kill: posixKillSpy });
    killProcessTree(undefined, false, { platform: 'linux', kill: posixKillSpy });
    killProcessTree(0, false, { platform: 'linux', kill: posixKillSpy });
    expect(posixKillSpy).not.toHaveBeenCalled();
  });

  describe('killProcessTree execution on POSIX', () => {
    it('attempts negative-PID SIGKILL for process group and does not invoke fallback on success', () => {
      const killSpy = vi.fn();
      killProcessTree(4242, true, { platform: 'linux', kill: killSpy });

      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    });

    it('falls back to positive-PID SIGKILL when process group termination fails', () => {
      const killSpy = vi.fn((pid: number) => {
        if (pid < 0) {
          throw new Error('ESRCH: no such process group');
        }
      });
      killProcessTree(4242, true, { platform: 'linux', kill: killSpy });

      expect(killSpy).toHaveBeenCalledTimes(2);
      expect(killSpy).toHaveBeenNthCalledWith(1, -4242, 'SIGKILL');
      expect(killSpy).toHaveBeenNthCalledWith(2, 4242, 'SIGKILL');
    });

    it('invokes direct positive-PID SIGKILL when processGroup is false', () => {
      const killSpy = vi.fn();
      killProcessTree(4242, false, { platform: 'linux', kill: killSpy });

      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
    });

    it('catches and suppresses ESRCH errors when process has already exited on POSIX', () => {
      const killSpy = vi.fn(() => {
        throw new Error('ESRCH: no such process');
      });
      expect(() =>
        killProcessTree(4242, false, { platform: 'linux', kill: killSpy }),
      ).not.toThrow();
      expect(killSpy).toHaveBeenCalledTimes(1);
    });
  });

  it.runIf(IS_WINDOWS)(
    'terminates an owned child process on Windows using killProcessTree',
    async () => {
      const child = spawn(
        process.execPath,
        ['-e', 'console.log("READY"); setInterval(() => {}, 1000);'],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        },
      );

      let readyTimer: NodeJS.Timeout | undefined;
      let raceTimer: NodeJS.Timeout | undefined;

      try {
        await new Promise<void>((resolve, reject) => {
          const cleanupReady = () => {
            if (readyTimer) {
              clearTimeout(readyTimer);
              readyTimer = undefined;
            }
            child.stdout?.removeListener('data', onData);
            child.removeListener('error', onError);
            child.removeListener('exit', onExit);
          };
          const onData = (chunk: Buffer | string) => {
            if (chunk.toString().includes('READY')) {
              cleanupReady();
              resolve();
            }
          };
          const onError = (err: Error) => {
            cleanupReady();
            reject(err);
          };
          const onExit = (code: number | null) => {
            cleanupReady();
            reject(new Error(`Test child exited prematurely with code ${code}`));
          };
          readyTimer = setTimeout(() => {
            cleanupReady();
            reject(new Error('Timed out waiting for test child process to be ready'));
          }, 5000);
          child.stdout?.once('data', onData);
          child.once('error', onError);
          child.once('exit', onExit);
        });

        const targetPid = child.pid;
        expect(targetPid).toBeDefined();
        expect(typeof targetPid).toBe('number');
        expect(targetPid).toBeGreaterThan(0);
        expect(child.exitCode).toBeNull();

        const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });

        killProcessTree(targetPid);

        const exitResult = await Promise.race([
          exitPromise,
          new Promise<never>((_, reject) => {
            raceTimer = setTimeout(
              () => reject(new Error('Child process did not exit within 3500ms bound')),
              3500,
            );
          }),
        ]);

        expect(exitResult).toBeDefined();
        expect(child.exitCode !== null || child.killed).toBe(true);
      } finally {
        if (readyTimer) {
          clearTimeout(readyTimer);
          readyTimer = undefined;
        }
        if (raceTimer) {
          clearTimeout(raceTimer);
          raceTimer = undefined;
        }
        try {
          if (child.exitCode === null && !child.killed && child.pid) {
            try {
              execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
                stdio: 'ignore',
                windowsHide: true,
              });
            } catch {}
            child.kill('SIGKILL');
          }
        } finally {
          child.stdout?.destroy();
          child.removeAllListeners();
        }
      }
    },
  );

  it.runIf(!IS_WINDOWS)(
    'terminates POSIX process group with negative PID when probe hangs',
    async () => {
      const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-posix-pgid-'));
      const pidFile = path.join(scratchDir, 'child.pid');
      const scriptFile = path.join(scratchDir, 'wrapper.sh');

      await writeFile(
        scriptFile,
        `#!/bin/sh\nsh -c 'sleep 30' &\necho $! > "${pidFile}"\nwait\n`,
        'utf8',
      );
      await chmod(scriptFile, 0o755);

      const child = spawn(scriptFile, [], {
        detached: true,
        stdio: 'ignore',
      });

      let descendantPid: number | undefined;
      try {
        const leaderPid = child.pid;
        if (!leaderPid) {
          expect.fail('child.pid was not assigned');
        }
        expect(leaderPid).toBeGreaterThan(0);

        for (let i = 0; i < 40 && !existsSync(pidFile); i++) {
          await delay(50);
        }
        expect(existsSync(pidFile)).toBe(true);
        descendantPid = Number((await readFile(pidFile, 'utf8')).trim());
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(descendantPid).toBeGreaterThan(0);

        // Helper to check whether a process is running and not a defunct zombie
        const isProcessRunning = (pid: number): boolean => {
          try {
            process.kill(pid, 0);
          } catch {
            return false;
          }
          // On Linux, inspect /proc/<pid>/status to ensure the process is active and not a zombie
          try {
            const status = readFileSync(`/proc/${pid}/status`, 'utf8');
            const match = status.match(/^State:\s+([A-Za-z])/m);
            if (match && (match[1] === 'Z' || match[1] === 'z')) {
              return false;
            }
          } catch {
            // Non-Linux or process exited before status read
          }
          return true;
        };

        // Verify that both leader and descendant are actively running and not zombies before killing
        expect(isProcessRunning(descendantPid)).toBe(true);
        expect(isProcessRunning(leaderPid)).toBe(true);

        killProcessTree(leaderPid, true);

        let leaderAlive = true;
        let descendantAlive = true;
        for (let i = 0; i < 40; i++) {
          if (leaderAlive) {
            leaderAlive = isProcessRunning(leaderPid);
          }
          if (descendantAlive) {
            descendantAlive = isProcessRunning(descendantPid);
          }
          if (!leaderAlive && !descendantAlive) break;
          await delay(50);
        }

        expect(leaderAlive).toBe(false);
        expect(descendantAlive).toBe(false);
      } finally {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
          try {
            process.kill(child.pid, 'SIGKILL');
          } catch {}
        }
        if (descendantPid) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {}
        }
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  );

  it('throws explicit deadline exceeded error when kicadCliVersion times out', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-kicad-timeout-'));
    const isWin = IS_WINDOWS;
    const fakeKicad = path.join(scratchDir, isWin ? 'fake-hang-kicad.cmd' : 'fake-hang-kicad.sh');

    if (isWin) {
      await writeFile(fakeKicad, '@node -e "setTimeout(() => {}, 10000);"\n', 'utf8');
    } else {
      await writeFile(fakeKicad, '#!/bin/sh\nsleep 10\n', 'utf8');
      await chmod(fakeKicad, 0o755);
    }

    const savedEnv = process.env.COPPERHEAD_KICAD_CLI;
    try {
      process.env.COPPERHEAD_KICAD_CLI = fakeKicad;
      resetKicadCliCache();

      await expect(kicadCliVersion({ timeout: 200 })).rejects.toThrow(
        'kicad-cli version probe exceeded its deadline',
      );
    } finally {
      if (savedEnv !== undefined) {
        process.env.COPPERHEAD_KICAD_CLI = savedEnv;
      } else {
        delete process.env.COPPERHEAD_KICAD_CLI;
      }
      resetKicadCliCache();
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('handles missing KiCad cleanly without failing capability collection', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-missing-test-'));
    const nonExistent = path.join(scratchDir, 'nonexistent-kicad-cli.exe');
    const savedEnv = process.env.COPPERHEAD_KICAD_CLI;

    try {
      process.env.COPPERHEAD_KICAD_CLI = nonExistent;
      resetKicadCliCache();

      const report = await collectCapabilities({
        commands: ['check'],
        deps: {
          nodeVersion: 'v20.19.0',
          cliVersion: '0.12.0',
          gitVersion: async () => '2.43.0',
          openspecVersion: async () => '1.14.1',
        },
      });

      expect(report.tools.kicadCli).toBeNull();
      expect(report.tools.git).toBe('2.43.0');
    } finally {
      if (savedEnv !== undefined) {
        process.env.COPPERHEAD_KICAD_CLI = savedEnv;
      } else {
        delete process.env.COPPERHEAD_KICAD_CLI;
      }
      resetKicadCliCache();
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('real executable probe adapter rejects host paths and unparseable stdout', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-leak-test-'));
    const isWin = process.platform === 'win32';
    const fakeKicad = path.join(scratchDir, isWin ? 'fake-kicad.cmd' : 'fake-kicad.sh');

    const warningOutput =
      'WARNING: could not read /root/private/secret-credentials.json\n';
    if (isWin) {
      await writeFile(
        fakeKicad,
        `@echo ${warningOutput}`,
        'utf8',
      );
    } else {
      await writeFile(
        fakeKicad,
        `#!/bin/sh\necho "${warningOutput}"\n`,
        'utf8',
      );
      await chmod(fakeKicad, 0o755);
    }

    const savedEnv = process.env.COPPERHEAD_KICAD_CLI;
    try {
      process.env.COPPERHEAD_KICAD_CLI = fakeKicad;
      resetKicadCliCache();
      const report = await collectCapabilities({
        commands: ['check'],
        deps: {
          nodeVersion: 'v20.19.0',
          cliVersion: '0.12.0',
          gitVersion: async () => '2.43.0',
          openspecVersion: async () => '1.14.1',
        },
      });

      expect(report.tools.kicadCli).toBeNull();
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('secret-credentials');
      expect(serialized).not.toContain('private');
    } finally {
      if (savedEnv !== undefined) {
        process.env.COPPERHEAD_KICAD_CLI = savedEnv;
      } else {
        delete process.env.COPPERHEAD_KICAD_CLI;
      }
      resetKicadCliCache();
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('real executable probe adapter successfully returns normalized version from responsive executable', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-fast-test-'));
    const isWin = process.platform === 'win32';
    const fakeKicad = path.join(scratchDir, isWin ? 'fake-kicad.cmd' : 'fake-kicad.sh');

    if (isWin) {
      await writeFile(fakeKicad, '@echo kicad-cli 10.0.4\n', 'utf8');
    } else {
      await writeFile(fakeKicad, '#!/bin/sh\necho "kicad-cli 10.0.4"\n', 'utf8');
      await chmod(fakeKicad, 0o755);
    }

    const savedEnv = process.env.COPPERHEAD_KICAD_CLI;
    try {
      process.env.COPPERHEAD_KICAD_CLI = fakeKicad;
      resetKicadCliCache();
      const report = await collectCapabilities({
        timeoutMs: 2000,
        commands: ['check'],
        deps: {
          nodeVersion: 'v20.19.0',
          cliVersion: '0.12.0',
          gitVersion: async () => '2.43.0',
          openspecVersion: async () => '1.14.1',
        },
      });

      expect(report.tools.kicadCli).toBe('10.0.4');
    } finally {
      if (savedEnv !== undefined) {
        process.env.COPPERHEAD_KICAD_CLI = savedEnv;
      } else {
        delete process.env.COPPERHEAD_KICAD_CLI;
      }
      resetKicadCliCache();
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('rejects a valid-looking version from a failing kicad-cli process', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-kicad-fail-'));
    const fakeKicad = await writeFakeExecutable(
      scratchDir,
      'kicad-fail',
      IS_WINDOWS ? '@echo 10.0.4 & exit /b 1' : 'echo "10.0.4"; exit 1',
    );
    const savedEnv = process.env.COPPERHEAD_KICAD_CLI;
    try {
      process.env.COPPERHEAD_KICAD_CLI = fakeKicad;
      resetKicadCliCache();
      const report = await collectCapabilities({
        timeoutMs: 2000,
        commands: ['check'],
        deps: {
          nodeVersion: 'v20.19.0',
          cliVersion: '0.12.0',
          gitVersion: async () => '2.43.0',
          openspecVersion: async () => '1.14.1',
        },
      });

      expect(report.tools.kicadCli).toBeNull();
    } finally {
      if (savedEnv !== undefined) {
        process.env.COPPERHEAD_KICAD_CLI = savedEnv;
      } else {
        delete process.env.COPPERHEAD_KICAD_CLI;
      }
      resetKicadCliCache();
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('degrades a failing git probe to null even when it prints a version', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-git-fail-'));
    try {
      await writeFakeExecutable(
        scratchDir,
        'git',
        IS_WINDOWS ? '@echo git version 2.43.0 & exit /b 1' : 'echo "git version 2.43.0"; exit 1',
      );
      const deps = defaultDeps(1000);
      const value = await withPrependedPath(scratchDir, async () => deps.gitVersion!());
      expect(value).toBeNull();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('degrades a failing or timed-out openspec probe to null instead of parsing printed versions', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-openspec-fail-'));
    try {
      await writeFakeExecutable(
        scratchDir,
        'openspec',
        IS_WINDOWS ? '@echo 9.9.9 & exit /b 1' : 'echo "9.9.9"; exit 1',
      );
      const failing = defaultDeps(1000);
      expect(await withPrependedPath(scratchDir, async () => failing.openspecVersion!())).toBeNull();

      await writeFakeExecutable(
        scratchDir,
        'openspec',
        IS_WINDOWS
          ? '@node -e "console.log(\'9.9.9\'); setTimeout(() => {}, 10000)"'
          : 'echo "9.9.9"; sleep 10',
      );
      const started = Date.now();
      const timedOut = defaultDeps(300);
      expect(await withPrependedPath(scratchDir, async () => timedOut.openspecVersion!())).toBeNull();
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('parses valid output from the default git and openspec probes', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-probe-ok-'));
    try {
      await writeFakeExecutable(
        scratchDir,
        'git',
        IS_WINDOWS ? '@echo git version 2.43.0' : 'echo "git version 2.43.0"',
      );
      await writeFakeExecutable(
        scratchDir,
        'openspec',
        IS_WINDOWS ? '@echo 1.14.1' : 'echo "1.14.1"',
      );
      const deps = defaultDeps(2000);
      const [git, openspec] = await withPrependedPath(scratchDir, async () => [
        await deps.gitVersion!(),
        await deps.openspecVersion!(),
      ]);
      expect(git).toBe('2.43.0');
      expect(openspec).toBe('1.14.1');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

describe('formatCapabilities human output', () => {
  it('formats a clean summary for human consumption', () => {
    const report: CapabilityReport = {
      protocol: 'copperhead-run/1',
      cli: '0.12.0',
      commands: ['check', 'do', 'create'],
      features: [],
      tools: {
        kicadCli: '10.0.4',
        git: '2.43.0',
        openspec: '1.14.1',
        node: 'v20.19.0',
      },
    };

    const formatted = formatCapabilities(report);
    expect(formatted).toContain('copperhead-run/1');
    expect(formatted).toContain('0.12.0');
    expect(formatted).toContain('check, do, create');
    expect(formatted).toContain('10.0.4');
    expect(formatted).toContain('2.43.0');
    expect(formatted).toContain('1.14.1');
  });

  it('formats missing tools cleanly as not found / none', () => {
    const report: CapabilityReport = {
      protocol: 'copperhead-run/1',
      cli: '0.12.0',
      commands: ['check'],
      features: [],
      tools: {
        kicadCli: null,
        git: null,
        openspec: null,
        node: 'v20.19.0',
      },
    };

    const formatted = formatCapabilities(report);
    expect(formatted).toContain('none');
  });
});

describe('doctor independence', () => {
  it('doctor remains independent and its report is unaffected by capabilities', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-doc-test-'));
    try {
      const report = await runDoctor({ repoRoot: scratchDir });
      expect(report).toHaveProperty('ok');
      expect(report).toHaveProperty('checks');
      expect(Array.isArray(report.checks)).toBe(true);
      const names = report.checks.map((c) => c.name);
      expect(names).toContain('node');
      expect(names).toContain('git');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

describe('real CLI process execution (published build and source entry point)', () => {
  it('node dist/cli.js capabilities --json produces valid JSON outside a repo with clean stderr', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-dist-cap-'));
    try {
      const res = await execa(process.execPath, [DIST_CLI, 'capabilities', '--json'], {
        cwd: scratchDir,
        reject: false,
        env: {
          NO_COLOR: '1',
          PATH: process.env.PATH,
        },
      });

      expect(res.exitCode).toBe(0);
      expect(res.stderr).toBe('');

      const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
        version: string;
      };
      const parsed = JSON.parse(res.stdout) as CapabilityReport;
      expect(parsed.protocol).toBe('copperhead-run/1');
      expect(parsed.cli).toBe(pkg.version);
      expect(parsed.commands).toContain('capabilities');
      expect(parsed.commands).toContain('check');
      expect(parsed.commands).toContain('do');
      expect(parsed.commands).toContain('doctor');
      expect(parsed.commands).toContain('review');
      expect(parsed.features).toEqual([]);
      expect(parsed.tools.node).toMatch(/^v\d+/);

      // Verify no repository artifacts or metadata created in working directory
      const files = await readdir(scratchDir);
      expect(files).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('runs cleanly without any model API keys or credentials in environment', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-cap-no-keys-'));
    try {
      const res = await execa(process.execPath, [DIST_CLI, 'capabilities', '--json'], {
        cwd: scratchDir,
        reject: false,
        env: {
          NO_COLOR: '1',
          PATH: process.env.PATH,
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          COPPERHEAD_MODEL: '',
        },
      });

      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout) as CapabilityReport;
      expect(parsed.protocol).toBe('copperhead-run/1');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it('shows capabilities in help output of published build', async () => {
    const res = await execa(process.execPath, [DIST_CLI, '--help'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('capabilities');
  });

  it('prints human summary when invoked without --json', async () => {
    const res = await execa(process.execPath, [DIST_CLI, 'capabilities'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('copperhead-run/1');
    expect(res.stdout).toContain('Protocol:');
  });

  it('structurally rejects unimplemented protocol options in Phase 0', async () => {
    const streamRes = await execa(process.execPath, [DIST_CLI, 'capabilities', '--event-stream'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });
    expect(streamRes.exitCode).not.toBe(0);
    expect(streamRes.stderr).toMatch(/unknown option/i);

    const resultRes = await execa(process.execPath, [DIST_CLI, 'capabilities', '--result'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });
    expect(resultRes.exitCode).not.toBe(0);
    expect(resultRes.stderr).toMatch(/unknown option/i);
  });

  it('derives expected commands independently from observed CLI registration and guarantees parity', async () => {
    // Read actual CLI help output to derive registered public primary command set
    const helpRes = await execa(process.execPath, [DIST_CLI, '--help'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });
    expect(helpRes.exitCode).toBe(0);

    const observedCommands: string[] = [];
    const lines = helpRes.stdout.split('\n');
    const cmdSectionIndex = lines.findIndex((l) => l.trim() === 'Commands:');
    expect(cmdSectionIndex).toBeGreaterThan(-1);

    for (let i = cmdSectionIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.trim() === '') continue;
      // Description continuation lines are indented with 3 or more spaces
      if (/^ {3,}\S/.test(line)) continue;
      // Command definition lines must begin with exactly two spaces
      if (/^ {2}\S/.test(line)) {
        const match = line.match(
          /^ {2}([a-z0-9_-]+)(?:\|[a-z0-9_-]+)?(?:\s+\[[^\]]+\]|\s+<[^>]+>)*\s{2,}/,
        );
        if (!match || !match[1]) {
          expect.fail(`Failed to parse command definition line in help output: "${line}"`);
        }
        if (match[1] !== 'help') {
          observedCommands.push(match[1]);
        }
        continue;
      }
      // Any other non-empty line marks the end of the Commands section
      break;
    }
    const expectedSorted = [...observedCommands].sort();

    // Verify observed command set is complete and truthful
    expect(observedCommands.length).toBe(15);
    expect(observedCommands).toEqual(
      expect.arrayContaining([
        'capabilities',
        'check',
        'create',
        'demo',
        'do',
        'doctor',
        'draft',
        'export',
        'init',
        'mcp',
        'repl',
        'review',
        'score',
        'skill',
        'sync',
      ]),
    );

    // Verify capabilities --json descriptor matches the independently observed command set exactly
    const capRes = await execa(process.execPath, [DIST_CLI, 'capabilities', '--json'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });
    expect(capRes.exitCode).toBe(0);

    const parsed = JSON.parse(capRes.stdout) as CapabilityReport;
    expect(parsed.commands.length).toBe(15);
    expect(parsed.commands).toEqual(expectedSorted);
  });

  it('guarantees build versus source CLI semantic parity using direct tsx execution', async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-parity-'));
    try {
      await writeFakeExecutable(
        scratchDir,
        'git',
        IS_WINDOWS ? '@echo git version 2.44.0' : 'echo "git version 2.44.0"',
      );
      await writeFakeExecutable(
        scratchDir,
        'openspec',
        IS_WINDOWS ? '@echo 1.10.0' : 'echo "1.10.0"',
      );
      const fakeKicad = await writeFakeExecutable(
        scratchDir,
        'fake-kicad-cli',
        IS_WINDOWS ? '@echo 10.0.4' : 'echo "10.0.4"',
      );

      const controlledEnv = {
        ...process.env,
        NO_COLOR: '1',
        PATH: `${scratchDir}${path.delimiter}${process.env.PATH ?? ''}`,
        COPPERHEAD_KICAD_CLI: fakeKicad,
      };

      const distRes = await execa(process.execPath, [DIST_CLI, 'capabilities', '--json'], {
        cwd: ROOT,
        reject: false,
        env: controlledEnv,
      });

      const srcRes = await execa(process.execPath, [TSX_CLI, SRC_CLI, 'capabilities', '--json'], {
        cwd: ROOT,
        reject: false,
        env: controlledEnv,
      });

      expect(distRes.exitCode).toBe(0);
      expect(srcRes.exitCode).toBe(0);

      const distJson = JSON.parse(distRes.stdout) as CapabilityReport;
      const srcJson = JSON.parse(srcRes.stdout) as CapabilityReport;

      // Independent expected-value oracles
      expect(distJson.protocol).toBe(COPPERHEAD_RUN_PROTOCOL);
      expect(distJson.features).toEqual([]);
      expect(distJson.tools).toEqual({
        node: process.version,
        kicadCli: '10.0.4',
        git: '2.44.0',
        openspec: '1.10.0',
      });

      // Strict semantic parity between dist/cli.js and tsx src/cli.ts
      expect(distJson.protocol).toBe(srcJson.protocol);
      expect(distJson.cli).toBe(srcJson.cli);
      expect(distJson.commands).toEqual(srcJson.commands);
      expect(distJson.features).toEqual(srcJson.features);
      expect(distJson.tools).toEqual(srcJson.tools);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
