import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
import { resetKicadCliCache, execKicadProcess, killProcessTree } from '../src/kicad/cli.js';

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
    cliVersion: '0.11.0',
    kicadVersion: async () => '10.0.4',
    gitVersion: async () => '2.43.0',
    openspecVersion: async () => '1.14.1',
    ...over,
  };
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
    expect(isProtocolCompatible('copperhead-run/1.anything')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/2')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/0')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/3.0')).toBe(false);
    expect(isProtocolCompatible('other-protocol/1')).toBe(false);
    expect(isProtocolCompatible('')).toBe(false);
    expect(isProtocolCompatible('copperhead-run')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/')).toBe(false);
    expect(isProtocolCompatible('copperhead-run/1.2.3')).toBe(false);
  });

  it('assertProtocolCompatible accepts valid report and rejects unknown major or invalid input', () => {
    const validReport: CapabilityReport = {
      protocol: 'copperhead-run/1',
      cli: '0.11.0',
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
    expect(() => assertProtocolCompatible({} as unknown as CapabilityReport, 1)).toThrow(
      /unsupported protocol version/i,
    );
    expect(() =>
      assertProtocolCompatible('not-a-report' as unknown as CapabilityReport, 1),
    ).toThrow(/unsupported protocol version/i);
  });

  it('consumer compatibility ignores unknown added JSON fields (extensibility)', () => {
    const extendedReport = {
      protocol: 'copperhead-run/1',
      cli: '0.11.0',
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
      cliVersion: '0.11.0',
      kicadVersion: async () => '10.0.4',
      gitVersion: async () => '2.43.0',
      openspecVersion: async () => '1.14.1',
    });

    const report = await collectCapabilities({ deps, commands: ['check', 'do'] });

    expect(report).toEqual({
      protocol: 'copperhead-run/1',
      cli: '0.11.0',
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

  it('returns empty array when neither program nor explicit commands are given', () => {
    expect(extractPublicCommands()).toEqual([]);
  });
});

describe('subprocess adapter and probe deadline enforcement', () => {
  it('enforces deadline on slow Windows wrapper, terminates descendant process tree, and unblocks handshake within bounded time', async () => {
    // Configurable short timeout of 300ms with a delayed executable (10s delay)
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'copperhead-wrapper-hang-'));
    const pidFile = path.join(scratchDir, 'descendant.pid');
    const isWin = process.platform === 'win32';
    const fakeKicad = path.join(scratchDir, isWin ? 'fake-kicad.cmd' : 'fake-kicad.sh');

    if (isWin) {
      const nodeCode = `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => console.log('10.0.4'), 10000);`;
      await writeFile(fakeKicad, `@node -e "${nodeCode}"\n`, 'utf8');
    } else {
      await writeFile(
        fakeKicad,
        `#!/bin/sh\nsleep 10\necho "10.0.4"\n`,
        'utf8',
      );
      await chmod(fakeKicad, 0o755);
    }

    const savedEnv = process.env.COPPERHEAD_KICAD_CLI;
    try {
      process.env.COPPERHEAD_KICAD_CLI = fakeKicad;
      resetKicadCliCache();
      const startTime = Date.now();

      const report = await collectCapabilities({
        timeoutMs: 300,
        commands: ['check'],
        deps: {
          nodeVersion: 'v20.19.0',
          cliVersion: '0.11.0',
          gitVersion: async () => '2.43.0',
          openspecVersion: async () => '1.14.1',
        },
      });

      const elapsed = Date.now() - startTime;

      // Must degrade to null on timeout rather than hanging
      expect(report.tools.kicadCli).toBeNull();
      expect(report.tools.git).toBe('2.43.0');

      // Handshake must complete within a reasonable bounded tolerance (well below the 10s child delay)
      expect(elapsed).toBeLessThan(4500);

      // On Windows, verify that the descendant child process was terminated and not orphaned
      if (isWin && existsSync(pidFile)) {
        const descendantPid = (await readFile(pidFile, 'utf8')).trim();
        if (descendantPid) {
          let tasklistOutput = '';
          try {
            tasklistOutput = execFileSync('tasklist', ['/FI', `PID eq ${descendantPid}`], {
              encoding: 'utf8',
              windowsHide: true,
            });
          } catch {}
          expect(tasklistOutput).not.toContain(descendantPid);
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
    const res = await execKicadProcess(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000);'],
      300,
    );
    const elapsed = Date.now() - startTime;

    expect(res.failed).toBe(true);
    // Bounded execution: completes well before 10000ms delay
    expect(elapsed).toBeLessThan(3500);
  });

  it('handles responsive native executable cleanly and quickly', async () => {
    const res = await execKicadProcess(process.execPath, ['-v'], 3000);
    expect(res.failed).toBe(false);
    expect(String(res.stdout).trim()).toMatch(/^v\d+/);
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
          cliVersion: '0.11.0',
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
          cliVersion: '0.11.0',
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
          cliVersion: '0.11.0',
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
});

describe('formatCapabilities human output', () => {
  it('formats a clean summary for human consumption', () => {
    const report: CapabilityReport = {
      protocol: 'copperhead-run/1',
      cli: '0.11.0',
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
    expect(formatted).toContain('0.11.0');
    expect(formatted).toContain('check, do, create');
    expect(formatted).toContain('10.0.4');
    expect(formatted).toContain('2.43.0');
    expect(formatted).toContain('1.14.1');
  });

  it('formats missing tools cleanly as not found / none', () => {
    const report: CapabilityReport = {
      protocol: 'copperhead-run/1',
      cli: '0.11.0',
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

      const parsed = JSON.parse(res.stdout) as CapabilityReport;
      expect(parsed.protocol).toBe('copperhead-run/1');
      expect(parsed.cli).toMatch(/^\d+\.\d+\.\d+/);
      expect(parsed.commands).toContain('capabilities');
      expect(parsed.commands).toContain('check');
      expect(parsed.commands).toContain('do');
      expect(parsed.commands).toContain('doctor');
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
      // Match command definition line: indentation followed by command name (with optional aliases and arguments)
      const match = line.match(
        /^ {2}([a-z0-9_-]+)(?:\|[a-z0-9_-]+)?(?:\s+\[[^\]]+\]|\s+<[^>]+>)*\s{2,}/,
      );
      if (match && match[1] !== 'help') {
        observedCommands.push(match[1]);
      }
    }
    const expectedSorted = [...observedCommands].sort();

    // Verify capabilities --json descriptor matches the independently observed command set exactly
    const capRes = await execa(process.execPath, [DIST_CLI, 'capabilities', '--json'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });
    expect(capRes.exitCode).toBe(0);

    const parsed = JSON.parse(capRes.stdout) as CapabilityReport;
    expect(parsed.commands).toEqual(expectedSorted);
  });

  it('guarantees build versus source CLI semantic parity using direct tsx execution', async () => {
    const distRes = await execa(process.execPath, [DIST_CLI, 'capabilities', '--json'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });

    const srcRes = await execa(process.execPath, [TSX_CLI, SRC_CLI, 'capabilities', '--json'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1', PATH: process.env.PATH },
    });

    expect(distRes.exitCode).toBe(0);
    expect(srcRes.exitCode).toBe(0);

    const distJson = JSON.parse(distRes.stdout) as CapabilityReport;
    const srcJson = JSON.parse(srcRes.stdout) as CapabilityReport;

    expect(distJson.protocol).toBe(srcJson.protocol);
    expect(distJson.cli).toBe(srcJson.cli);
    expect(distJson.commands).toEqual(srcJson.commands);
    expect(distJson.features).toEqual(srcJson.features);
    expect(distJson.tools.node).toBe(srcJson.tools.node);
    expect(distJson.tools.kicadCli).toBe(srcJson.tools.kicadCli);
    expect(distJson.tools.git).toBe(srcJson.tools.git);
    expect(distJson.tools.openspec).toBe(srcJson.tools.openspec);
  });
});
