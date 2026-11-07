import { describe, expect, it, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { runCheck, spiceGateConfig, spiceGateFailsCheck } from '../src/commands/check.js';
import { exportSpiceNetlist, kicadCliVersion } from '../src/kicad/cli.js';
import {
  NGSPICE_PROBE_TIMEOUT_MS,
  NgspiceBadOverrideError,
  NgspiceMissingError,
  NgspiceUnusableError,
  formatSpiceGate,
  resetNgspiceCache,
  resolveNgspice,
  runNgspice,
  runSpiceGate,
  spiceDeckProblems,
  spiceScopeProblems,
  type SpiceExec,
  type SpiceExecResult,
  type SpiceGateDeps,
  type SpiceRunResult,
} from '../src/kicad/spice-run.js';
import { assembleSpiceDeck, collectGateMeasures, parseSimulationBlocks } from '../src/kicad/spice.js';

/**
 * divider.cir is a 10k/10k divider with ground named GND, as KiCad exports it.
 * ngspice-pass.txt / ngspice-fail.txt are real ngspice-47 stdout from
 * `ngspice -n -b gate.cir` on the deck assembleSpiceDeck builds from
 * divider.cir and SUBSYSTEMS.md / SUBSYSTEMS-fail.md. ngspice-unrunnable.txt
 * is the stderr of the pass deck with R1 replaced by `XU1 VIN VOUT unk_reg`.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'spice');
const silent = (): void => {};

function onPath(bin: string): boolean {
  const probe = spawnSync(bin, ['-v'], { stdio: 'ignore', timeout: 10_000 });
  return !probe.error && probe.status === 0;
}

const HAS_NGSPICE = onPath('ngspice');
const HAS_KICAD = await kicadCliVersion().then(
  () => true,
  () => false,
);

/** A fake execa that returns one canned result and records each call. */
function fakeExec(result: SpiceExecResult): { exec: SpiceExec; calls: Array<{ file: string; args: string[]; cwd?: string; timeout: number }> } {
  const calls: Array<{ file: string; args: string[]; cwd?: string; timeout: number }> = [];
  return {
    calls,
    exec: async (file, args, options) => {
      calls.push({ file, args, timeout: options.timeout, ...(options.cwd ? { cwd: options.cwd } : {}) });
      return result;
    },
  };
}

async function spiceRepo(markdown: string): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-spice-'));
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  await writeFile(path.join(repo, 'docs', 'SUBSYSTEMS.md'), markdown, 'utf8');
  await writeFile(path.join(repo, 'board.kicad_sch'), '(kicad_sch (version 20230121) (generator test))\n', 'utf8');
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

function stubDeps(over: Partial<SpiceGateDeps> & { run?: SpiceRunResult } = {}): Partial<SpiceGateDeps> {
  const run: SpiceRunResult = over.run ?? { stdout: '', stderr: '', exitCode: 0 };
  return {
    exportNetlist: async () => readFile(path.join(FIXTURES, 'divider.cir'), 'utf8'),
    runNgspice: async () => run,
    resolveNgspice: async () => 'ngspice',
    netsOf: async () => ['VIN', 'VOUT', 'GND'],
    sheetsOf: async () => ['/', '/Power'],
    ...over,
  };
}

afterEach(() => {
  resetNgspiceCache();
});

describe('spiceGateFailsCheck', () => {
  it('fails on assertion failure, and on skip only when strict', () => {
    expect(spiceGateFailsCheck(undefined, false)).toBe(false);
    expect(spiceGateFailsCheck({ status: 'idle', blocks: 0, assertions: [], violations: [], errors: [] }, true)).toBe(false);
    expect(spiceGateFailsCheck({ status: 'pass', blocks: 1, assertions: [], violations: [], errors: [] }, true)).toBe(false);
    expect(spiceGateFailsCheck({ status: 'skip', blocks: 1, assertions: [], violations: [], errors: [] }, false)).toBe(false);
    expect(spiceGateFailsCheck({ status: 'skip', blocks: 1, assertions: [], violations: [], errors: [] }, true)).toBe(true);
    expect(spiceGateFailsCheck({ status: 'fail', blocks: 1, assertions: [], violations: [], errors: ['x'] }, false)).toBe(true);
  });
});

describe('spiceScopeProblems', () => {
  it('names a missing net and a missing sheet', () => {
    const [netsBlock] = parseSimulationBlocks(`## Simulation
scope: nets VOUT_X, VIN
analysis: op
assert: V(VOUT_X) > 1
`);
    expect(spiceScopeProblems(netsBlock!, ['VIN', 'VOUT'], ['/'])).toEqual([
      'Simulation block line 1: net "VOUT_X" is not in the schematic',
    ]);

    const [sheetBlock] = parseSimulationBlocks(`## Simulation
scope: sheet /Missing
analysis: op
assert: V(OUT) > 1
`);
    expect(spiceScopeProblems(sheetBlock!, ['OUT'], ['/', '/Power'])).toEqual([
      'Simulation block line 1: sheet "/Missing" is not in the schematic',
    ]);
  });
});

describe('formatSpiceGate', () => {
  it('prints idle, loud skip, pass, and error-only fail', () => {
    expect(formatSpiceGate({ status: 'idle', blocks: 0, assertions: [], violations: [], errors: [] })).toEqual([
      'SPICE skipped (no ## Simulation blocks)',
    ]);
    expect(
      formatSpiceGate({
        status: 'skip',
        blocks: 1,
        assertions: [],
        violations: [],
        skipped: 'ngspice not found',
        unverified: 2,
        errors: [],
      }),
    ).toEqual(['SPICE gate skipped (ngspice not found): 2 assertion(s) unverified']);
    expect(
      formatSpiceGate({
        status: 'pass',
        blocks: 1,
        assertions: [{ assertion: 'V(OUT) > 1', status: 'pass', detail: 'V(OUT) > 1: measured 1.65', line: 4 }],
        violations: [],
        errors: [],
      }),
    ).toEqual(['SPICE ✓ 1 assertion(s)', '  ✓ V(OUT) > 1: measured 1.65']);
    expect(
      formatSpiceGate({
        status: 'fail',
        blocks: 1,
        assertions: [],
        violations: [],
        errors: ['Simulation block line 3: net "VOUT_X" is not in the schematic'],
      }),
    ).toEqual([
      'SPICE ✗ 1 error(s)',
      '  Simulation block line 3: net "VOUT_X" is not in the schematic',
    ]);
  });
});

describe('runSpiceGate', () => {
  it('is idle when SUBSYSTEMS.md has no Simulation block', async () => {
    const { repo, cleanup } = await spiceRepo('# Subsystems\n\nNo simulations.\n');
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({
          resolveNgspice: async () => {
            throw new Error('ngspice should not be probed when idle');
          },
        }),
      });
      expect(report.status).toBe('idle');
      expect(report.blocks).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('is idle when SUBSYSTEMS.md is absent', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-spice-nodocs-'));
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps(),
      });
      expect(report.status).toBe('idle');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('skips loudly when ngspice is missing', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({
          resolveNgspice: async () => {
            throw new NgspiceMissingError();
          },
          runNgspice: async () => {
            throw new Error('must not run');
          },
        }),
      });
      expect(report.status).toBe('skip');
      expect(report.skipped).toBe('ngspice not found');
      expect(report.unverified).toBe(1);
      expect(formatSpiceGate(report)[0]).toMatch(/SPICE gate skipped \(ngspice not found\): 1 assertion/);
    } finally {
      await cleanup();
    }
  });

  it('fails a set-but-missing ngspice override instead of skipping', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({
          resolveNgspice: async () => {
            throw new NgspiceBadOverrideError('/no/such/ngspice');
          },
        }),
      });
      expect(report.status).toBe('fail');
      expect(report.errors[0]).toContain('/no/such/ngspice');
    } finally {
      await cleanup();
    }
  });

  it('fails a parse error without invoking ngspice', async () => {
    const { repo, cleanup } = await spiceRepo(`## Simulation
scope: nets VIN, VOUT
analysis: op
.control
assert: V(VOUT) > 1
`);
    let ran = false;
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({
          resolveNgspice: async () => {
            ran = true;
            return 'ngspice';
          },
        }),
      });
      expect(report.status).toBe('fail');
      expect(report.errors[0]).toMatch(/raw ngspice statement "\.control"/);
      expect(ran).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('fails scope drift for a net that is not in the schematic', async () => {
    const { repo, cleanup } = await spiceRepo(`## Simulation
scope: nets VOUT_X, VIN
analysis: op
assert: V(VOUT_X) > 1
`);
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({
          runNgspice: async () => {
            throw new Error('must not run on scope drift');
          },
        }),
      });
      expect(report.status).toBe('fail');
      expect(report.errors).toEqual(['Simulation block line 1: net "VOUT_X" is not in the schematic']);
    } finally {
      await cleanup();
    }
  });

  it('passes a V(VOUT) between assertion from the captured fixture', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const stdout = await readFile(path.join(FIXTURES, 'ngspice-pass.txt'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({ run: { stdout, stderr: '', exitCode: 0 } }),
      });
      expect(report.status).toBe('pass');
      expect(report.assertions).toHaveLength(1);
      expect(report.assertions[0]).toMatchObject({ status: 'pass', measured: 1.65 });
    } finally {
      await cleanup();
    }
  });

  it('fails with the measured value when the assertion is out of bounds', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS-fail.md'), 'utf8');
    const stdout = await readFile(path.join(FIXTURES, 'ngspice-fail.txt'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({ run: { stdout, stderr: '', exitCode: 0 } }),
      });
      expect(report.status).toBe('fail');
      expect(report.assertions[0]).toMatchObject({ status: 'fail', measured: 1.65, bound: '3.0 .. 3.1' });
      expect(report.violations).toEqual([
        {
          severity: 'error',
          type: 'spice_assertion',
          description: 'V(VOUT) between 3.0 and 3.1: measured 1.65 (bound 3.0 .. 3.1)',
          measured: 1.65,
          bound: '3.0 .. 3.1',
          items: [],
          line: 7,
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('treats an unrunnable simulation as a failure with the stderr excerpt', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const stderr = await readFile(path.join(FIXTURES, 'ngspice-unrunnable.txt'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({ run: { stdout: '', stderr, exitCode: 1 } }),
      });
      expect(report.status).toBe('fail');
      expect(report.assertions[0]?.status).toBe('unrunnable');
      expect(report.assertions[0]?.detail).toMatch(/unknown subckt: xu1 vin vout unk_reg/);
      expect(report.violations[0]).toMatchObject({ severity: 'error', type: 'spice_simulation_failed', line: 3 });
    } finally {
      await cleanup();
    }
  });

  it('passes the configured timeout to the ngspice runner', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    const seen: number[] = [];
    try {
      await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        timeoutMs: 12_000,
        deps: stubDeps({
          runNgspice: async (_deck, timeoutMs) => {
            seen.push(timeoutMs);
            return { stdout: await readFile(path.join(FIXTURES, 'ngspice-pass.txt'), 'utf8'), stderr: '', exitCode: 0 };
          },
        }),
      });
      expect(seen).toEqual([12_000]);
    } finally {
      await cleanup();
    }
  });
});

