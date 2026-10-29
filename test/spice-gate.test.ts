import { describe, expect, it, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { loadConfig } from '../src/config.js';
import { runCheck, spiceGateFailsCheck } from '../src/commands/check.js';
import {
  NgspiceBadOverrideError,
  NgspiceMissingError,
  formatSpiceGate,
  resetNgspiceCache,
  resolveNgspice,
  runSpiceGate,
  spiceScopeProblems,
  type SpiceGateDeps,
  type SpiceRunResult,
} from '../src/kicad/spice-run.js';
import { parseSimulationBlocks } from '../src/kicad/spice.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'spice');
const silent = (): void => {};

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
    expect(spiceGateFailsCheck({ status: 'idle', blocks: 0, assertions: [], errors: [] }, true)).toBe(false);
    expect(spiceGateFailsCheck({ status: 'pass', blocks: 1, assertions: [], errors: [] }, true)).toBe(false);
    expect(spiceGateFailsCheck({ status: 'skip', blocks: 1, assertions: [], errors: [] }, false)).toBe(false);
    expect(spiceGateFailsCheck({ status: 'skip', blocks: 1, assertions: [], errors: [] }, true)).toBe(true);
    expect(spiceGateFailsCheck({ status: 'fail', blocks: 1, assertions: [], errors: ['x'] }, false)).toBe(true);
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
    expect(formatSpiceGate({ status: 'idle', blocks: 0, assertions: [], errors: [] })).toEqual([
      'SPICE skipped (no ## Simulation blocks)',
    ]);
    expect(
      formatSpiceGate({
        status: 'skip',
        blocks: 1,
        assertions: [],
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
        errors: [],
      }),
    ).toEqual(['SPICE ✓ 1 assertion(s)', '  ✓ V(OUT) > 1: measured 1.65']);
    expect(
      formatSpiceGate({
        status: 'fail',
        blocks: 1,
        assertions: [],
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
      expect(report.assertions[0]?.detail).toMatch(/Unable to find definition of model unk_reg/);
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
