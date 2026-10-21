import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import {
  diffSnapshots,
  formatDiffReport,
  runDiff,
  DiffError,
} from '../src/commands/diff.js';
import { saveConstraint } from '../src/memory/constraints.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('diffSnapshots (normalized electrical comparison)', () => {
  it('ignores formatting-only position/rotation changes and reports zero electrical diff', () => {
    const base = {
      symbols: [
        {
          ref: 'R1',
          value: '10k',
          footprint: 'Resistor_SMD:R_0603',
          libId: 'Device:R',
          sheet: '/',
          at: { x: 10, y: 20, rot: 0 },
          uuid: 'u-1',
          unit: 1,
        },
      ],
      nets: ['VCC', 'GND'],
      pins: [
        { ref: 'R1', pinNumber: '1', pinName: '~', net: 'VCC' },
        { ref: 'R1', pinNumber: '2', pinName: '~', net: 'GND' },
      ],
    };
    const after = {
      symbols: [
        {
          ...base.symbols[0]!,
          at: { x: 85.4, y: 120.2, rot: 90 },
          uuid: 'u-changed',
        },
      ],
      nets: ['GND', 'VCC'],
      pins: [...base.pins],
    };
    const res = diffSnapshots('HEAD~1', 'board.kicad_sch', base, after);
    expect(res.hasChanges).toBe(false);
    expect(formatDiffReport(res)).toBe('No electrical changes since HEAD~1');
  });

  it('summarizes added/modified/removed components, surviving-component connection edits, renamed/merged nets, and affected constraints', () => {
    const before = {
      symbols: [
        {
          ref: 'U1',
          value: 'ESP32',
          footprint: 'Package_QFP:LQFP-48',
          libId: 'MCU:ESP32',
          sheet: '/',
          at: { x: 0, y: 0, rot: 0 },
          uuid: 'u1',
          unit: 1,
        },
        {
          ref: 'J1',
          value: 'Conn_01x02',
          footprint: 'Connector_PinHeader:PinHeader_1x02',
          libId: 'Connector:Conn_01x02',
          sheet: '/',
          at: { x: 0, y: 0, rot: 0 },
          uuid: 'j1',
          unit: 1,
        },
        {
          ref: 'C4',
          value: '100n',
          footprint: 'Capacitor_SMD:C_0402',
          libId: 'Device:C',
          sheet: '/',
          at: { x: 0, y: 0, rot: 0 },
          uuid: 'c4',
          unit: 1,
        },
      ],
      nets: ['KEY_DAH', 'DEBUG_UART', 'GND', 'POWER_IN', '+3V3'],
      pins: [
        { ref: 'U1', pinNumber: '14', pinName: 'GPIO14', net: 'KEY_DAH' },
        { ref: 'U1', pinNumber: '1', pinName: 'GND', net: 'GND' },
        { ref: 'J1', pinNumber: '1', pinName: 'GND', net: 'GND' },
        { ref: 'U1', pinNumber: '2', pinName: 'VIN', net: 'POWER_IN' },
        { ref: 'J1', pinNumber: '2', pinName: 'VBUS', net: 'POWER_IN' },
        { ref: 'C4', pinNumber: '1', pinName: '~', net: '+3V3' },
      ],
    };
    const after = {
      symbols: [
        {
          ref: 'U1',
          value: 'ESP32',
          footprint: 'Package_DFN_QFN:QFN-48',
          libId: 'MCU:ESP32',
          sheet: '/',
          at: { x: 0, y: 0, rot: 0 },
          uuid: 'u1',
          unit: 1,
        },
        {
          ref: 'J1',
          value: 'Conn_01x02',
          footprint: 'Connector_PinHeader:PinHeader_1x02',
          libId: 'Connector:Conn_01x02',
          sheet: '/',
          at: { x: 0, y: 0, rot: 0 },
          uuid: 'j1',
          unit: 1,
        },
        {
          ref: 'R8',
          value: '10k',
          footprint: 'Resistor_SMD:R_0603',
          libId: 'Device:R',
          sheet: '/',
          at: { x: 0, y: 0, rot: 0 },
          uuid: 'r8',
          unit: 1,
        },
      ],
      nets: ['KEY_DASH', 'STATUS_LED', 'GPIO_PULLUP', 'GND', '+3V3'],
      pins: [
        { ref: 'U1', pinNumber: '14', pinName: 'GPIO14', net: 'KEY_DASH' },
        { ref: 'U1', pinNumber: '1', pinName: 'GND', net: 'GND' },
        { ref: 'J1', pinNumber: '1', pinName: 'GND', net: 'GND' },
        { ref: 'U1', pinNumber: '2', pinName: 'VIN', net: 'GND' },
        { ref: 'J1', pinNumber: '2', pinName: 'VBUS', net: 'GND' },
        { ref: 'R8', pinNumber: '1', pinName: '~', net: 'GPIO_PULLUP' },
        // Added component R8 also connects to renamed net KEY_DASH: rename must still be detected!
        { ref: 'R8', pinNumber: '2', pinName: '~', net: 'KEY_DASH' },
      ],
    };
    const constraints = {
      'pins.strapping': {
        source: 'docs/CONSTRAINTS.md',
        affects: ['U1.14', 'KEY_DAH'],
      },
      'pins.unrelated_u1_10': {
        source: 'docs/CONSTRAINTS.md',
        affects: ['U1.10', 'U1.100'],
      },
      'power.rail_3v3': {
        source: 'docs/POWER.md',
        affects: ['+3V3'],
      },
      'power.sleep_current_uA': {
        max: 50,
        source: 'docs/POWER.md',
        affects: ['POWER_IN'],
      },
      'unrelated.clock': {
        source: 'docs/CLOCK.md',
        affects: ['Y1', 'XTAL_IN'],
      },
    };

    const res = diffSnapshots('HEAD~1', 'board.kicad_sch', before, after, constraints);
    expect(res.hasChanges).toBe(true);
    expect(res.components.added).toEqual([
      {
        ref: 'R8',
        value: '10k',
        footprint: 'Resistor_SMD:R_0603',
        libId: 'Device:R',
        nets: ['GPIO_PULLUP', 'KEY_DASH'],
      },
    ]);
    // Added component R8 and removed component C4 must not flood connections.changes
    expect(res.connections.changes.some((c) => c.ref === 'R8' || c.ref === 'C4')).toBe(false);
    expect(res.components.modified).toEqual([
      {
        ref: 'U1',
        changes: [
          {
            field: 'footprint',
            before: 'Package_QFP:LQFP-48',
            after: 'Package_DFN_QFN:QFN-48',
          },
        ],
      },
    ]);
    expect(res.components.removed.map((c) => c.ref)).toEqual(['C4']);
    expect(res.nets.renamed).toEqual([{ from: 'KEY_DAH', to: 'KEY_DASH' }]);
    expect(res.nets.added).toEqual(['GPIO_PULLUP', 'STATUS_LED']);
    expect(res.nets.removed).toEqual(['DEBUG_UART', 'POWER_IN']);
    expect(res.connections.mergedNets).toEqual([{ nets: ['GND', 'POWER_IN'], into: 'GND' }]);
    expect(res.affectedConstraints).toEqual([
      'pins.strapping',
      'power.rail_3v3',
      'power.sleep_current_uA',
    ]);

    const text = formatDiffReport(res);
    expect(text).toContain('Electrical changes since HEAD~1');
    expect(text).toContain('+ R8 10k -> GPIO_PULLUP, KEY_DASH');
    expect(text).toContain('~ U1 footprint changed');
    expect(text).toContain('- C4 removed');
    expect(text).toContain('+ U1.GPIO14 connected to KEY_DASH');
    expect(text).toContain('- U1.GPIO14 disconnected from KEY_DAH');
    expect(text).toContain('! GND and POWER_IN appear to be merged');
    expect(text).toContain('Renamed: KEY_DAH -> KEY_DASH');
    expect(text).toContain('Added: STATUS_LED');
    expect(text).toContain('Removed: DEBUG_UART');
    expect(text).toContain('- pins.strapping');
  });

  it('does not report a false-positive net merge when a single pin is rewired to GND', () => {
    const before = {
      symbols: [
        { ref: 'U1', value: 'MCU', footprint: 'FP', libId: 'L:U', sheet: '/', at: { x: 0, y: 0, rot: 0 }, uuid: '1', unit: 1 },
        { ref: 'R1', value: '10k', footprint: 'FP', libId: 'L:R', sheet: '/', at: { x: 0, y: 0, rot: 0 }, uuid: '2', unit: 1 },
      ],
      nets: ['GND', 'SINGLE_PIN_NET'],
      pins: [
        { ref: 'U1', pinNumber: '1', pinName: 'GND', net: 'GND' },
        { ref: 'R1', pinNumber: '1', pinName: '~', net: 'GND' },
        { ref: 'U1', pinNumber: '2', pinName: 'EN', net: 'SINGLE_PIN_NET' },
      ],
    };
    const after = {
      symbols: before.symbols,
      nets: ['GND'],
      pins: [
        { ref: 'U1', pinNumber: '1', pinName: 'GND', net: 'GND' },
        { ref: 'R1', pinNumber: '1', pinName: '~', net: 'GND' },
        { ref: 'U1', pinNumber: '2', pinName: 'EN', net: 'GND' },
      ],
    };
    const res = diffSnapshots('HEAD~1', 'board.kicad_sch', before, after, {
      'pin.u1_10': { source: 'docs/PINOUT.md', affects: ['U1.10'] },
      'pin.u1_2': { source: 'docs/PINOUT.md', affects: ['U1.2'] },
    });
    expect(res.connections.mergedNets).toEqual([]);
    expect(res.affectedConstraints).toEqual(['pin.u1_2']);
  });
});

