import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from '../src/commands/check.js';
import {
  createCheckerRegistry,
  defaultCheckerRegistry,
  formatCheckerReport,
  runChecker,
  type VerificationChecker,
} from '../src/kicad/checkers.js';
import {
  defaultPidaRunner,
  evaluatePowerIntegrity,
  extractPowerBudgets,
  formatPowerIntegrity,
  PidaMissingError,
  PidaToolError,
  powerIntegrityChecker,
  runPowerIntegrity,
  validatePidaTelemetry,
  type PidaTelemetry,
} from '../src/kicad/pida.js';
import type { ConstraintRegistry } from '../src/memory/constraints.js';

const SAMPLE_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'pida',
  'sample-telemetry.json',
);

describe('External verification checker framework & Ki-PIDA plugin (#176)', () => {
  const sampleRegistry: ConstraintRegistry = {
    'power.rail_drop_max_V': {
      max: 0.15,
      source: 'SPEC.md#power',
      affects: ['board'],
    },
    'power.rails.1V8.drop_max_V': {
      value: 0.05,
      source: 'SPEC.md#1v8-rail',
      affects: ['board'],
    },
    'power.rails./power/3V3.drop_max_V': {
      value: '0.05',
      source: 'SPEC.md#hier-3v3-rail',
      affects: ['board'],
    },
    'power.current_density_max_A_mm2': {
      max: 35,
      source: 'SPEC.md#copper',
      affects: ['board'],
    },
    'power.temp_rise_max_C': {
      max: 25,
      source: 'SPEC.md#thermal',
      affects: ['board'],
    },
  };

  it('registers power-integrity in defaultCheckerRegistry, checks missing artifacts, and formats ok-with-warnings', async () => {
    expect(defaultCheckerRegistry.get('power-integrity')).toBe(powerIntegrityChecker);
    await expect(
      runChecker(powerIntegrityChecker, '/nonexistent/board.kicad_pcb', '/nonexistent'),
    ).rejects.toThrow(/board file not found/);

    const reg = createCheckerRegistry();
    const dummyEmcChecker: VerificationChecker<{ peakDbUvM: number }, { limitDbUvM: number }, 'openems'> = {
      id: 'openems',
      artifact: 'board',
      extractBudgets: (r) => ({ limitDbUvM: r['emc.limit_dBuV_m']?.max ?? 40 }),
      defaultRunner: async () => ({ peakDbUvM: 0 }),
      evaluate: (t, b) => ({
        violations:
          t.peakDbUvM > b.limitDbUvM
            ? [
                {
                  severity: 'error',
                  type: 'emc_limit_exceeded',
                  description: `radiated emission ${t.peakDbUvM} dBuV/m exceeds ${b.limitDbUvM} dBuV/m`,
                  items: [],
                },
              ]
            : [],
      }),
    };
    reg.register(dummyEmcChecker);
    expect(reg.list()).toEqual(['openems']);
    expect(() => reg.register(dummyEmcChecker)).toThrow(/already registered/);
    await expect(reg.run('unknown', '/nonexistent', '/nonexistent')).rejects.toThrow(/unknown verification checker/);

    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-checker-fw-'));
    try {
      await mkdir(path.join(dir, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(dir, '.copperhead', 'constraints.json'),
        JSON.stringify({ 'emc.limit_dBuV_m': { max: 37, source: 'CISPR-32', affects: ['board'] } }),
        'utf8',
      );
      const boardPath = path.join(dir, 'board.kicad_pcb');
      await writeFile(boardPath, '(kicad_pcb)\n', 'utf8');

      const failReport = await reg.run('openems', boardPath, dir, async () => ({ peakDbUvM: 42 }));
      expect(failReport.ok).toBe(false);
      expect(formatCheckerReport(failReport)).toContain('openems ✗');
      expect(formatCheckerReport(failReport)).toContain('1 violation, 0 warnings');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on empty, null, snake_case, string-number, or non-array telemetry', () => {
    const budgets = extractPowerBudgets(sampleRegistry);
    expect(() => evaluatePowerIntegrity({} as PidaTelemetry, budgets)).toThrow(PidaToolError);
    expect(() => validatePidaTelemetry(null)).toThrow(PidaToolError);
    expect(() => validatePidaTelemetry({ rails: {} })).toThrow(PidaToolError);
    expect(() =>
      validatePidaTelemetry({ rails: [{ rail: '3V3', sink_ref: 'U4', ir_drop_v: 0.5 }] }),
    ).toThrow(PidaToolError);
    expect(() =>
      validatePidaTelemetry({ rails: [{ rail: '3V3', sinkRef: 'U4', irDropV: '0.19' }] }),
    ).toThrow(PidaToolError);
  });

  it('extracts numeric/string value budgets and hierarchical /-prefixed rail keys, and warns on malformed rail keys or missing budgets', async () => {
    const budgets = extractPowerBudgets({
      ...sampleRegistry,
      'power.rails.bad_suffix': { max: 0.1, source: 'SPEC.md', affects: ['board'] },
    });
    expect(budgets.railDropMaxV).toBe(0.15);
    expect(budgets.railDropByNetV).toEqual({ '1V8': 0.05, '/power/3V3': 0.05 });
    expect(budgets.unparsedRailKeys).toEqual(['power.rails.bad_suffix']);

    const fixtureJson = JSON.parse(await readFile(SAMPLE_FIXTURE, 'utf8')) as PidaTelemetry;
    const okWithWarn = evaluatePowerIntegrity(fixtureJson, budgets);
    expect(okWithWarn.ok).toBe(true);
    expect(okWithWarn.warnings.length).toBeGreaterThanOrEqual(2);
    expect(formatPowerIntegrity(okWithWarn)).toContain('power-integrity ✓');

    // Hierarchical /power/3V3 exceeding its 0.05V per-rail budget (0.12V < 0.15V global) fails
    const hierFail = evaluatePowerIntegrity(
      { rails: [{ rail: '/power/3V3', sinkRef: 'U4', irDropV: 0.12 }] },
      budgets,
    );
    expect(hierFail.ok).toBe(false);
    expect(hierFail.violations[0]?.description).toContain('power.rails./power/3V3.drop_max_V');

    // Empty budget registry emits explicit power_budget_missing warnings instead of silent pass
    const noBudgets = extractPowerBudgets({});
    const unbudgeted = evaluatePowerIntegrity(
      {
        rails: [{ rail: '3V3', sinkRef: 'U1', irDropV: 0.4 }],
        currentDensity: [{ rail: '3V3', layer: 'F.Cu', currentDensityAmm2: 80 }],
        thermal: [{ ref: 'U1', tempRiseC: 90 }],
      },
      noBudgets,
    );
    expect(unbudgeted.warnings).toHaveLength(3);
    expect(formatPowerIntegrity(unbudgeted)).toContain('no power.temp_rise_max_C budget configured');
  });

  it('formats near-threshold violations with enough precision so measured != budget in messages', () => {
    const budgets = extractPowerBudgets(sampleRegistry);
    const report = evaluatePowerIntegrity(
      {
        rails: [
          { rail: '3V3', sinkRef: 'U4', irDropV: 0.151 },
          { rail: '1V8', sinkRef: 'U2', irDropV: 0.048 },
        ],
        currentDensity: [{ rail: '5V', layer: 'F.Cu', currentDensityAmm2: 35.04 }],
        thermal: [{ ref: 'U1', tempRiseC: 25.04 }],
        dependencies: [{ rail: '1V8', dependsOn: '3V3', satisfied: false, reason: 'EN pin tied low' }],
      },
      budgets,
    );
    expect(report.ok).toBe(false);
    expect(report.violations[0]?.description).toContain('0.151V exceeds 0.15V budget');
    expect(report.warnings[0]?.description).toContain('0.048V is within 10% of 0.05V budget');
    expect(report.violations[1]?.description).toContain('35.04A/mm2 exceeds 35.0A/mm2 budget');
    expect(report.violations[2]?.description).toContain('25.04C exceeds 25.0C budget');
  });

  it('never prints a budget at a precision that changes it (round-trip rule)', () => {
    // Regression: a 0.155V budget used to print as "0.15V budget", naming a
    // limit the user never set and contradicting constraints.json.
    const budgets = extractPowerBudgets({
      'power.rail_drop_max_V': { max: 0.155, source: 'SPEC.md#power', affects: ['board'] },
      'power.temp_rise_max_C': { max: 22.25, source: 'SPEC.md#power', affects: ['board'] },
    });
    const report = evaluatePowerIntegrity(
      {
        rails: [{ rail: '3V3', sinkRef: 'U4', irDropV: 0.2 }],
        thermal: [{ ref: 'U1', tempRiseC: 40 }],
      },
      budgets,
    );
    const irDrop = report.violations.find((v) => v.type === 'ir_drop_exceeded');
    const thermal = report.violations.find((v) => v.type === 'thermal_hotspot');
    expect(irDrop?.description).toContain('0.155V budget');
    expect(irDrop?.description).not.toContain('0.15V budget');
    expect(thermal?.description).toContain('22.25C budget');
    expect(thermal?.description).not.toContain('22.3C budget');
  });

  it('detects circular multi-rail dependency chains', () => {
    const budgets = extractPowerBudgets(sampleRegistry);
    const report = evaluatePowerIntegrity(
      {
        dependencies: [
          { rail: '3V3', dependsOn: '1V8', satisfied: true },
          { rail: '1V8', dependsOn: '3V3', satisfied: true },
        ],
      },
      budgets,
    );
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.type === 'rail_dependency_cycle')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'exercises defaultPidaRunner subprocess (valid JSON, empty stdout, bad JSON, non-zero exit, timeout, missing binary) and runCheck --power',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-pida-bin-'));
      const savedBin = process.env.COPPERHEAD_KIPIDA_BIN;
      try {
        await mkdir(path.join(dir, '.copperhead'), { recursive: true });
        await mkdir(path.join(dir, 'docs'), { recursive: true });
        const boardPath = path.join(dir, 'board.kicad_pcb');
        await writeFile(boardPath, '(kicad_pcb)\n', 'utf8');
        await writeFile(
          path.join(dir, '.copperhead', 'config.json'),
          JSON.stringify({ docs: 'docs/' }, null, 2),
          'utf8',
        );
        await writeFile(
          path.join(dir, '.copperhead', 'constraints.json'),
          JSON.stringify(sampleRegistry, null, 2),
          'utf8',
        );

        const fixtureText = await readFile(SAMPLE_FIXTURE, 'utf8');
        const scriptPath = path.join(dir, 'fake-kipida.mjs');

        // 1. Valid JSON subprocess
        await writeFile(
          scriptPath,
          `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(fixtureText)});\n`,
          'utf8',
        );
        await chmod(scriptPath, 0o755);
        process.env.COPPERHEAD_KIPIDA_BIN = scriptPath;
        const okTelemetry = await defaultPidaRunner(boardPath);
        expect(okTelemetry.rails).toHaveLength(2);

        // 2. Empty stdout
        await writeFile(scriptPath, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
        await expect(defaultPidaRunner(boardPath)).rejects.toThrow(/empty stdout/);

        // 3. Invalid JSON
        await writeFile(scriptPath, '#!/usr/bin/env node\nprocess.stdout.write("not-json");\n', 'utf8');
        await expect(defaultPidaRunner(boardPath)).rejects.toThrow(/invalid JSON/);

        // 4. Non-zero exit
        await writeFile(scriptPath, '#!/usr/bin/env node\nprocess.stderr.write("solver failed");\nprocess.exit(2);\n', 'utf8');
        await expect(defaultPidaRunner(boardPath)).rejects.toThrow(/solver failed/);

        // 5. Timeout
        await writeFile(scriptPath, '#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n', 'utf8');
        await expect(defaultPidaRunner(boardPath, { timeoutMs: 120 })).rejects.toThrow(/timed out/);

        // 6. A solver KILLED BY A SIGNAL must fail closed.
        //    execa reports `exitCode === undefined` both when a binary cannot
        //    be spawned and when it is terminated by a signal. Treating the
        //    two alike made a segfaulting / OOM-killed solver read as "ki-pida
        //    not installed", so `check --power` skipped the gate and exited 0
        //    - the fail-open this gate exists to prevent.
        await writeFile(
          scriptPath,
          '#!/usr/bin/env node\nprocess.kill(process.pid, "SIGKILL");\n',
          'utf8',
        );
        await expect(defaultPidaRunner(boardPath)).rejects.toThrow(PidaToolError);
        await expect(defaultPidaRunner(boardPath)).rejects.toThrow(/terminated by SIGKILL/);
        // and it must NOT be reported as a merely-missing tool
        await expect(defaultPidaRunner(boardPath)).rejects.not.toThrow(PidaMissingError);

        // 6b. A crashing runner must propagate through runPowerIntegrity.
        //     `check.ts` only converts PidaMissingError into a skip, so a
        //     signal-killed solver has to arrive as PidaToolError or the gate
        //     silently passes. (Exercised at runPowerIntegrity rather than
        //     runCheck because runCheck would also run DRC, which needs
        //     kicad-cli on the host.)
        const crashRunner = async (): Promise<PidaTelemetry> => {
          throw new PidaToolError('ki-pida terminated by SIGKILL');
        };
        await expect(
          runPowerIntegrity(boardPath, dir, crashRunner),
        ).rejects.toThrow(/terminated by SIGKILL/);
        await expect(
          runPowerIntegrity(boardPath, dir, crashRunner),
        ).rejects.toThrow(PidaToolError);

        // 7. Pinned-but-missing COPPERHEAD_KIPIDA_BIN is a configuration error,
        //    not an absent optional tool: it must name the path and must never
        //    let the gate report itself as skipped.
        const pinnedMissing = path.join(dir, 'does-not-exist-kipida');
        process.env.COPPERHEAD_KIPIDA_BIN = pinnedMissing;
        await expect(defaultPidaRunner(boardPath)).rejects.toThrow(PidaToolError);
        await expect(defaultPidaRunner(boardPath)).rejects.toThrow(pinnedMissing);
        await expect(defaultPidaRunner(boardPath)).rejects.not.toThrow(PidaMissingError);

        // 8. Unpinned missing binary: still the documented skip path.
        delete process.env.COPPERHEAD_KIPIDA_BIN;
        await expect(defaultPidaRunner(boardPath)).rejects.toThrow(PidaMissingError);

        await writeFile(
          path.join(dir, '.copperhead', 'config.json'),
          JSON.stringify({ docs: 'docs/', board: 'board.kicad_pcb' }, null, 2),
          'utf8',
        );
        // Note: runCheck runs runDrc when config.board is set unless we test no-board skip or mock DRC;
        // first verify no-board skip vs strictPower:
        await writeFile(
          path.join(dir, '.copperhead', 'config.json'),
          JSON.stringify({ docs: 'docs/' }, null, 2),
          'utf8',
        );
        const skipNoBoard = await runCheck(dir, () => {}, { power: true });
        expect(skipNoBoard.ok).toBe(true);
        expect(skipNoBoard.power).toMatchObject({ skipped: true });

        const strictNoBoard = await runCheck(dir, () => {}, { power: true, strictPower: true });
        expect(strictNoBoard.ok).toBe(false);
      } finally {
        if (savedBin === undefined) delete process.env.COPPERHEAD_KIPIDA_BIN;
        else process.env.COPPERHEAD_KIPIDA_BIN = savedBin;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