describe('resolveNgspice', () => {
  it('honours COPPERHEAD_NGSPICE when the path exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-ngspice-'));
    const bin = path.join(dir, 'ngspice');
    try {
      await writeFile(bin, '#!/bin/sh\necho "ngspice-34"\n', 'utf8');
      await chmod(bin, 0o755);
      resetNgspiceCache();
      expect(await resolveNgspice({ COPPERHEAD_NGSPICE: bin })).toBe(bin);
    } finally {
      resetNgspiceCache();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws NgspiceBadOverrideError when the override path is missing', async () => {
    resetNgspiceCache();
    await expect(resolveNgspice({ COPPERHEAD_NGSPICE: '/no/such/ngspice' })).rejects.toBeInstanceOf(
      NgspiceBadOverrideError,
    );
  });
});

describe('check --spice JSON contract (AC-2.4 / AC-2.6)', () => {
  it('omits the spice key unless --spice was passed', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-check-spice-'));
    try {
      const res = await runCheck(repo, silent);
      expect(Object.keys(res).sort()).toEqual(['constraints', 'drc', 'drift', 'erc', 'legibility', 'ok', 'openspec']);
      expect(res.spice).toBeUndefined();
      expect(res.ok).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('adds spice and fails when --spice runs without a schematic', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-check-spice-'));
    try {
      const res = await runCheck(repo, silent, { spice: true });
      expect(res.spice?.status).toBe('fail');
      expect(res.spice?.errors[0]).toMatch(/needs a configured schematic/);
      expect(res.ok).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('spice config', () => {
  it('loads spice.ngspice and spice.timeoutMs from config.json', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-spice-cfg-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ spice: { ngspice: '/opt/ngspice', timeoutMs: 15_000 } }),
        'utf8',
      );
      const config = await loadConfig(repo);
      expect(config.spice).toEqual({ ngspice: '/opt/ngspice', timeoutMs: 15_000 });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('copperhead check --help', () => {
  it('lists --spice and --strict', async () => {
    const res = await execa('npx', ['tsx', 'src/cli.ts', 'check', '--help'], {
      cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
      reject: false,
      env: { NO_COLOR: '1' },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('--spice');
    expect(res.stdout).toContain('--strict');
    expect(res.stdout).toContain('## Simulation');
  }, 30_000);
});

describe('SPICE gate stays LLM-free and network-free', () => {
  it('the spice-run module graph never imports a provider or SDK', async () => {
    const seen = new Set<string>();
    const queue = ['src/kicad/spice-run.ts'];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(/providers\/|from 'openai'|@anthropic-ai/);
      expect(file, file).not.toMatch(/agent\/|capabilities/);
      for (const m of text.matchAll(/from '(\.[^']+)\.js'/g)) {
        queue.push(path.join(path.dirname(file), m[1]!) + '.ts');
      }
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe('ngspice PATH probe (stubbed execa)', () => {
  it("treats the Windows shell's \"'ngspice' is not recognized\" exit 1 as missing", async () => {
    const { exec, calls } = fakeExec({
      exitCode: 1,
      stdout: '',
      stderr: "'ngspice' is not recognized as an internal or external command,\r\noperable program or batch file.",
    });
    await expect(resolveNgspice({}, undefined, exec)).rejects.toBeInstanceOf(NgspiceMissingError);
    expect(calls[0]).toMatchObject({ file: 'ngspice', args: ['-v'], timeout: NGSPICE_PROBE_TIMEOUT_MS });
  });

  it('skips the gate loudly (not unrunnable) when the probe gets that Windows answer', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    const { exec } = fakeExec({ exitCode: 1, stderr: "'ngspice' is not recognized as an internal or external command" });
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({
          resolveNgspice: () => resolveNgspice({}, undefined, exec),
          runNgspice: async () => {
            throw new Error('must not run');
          },
        }),
      });
      expect(report.status).toBe('skip');
      expect(report.unverified).toBe(1);
      expect(spiceGateFailsCheck(report, false)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('treats an ENOENT result or a thrown ENOENT as missing', async () => {
    await expect(resolveNgspice({}, undefined, fakeExec({ code: 'ENOENT' }).exec)).rejects.toBeInstanceOf(
      NgspiceMissingError,
    );
    resetNgspiceCache();
    const throwing: SpiceExec = async () => {
      throw Object.assign(new Error('spawn ngspice ENOENT'), { code: 'ENOENT' });
    };
    await expect(resolveNgspice({}, undefined, throwing)).rejects.toBeInstanceOf(NgspiceMissingError);
  });

  it('requires exit 0 and an ngspice-<n> banner, and records the version', async () => {
    await expect(
      resolveNgspice({}, undefined, fakeExec({ exitCode: 0, stdout: 'some other tool 1.0' }).exec),
    ).rejects.toBeInstanceOf(NgspiceMissingError);
    resetNgspiceCache();
    const { exec } = fakeExec({ exitCode: 0, stdout: '******\n** ngspice-47 : Circuit level simulation program\n' });
    expect(await resolveNgspice({}, undefined, exec)).toBe('ngspice');
  });

  it('fails (does not hang or skip) when "ngspice -v" times out', async () => {
    await expect(
      resolveNgspice({}, undefined, fakeExec({ timedOut: true, exitCode: undefined }).exec),
    ).rejects.toBeInstanceOf(NgspiceUnusableError);
  });

  it('fails the gate when the probe times out', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({
          resolveNgspice: () => resolveNgspice({}, undefined, fakeExec({ timedOut: true }).exec),
        }),
      });
      expect(report.status).toBe('fail');
      expect(report.errors[0]).toMatch(/did not exit within 10000 ms/);
    } finally {
      await cleanup();
    }
  });
});

describe('runNgspice (stubbed execa)', () => {
  it('runs "-n -b gate.cir" in a fresh temp dir with the timeout', async () => {
    const { exec, calls } = fakeExec({ exitCode: 0, stdout: 'a1_0_value = 1\n', stderr: '' });
    const res = await runNgspice('* deck\n.end\n', 4_000, '/opt/ngspice', exec);
    expect(res).toEqual({ stdout: 'a1_0_value = 1\n', stderr: '', exitCode: 0 });
    expect(calls[0]).toMatchObject({ file: '/opt/ngspice', args: ['-n', '-b', 'gate.cir'], timeout: 4_000 });
    expect(calls[0]!.cwd).toBeDefined();
    expect(calls[0]!.cwd).not.toBe(process.cwd());
    expect(path.basename(calls[0]!.cwd!)).toMatch(/^copperhead-spice-/);
  });

  it('reports a killed run as timedOut', async () => {
    const { exec } = fakeExec({ timedOut: true, exitCode: undefined, stdout: 'Circuit: x', stderr: '' });
    expect(await runNgspice('* deck\n', 50, 'ngspice', exec)).toMatchObject({ timedOut: true, exitCode: 1 });
  });

  it('throws NgspiceMissingError when the binary vanished', async () => {
    await expect(runNgspice('* deck\n', 50, 'ngspice', fakeExec({ code: 'ENOENT' }).exec)).rejects.toBeInstanceOf(
      NgspiceMissingError,
    );
  });
});

describe('SPICE gate refuses netlist control blocks', () => {
  const forged = [
    '.title KiCad schematic',
    '.control',
    'shell echo PWNED_BY_SCHEMATIC',
    'echo a3_0_value = 1.65',
    '.endc',
    'R1 VIN VOUT 10k',
    'R2 VOUT GND 10k',
    '.end',
  ].join('\n');

  it('fails a netlist with a .control block and never calls ngspice', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    let ran = false;
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({
          exportNetlist: async () => forged,
          runNgspice: async () => {
            ran = true;
            return { stdout: 'a3_0_value = 1.65\n', stderr: '', exitCode: 0 };
          },
        }),
      });
      expect(report.status).toBe('fail');
      expect(report.errors).toEqual([
        'netlist line 2: ".control" is not allowed in a SPICE gate deck',
        'netlist line 5: ".endc" is not allowed in a SPICE gate deck',
      ]);
      expect(ran).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('follows .include into a local model file with a .control block', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-spice-inc-'));
    try {
      await mkdir(path.join(dir, 'models'));
      await writeFile(path.join(dir, 'models', 'ok.lib'), '.include "nested.lib"\n', 'utf8');
      await writeFile(path.join(dir, 'models', 'nested.lib'), '.control\nshell id\n.endc\n', 'utf8');
      const readInclude = async (f: string): Promise<string | null> => readFile(f, 'utf8').catch(() => null);
      const problems = await spiceDeckProblems('.include "models/ok.lib"\n.lib missing.lib\nR1 A 0 1k\n', dir, readInclude);
      expect(problems).toEqual([
        `${path.join(dir, 'models', 'nested.lib')}: line 1: ".control" is not allowed in a SPICE gate deck`,
        `${path.join(dir, 'models', 'nested.lib')}: line 3: ".endc" is not allowed in a SPICE gate deck`,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not count echoed or duplicated measure lines as measurements', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    try {
      const onStderr = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({
          run: {
            stdout: '',
            stderr: 'a3_0_value = 1.65\na3_0_lower_margin = 0.05\na3_0_upper_margin = 0.05\n',
            exitCode: 0,
          },
        }),
      });
      expect(onStderr.status).toBe('fail');
      expect(onStderr.assertions[0]?.detail).toBe('no measured a3_0_value');

      const pass = await readFile(path.join(FIXTURES, 'ngspice-pass.txt'), 'utf8');
      const twice = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({ run: { stdout: `a3_0_value = 1.0\n${pass}`, stderr: '', exitCode: 0 } }),
      });
      expect(twice.status).toBe('fail');
      expect(twice.assertions[0]).toMatchObject({ status: 'unrunnable' });
      expect(twice.assertions[0]?.detail).toMatch(/a3_0_value more than once/);
    } finally {
      await cleanup();
    }
  });
});

describe('SPICE gate timeout and result shape', () => {
  it('reports a run that hit the timeout as "simulation timed out", not "ngspice exit 1"', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const { repo, cleanup } = await spiceRepo(markdown);
    try {
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        timeoutMs: 12_000,
        deps: stubDeps({ run: { stdout: 'Circuit: KiCad schematic\n', stderr: '', exitCode: 1, timedOut: true } }),
      });
      expect(report.status).toBe('fail');
      expect(report.assertions[0]).toMatchObject({ status: 'unrunnable', detail: 'simulation timed out after 12000 ms' });
      expect(report.violations[0]).toMatchObject({
        severity: 'error',
        type: 'spice_simulation_failed',
        description: 'simulation timed out after 12000 ms',
      });
    } finally {
      await cleanup();
    }
  });

  it('attributes a sheet-scoped violation to its sheet', async () => {
    const { repo, cleanup } = await spiceRepo(`## Simulation
scope: sheet /Power
analysis: op
source: VIN=3.3
assert: V(VOUT) between 3.0 and 3.1
`);
    try {
      const stdout = await readFile(path.join(FIXTURES, 'ngspice-fail.txt'), 'utf8');
      const report = await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: stubDeps({ run: { stdout: stdout.replaceAll('a3_', 'a1_'), stderr: '', exitCode: 0 } }),
      });
      expect(report.violations[0]).toMatchObject({
        type: 'spice_assertion',
        sheet: '/Power',
        measured: 1.65,
        bound: '3.0 .. 3.1',
      });
    } finally {
      await cleanup();
    }
  });
});

