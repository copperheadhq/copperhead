import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const execute = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execute }));
import { exportFab, exportSvg, resetKicadCliCache } from '../src/kicad/cli.js';

function mockVersion(major: number): void {
  execute.mockImplementation(async (_bin: string, args: string[]) => ({
    failed: false, exitCode: 0, stdout: args[0] === 'version' ? `${major}.0.5` : '', stderr: '',
  }));
}

beforeEach(() => {
  vi.stubEnv('COPPERHEAD_KICAD_CLI', '');
  resetKicadCliCache();
  execute.mockReset();
  mockVersion(10);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetKicadCliCache();
});

describe('KiCad export arguments match output contracts', () => {
  it.each([8, 9, 10])('uses compatible single-file exports and replaces STEP on KiCad %i', async (major) => {
    mockVersion(major);
    const result = await exportFab('design.kicad_pcb', 'design.kicad_sch', 'outputs');
    expect(result.failed).toEqual([]);
    const calls = execute.mock.calls.map(([, args]) => args as string[]);
    for (const [kind, file] of [['dxf', 'outline.dxf'], ['svg', 'board.svg']]) {
      const args = calls.find((args) => args[0] === 'pcb' && args[2] === kind)!;
      expect(args.includes('--mode-single')).toBe(major >= 9);
      expect(args).toEqual(expect.arrayContaining([
        '--output', path.join('outputs', file!),
      ]));
    }
    expect(calls.find((args) => args[2] === 'step')).toEqual(expect.arrayContaining([
      '--force', '--output', path.join('outputs', 'board.step'),
    ]));
    expect(calls.filter((args) => args[0] === 'version')).toHaveLength(1);
  });

  it.each([8, 9, 10])('standalone board rendering uses compatible file output on KiCad %i', async (major) => {
    mockVersion(major);
    await exportSvg('pcb', 'design.kicad_pcb', 'renders');
    expect(execute).toHaveBeenCalledWith('kicad-cli', [
      'pcb', 'export', 'svg', ...(major >= 9 ? ['--mode-single'] : []), '--output', path.join('renders', 'board.svg'),
      '--layers', 'F.Cu,B.Cu,Edge.Cuts', 'design.kicad_pcb',
    ], { reject: false });
  });

  it('schematic rendering keeps directory output for hierarchical sheets', async () => {
    await exportSvg('sch', 'design.kicad_sch', 'renders');
    expect(execute).toHaveBeenCalledWith('kicad-cli', [
      'sch', 'export', 'svg', '--output', 'renders', 'design.kicad_sch',
    ], { reject: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