describe('runDiff and `copperhead diff` CLI integration', () => {
  it('compares dirty working tree against HEAD and clean post-commit tree against HEAD~1 by default', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, force: false, installHooks: false });
      await saveConstraint(repo, 'supply.decoupling', {
        source: 'docs/POWER.md',
        affects: ['R1'],
      });

      const cleanRes = await runDiff(repo, { base: 'HEAD' });
      expect(cleanRes.hasChanges).toBe(false);

      const schPath = path.join(repo, cleanRes.schematic);
      const raw = await readFile(schPath, 'utf8');
      const edited = raw.replace('(property "Value" "10k"', '(property "Value" "4.7k"');
      await writeFile(schPath, edited, 'utf8');

      // Dirty working tree: default base resolves to HEAD
      const dirtyRes = await runDiff(repo);
      expect(dirtyRes.base).toBe('HEAD');
      expect(dirtyRes.hasChanges).toBe(true);
      expect(dirtyRes.components.modified).toEqual([
        {
          ref: 'R1',
          changes: [{ field: 'value', before: '10k', after: '4.7k' }],
        },
      ]);
      expect(dirtyRes.affectedConstraints).toEqual(['supply.decoupling']);

      const cliJson = await execa(
        'npx',
        ['tsx', 'src/cli.ts', '--repo', repo, '--json', 'diff', '--base', 'HEAD'],
        { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } },
      );
      expect(cliJson.exitCode).toBe(0);
      expect(cliJson.stdout.trim()).toBe(JSON.stringify(dirtyRes, null, 2));

      const cliText = await execa(
        'npx',
        ['tsx', 'src/cli.ts', '--repo', repo, 'diff', '--base', 'HEAD'],
        { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } },
      );
      expect(cliText.exitCode).toBe(0);
      expect(cliText.stdout).toContain('~ R1 value changed (10k -> 4.7k)');
      expect(cliText.stdout).toContain('- supply.decoupling');

      // Commit the schematic edit: now working tree matches HEAD, so default base is HEAD~1
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-m', 'update R1 to 4.7k'], { cwd: repo });
      const postCommitRes = await runDiff(repo);
      expect(postCommitRes.base).toBe('HEAD~1');
      expect(postCommitRes.hasChanges).toBe(true);
      expect(postCommitRes.components.modified[0]?.ref).toBe('R1');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('rejects unknown or flag-like git revisions with DiffError', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, force: false, installHooks: false });
      await expect(runDiff(repo, { base: 'nonexistent-ref-9999' })).rejects.toThrow(DiffError);
      await expect(runDiff(repo, { base: '--output=/tmp/evil' })).rejects.toThrow(DiffError);
      await expect(runDiff(repo, { base: '-q' })).rejects.toThrow(DiffError);
    } finally {
      await cleanup();
    }
  });

  it('rejects historical sub-sheet paths that escape the repository sandbox', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, force: false, installHooks: false });
      const schPath = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const raw = await readFile(schPath, 'utf8');
      const malicious = raw.replace(
        /\)\s*$/,
        '  (sheet (at 0 0) (size 10 10) (property "Sheetfile" "../../outside.kicad_sch" (at 0 0 0)))\n)\n',
      );
      await writeFile(schPath, malicious, 'utf8');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-m', 'subsheet traversal'], { cwd: repo });
      await expect(runDiff(repo, { base: 'HEAD' })).rejects.toThrow(/escapes repository/);
    } finally {
      await cleanup();
    }
  });
});