describe('spice config sanitizing', () => {
  async function configWith(spice: unknown): Promise<Awaited<ReturnType<typeof loadConfig>>> {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-spice-cfg-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({ spice }), 'utf8');
      return await loadConfig(repo);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  it.each([
    ['a numeric ngspice', { ngspice: 1 }],
    ['an array', ['ngspice']],
    ['a blank ngspice', { ngspice: '   ' }],
    ['a non-positive timeout', { timeoutMs: 0 }],
    ['a string timeout', { timeoutMs: '5000' }],
    ['an infinite timeout', { timeoutMs: 1e400 }],
  ])('drops %s instead of crashing check --spice', async (_label, spice) => {
    const config = await configWith(spice);
    expect(config.spice).toBeUndefined();
    expect(spiceGateConfig(config)).toEqual({});
  });

  it('keeps the valid half of a partly mistyped block and passes it to the gate', async () => {
    const config = await configWith({ ngspice: ' /opt/ngspice ', timeoutMs: 'soon' });
    expect(config.spice).toEqual({ ngspice: '/opt/ngspice' });
    expect(spiceGateConfig(config)).toEqual({ ngspicePath: '/opt/ngspice' });
    const both = await configWith({ ngspice: '/opt/ngspice', timeoutMs: 9_000 });
    expect(spiceGateConfig(both)).toEqual({ ngspicePath: '/opt/ngspice', timeoutMs: 9_000 });
  });
});

