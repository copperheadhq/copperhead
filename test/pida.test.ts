import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  evaluatePowerIntegrity,
  extractPowerBudgets,
  formatPowerIntegrity,
  runPowerIntegrity,
  type PidaTelemetry,
} from '../src/kicad/pida.js';
import type { ConstraintRegistry } from '../src/memory/constraints.js';

describe('Ki-PIDA DC power-integrity checker (#176)', () => {
  const sampleRegistry: ConstraintRegistry = {
    'power.rail_drop_max_V': {
      max: 0.15,
      source: 'SPEC.md#power',
      affects: ['board'],
    },
    'power.rails.1V8.drop_max_V': {
      max: 0.05,
      source: 'SPEC.md#1v8-rail',
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

  it('extracts global and per-rail DC power budgets from constraints registry', () => {
    const budgets = extractPowerBudgets(sampleRegistry);
    expect(budgets.railDropMaxV).toBe(0.15);
    expect(budgets.railDropByNetV).toEqual({ '1V8': 0.05 });
    expect(budgets.currentDensityMaxAmm2).toBe(35);
    expect(budgets.tempRiseMaxC).toBe(25);
  });

  it('flags IR drop, current density, thermal hotspots, and broken rail dependencies', () => {
    const budgets = extractPowerBudgets(sampleRegistry);
    const telemetry: PidaTelemetry = {
      rails: [
        { rail: '3V3', sinkRef: 'U4', irDropV: 0.19, x: 42.5, y: 18.0 },
        { rail: '1V8', sinkRef: 'U2', irDropV: 0.048 },
      ],
      currentDensity: [
        { rail: '5V', layer: 'F.Cu', currentDensityAmm2: 41.2, x: 10, y: 12 },
      ],
      thermal: [
        { ref: 'U1', tempRiseC: 31.5, x: 20, y: 22 },
      ],
      dependencies: [
        { rail: '1V8', dependsOn: '3V3', satisfied: false, reason: 'EN pin tied low' },
      ],
    };

    const report = evaluatePowerIntegrity(telemetry, budgets);
    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(4);
    expect(report.warnings).toHaveLength(1);
    expect(report.violations[0]?.description).toContain(
      '3V3 rail - IR drop 0.19V exceeds 0.15V budget at U4 (constraints.json: power.rail_drop_max_V)',
    );

    const formatted = formatPowerIntegrity(report);
    expect(formatted).toContain('power-integrity ✗');
    expect(formatted).toContain('4 violations, 1 warning');
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

  it('runs end-to-end against .copperhead/constraints.json with an injected runner', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-pida-'));
    try {
      await mkdir(path.join(dir, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(dir, '.copperhead', 'constraints.json'),
        JSON.stringify(sampleRegistry, null, 2),
        'utf8',
      );
      const boardPath = path.join(dir, 'board.kicad_pcb');
      await writeFile(boardPath, '(kicad_pcb)\n', 'utf8');

      const clean = await runPowerIntegrity(boardPath, dir, async () => ({
        rails: [{ rail: '3V3', sinkRef: 'U4', irDropV: 0.08 }],
      }));
      expect(clean.ok).toBe(true);
      expect(formatPowerIntegrity(clean)).toBe('power-integrity ✓');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