describe.skipIf(!HAS_NGSPICE)('live ngspice (runs only when ngspice is on PATH)', () => {
  async function liveGate(markdown: string, netlist: string) {
    const { repo, cleanup } = await spiceRepo(markdown);
    try {
      resetNgspiceCache();
      return await runSpiceGate({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs/',
        deps: {
          exportNetlist: async () => netlist,
          netsOf: async () => ['VIN', 'VOUT', 'GND'],
          sheetsOf: async () => ['/'],
        },
      });
    } finally {
      await cleanup();
    }
  }

  it('runNgspice measures the fixture divider and matches the captured stdout', async () => {
    const [block] = parseSimulationBlocks(await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8'));
    const deck = assembleSpiceDeck(await readFile(path.join(FIXTURES, 'divider.cir'), 'utf8'), block!);
    const run = await runNgspice(deck.text, 30_000);
    expect(run.exitCode).toBe(0);
    const live = collectGateMeasures(run.stdout, deck.compiled).values;
    const captured = collectGateMeasures(await readFile(path.join(FIXTURES, 'ngspice-pass.txt'), 'utf8'), deck.compiled).values;
    expect(live).toEqual(captured);
    expect(live.a3_0_value).toBeCloseTo(1.65, 6);
  }, 30_000);

  it('passes and fails the op fixtures end to end with a GND-named ground', async () => {
    const divider = await readFile(path.join(FIXTURES, 'divider.cir'), 'utf8');
    const pass = await liveGate(await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8'), divider);
    expect(pass.status).toBe('pass');
    expect(pass.ngspice).toMatch(/^ngspice-\d+/);
    expect(pass.assertions[0]).toMatchObject({ status: 'pass', measured: 1.65 });

    const fail = await liveGate(await readFile(path.join(FIXTURES, 'SUBSYSTEMS-fail.md'), 'utf8'), divider);
    expect(fail.status).toBe('fail');
    expect(fail.violations[0]).toMatchObject({ type: 'spice_assertion', measured: 1.65 });
  }, 30_000);

  it('reads dc at the source value on a nonlinear circuit, and I(R1) through @r1[i]', async () => {
    // 1k into a diode at VIN=5: about 0.7 V; a 0 to 10 V sweep average would be far lower.
    const report = await liveGate(
      `## Simulation
scope: nets VIN, VOUT
analysis: dc
source: VIN=5
assert: V(VOUT) between 0.6 and 0.8
assert: I(R1) between 4m and 4.5m
`,
      'R1 VIN VOUT 1k\nD1 VOUT GND DMOD\n.model DMOD D\n.end\n',
    );
    expect(report.status).toBe('pass');
  }, 30_000);

  it('measures corner() on an RC low-pass with the AC stimulus', async () => {
    const report = await liveGate(
      `## Simulation
scope: nets VIN, VOUT
analysis: ac
source: VIN=0
assert: corner(VOUT) between 1.5k and 1.7k
`,
      'R1 VIN VOUT 10k\nC1 VOUT GND 10n\n.end\n',
    );
    expect(report.status).toBe('pass');
    expect(report.assertions[0]?.measured).toBeGreaterThan(1_500);
  }, 30_000);

  it('reports an undefined subcircuit as unrunnable with the ngspice error', async () => {
    const report = await liveGate(
      await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8'),
      'XU1 VIN VOUT unk_reg\nR2 VOUT GND 10k\n.end\n',
    );
    expect(report.status).toBe('fail');
    expect(report.assertions[0]?.status).toBe('unrunnable');
    expect(report.assertions[0]?.detail).toMatch(/unknown subckt/);
  }, 30_000);
});

describe.skipIf(!HAS_KICAD)('exportSpiceNetlist (runs only when kicad-cli is available)', () => {
  it('exports the open-key fixture with its GND net', async () => {
    const sch = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-key', 'hardware', 'open-key.kicad_sch');
    const netlist = await exportSpiceNetlist(sch);
    expect(netlist).toMatch(/\bGND\b/);
    expect(netlist).toMatch(/^\.end\b/m);
  }, 60_000);
});
