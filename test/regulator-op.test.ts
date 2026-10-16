import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Socket } from 'node:net';
import { execa } from 'execa';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSymbols, pinNets } from '../src/kicad/sexp.js';
import { formatRegulatorOpReport, parseOperatingPoint, regulatorDeck,
  runRegulatorOpCheck, withinVoltageTolerance } from '../src/kicad/regulator-op.js';
import type { ConstraintRegistry } from '../src/memory/constraints.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..',
  'manual-tests', 'reference-boards', 'ldo-demo', 'reference', 'ldo-demo.kicad_sch');
const modelText = `* Test-only DC behavioral model; verifies the integration path, not a vendor part
.subckt TEST_LDO IN GND OUT
BREG OUT GND V=V(IN,GND)-1.7
.ends TEST_LDO
`;
const registry: ConstraintRegistry = {
  'power.3V3.output_voltage_V': { value: 3.3, min: 3.2, max: 3.4,
    source: 'docs/SPEC.md#power', affects: ['U1', '3V3'] },
};

/** Strip the fixture's indicator branch, leaving the original LDO and decoupling. */
function withoutPlacedSymbol(text: string, ref: string): string {
  const marker = `(property "Reference" "${ref}"`;
  const property = text.indexOf(marker, text.indexOf('(lib_symbols') + 1);
  const start = text.lastIndexOf('\n\t(symbol\n\t\t(lib_id ', property);
  if (start < 0) throw new Error(`placed ${ref} missing`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = -1;
  for (let i = start + 2; i < text.length; i++) {
    const c = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (quoted && c === '\\') { escaped = true; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error(`placed ${ref} block unclosed`);
  return text.slice(0, start) + text.slice(end);
}

async function setup(withModel = true): Promise<{ repo: string; schematic: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-spice-test-'));
  const hardware = path.join(repo, 'hardware');
  await mkdir(hardware);
  await mkdir(path.join(repo, 'docs'));
  await mkdir(path.join(repo, '.copperhead'));
  let text = (await readFile(fixture, 'utf8')).replace(/\r\n/g, '\n');
  text = withoutPlacedSymbol(withoutPlacedSymbol(text, 'R1'), 'D1');
  if (withModel) {
    text = text.replace('(lib_id "Regulator_Linear:AP1117-15")',
      '(lib_id "Regulator_Linear:AP1117-15")\n' +
      '\t\t(property "Sim.Library" "regulator.lib")\n' +
      '\t\t(property "Sim.Name" "TEST_LDO")\n' +
      '\t\t(property "Sim.Pins" "1=2 2=3 3=1")');
    await writeFile(path.join(hardware, 'regulator.lib'), modelText);
  }
  const schematic = path.join(hardware, 'ldo-demo.kicad_sch');
  await writeFile(schematic, text);
  await writeFile(path.join(repo, 'docs', 'SUBSYSTEMS.md'),
    '# Subsystems\n\n## Simulation\nscope: nets VIN, 3V3, GND\nanalysis: op\nsource: VIN=5V\nassert: V(3V3) between 3.2 and 3.4\n');
  await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({
    schematic: 'hardware/ldo-demo.kicad_sch', board: null, docs: 'docs/',
  }));
  await writeFile(path.join(repo, '.copperhead', 'constraints.json'), JSON.stringify(registry));
  return { repo, schematic, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('linear regulator DC operating-point check', () => {
  it('translates the existing schematic reader output into one scoped regulator deck', async () => {
    const { repo, schematic, cleanup } = await setup();
    try {
      const [symbols, pins] = await Promise.all([listSymbols(schematic), pinNets(schematic)]);
      const regulator = symbols.find((s) => s.ref === 'U1')!;
      expect(regulator.simulation).toEqual({ library: 'regulator.lib', name: 'TEST_LDO', pins: '1=2 2=3 3=1' });
      expect(pins.filter((p) => p.ref === 'U1').map((p) => [p.pinName, p.net]))
        .toEqual([['GND', 'GND'], ['VO', '3V3'], ['VI', 'VIN']]);
      const deck = regulatorDeck(regulator, pins,
        { library: path.join(repo, 'hardware', 'regulator.lib'), name: 'TEST_LDO', nodes: ['VIN', '0', '3V3'] },
        'VIN', '3V3', 5, symbols);
      expect(deck).toContain('V_COPPERHEAD VIN 0 5');
      expect(deck).toContain('XU1 VIN 0 3V3 TEST_LDO');
      expect(deck).toContain('print v(3V3)');
      expect(deck).not.toContain('C1'); // capacitor is open in a DC operating point
    } finally { await cleanup(); }
  });

  it('compares inclusive tolerance boundaries and rejects non-finite results', () => {
    expect(withinVoltageTolerance(3.2, 3.2, 3.4)).toBe(true);
    expect(withinVoltageTolerance(3.4, 3.2, 3.4)).toBe(true);
    expect(withinVoltageTolerance(3.19, 3.2, 3.4)).toBe(false);
    expect(withinVoltageTolerance(3.41, 3.2, 3.4)).toBe(false);
    expect(withinVoltageTolerance(NaN, 3.2, 3.4)).toBe(false);
    expect(parseOperatingPoint('v(3v3) = 3.300000e+00', '3V3')).toBe(3.3);
  });

  it('reports a measured pass/failure in text and the stable JSON fields', async () => {
    const { repo, schematic, cleanup } = await setup();
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        throw new Error('network access attempted');
      });
      const socketSpy = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
        throw new Error('network socket attempted');
      });
      const execute = vi.fn(async (_binary: string, args: string[]) => {
        expect(args[0]).toBe('-b');
        expect(await readFile(args[1]!, 'utf8')).toContain('XU1 VIN 0 3V3 TEST_LDO');
        return { exitCode: 0, stdout: 'v(3v3) = 3.300000e+00', stderr: '' };
      });
      try {
        const passed = await runRegulatorOpCheck(repo, schematic, 'docs', registry, { execute });
        expect(passed.ok).toBe(true);
        expect(passed.circuits[0]).toMatchObject({ ref: 'U1', output: '3V3', status: 'pass',
          measured: 3.3, target: 3.3, min: 3.2, max: 3.4 });
        expect(formatRegulatorOpReport(passed)).toMatch(/SPICE U1 \(3V3\): PASS — 3.3 V; target 3.3 V, tolerance 3.2–3.4 V/);
        expect(JSON.parse(JSON.stringify(passed)).circuits[0].measured).toBe(3.3);
        const failed = await runRegulatorOpCheck(repo, schematic, 'docs', registry, {
          execute: async () => ({ exitCode: 0, stdout: 'v(3v3) = 3.1', stderr: '' }),
        });
        expect(failed.circuits[0]).toMatchObject({ status: 'fail', reason: 'out_of_tolerance', measured: 3.1 });
        expect(formatRegulatorOpReport(failed)).toContain('FAIL — 3.1 V');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(socketSpy).not.toHaveBeenCalled();
      } finally { fetchSpy.mockRestore(); socketSpy.mockRestore(); }
    } finally { await cleanup(); }
  });

  it('reports missing binary, non-convergence, missing model, and no constraint explicitly', async () => {
    const { repo, schematic, cleanup } = await setup();
    try {
      const missing = await runRegulatorOpCheck(repo, schematic, 'docs', registry, {
        execute: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      });
      expect(missing.circuits[0]).toMatchObject({ status: 'fail', reason: 'missing_ngspice' });
      const convergence = await runRegulatorOpCheck(repo, schematic, 'docs', registry, {
        execute: async () => ({ exitCode: 1, stdout: '', stderr: 'singular matrix: no convergence' }),
      });
      expect(convergence.circuits[0]).toMatchObject({ status: 'fail', reason: 'non_convergence' });
      const absent = await runRegulatorOpCheck(repo, schematic, 'docs', {}, {
        execute: async () => { throw new Error('simulator should not run'); },
      });
      expect(absent.circuits[0]).toMatchObject({ status: 'not_checked', reason: 'undeclared' });
      expect(formatRegulatorOpReport(absent)).toContain('not checked');
      await rm(path.join(repo, 'hardware', 'regulator.lib'));
      const noModel = await runRegulatorOpCheck(repo, schematic, 'docs', registry);
      expect(noModel.circuits[0]).toMatchObject({ status: 'fail', reason: 'missing_model' });
      await writeFile(path.join(repo, 'hardware', 'regulator.lib'), '.subckt OTHER IN GND OUT\n.ends OTHER\n');
      const unusableModel = await runRegulatorOpCheck(repo, schematic, 'docs', registry);
      expect(unusableModel.circuits[0]).toMatchObject({ status: 'fail', reason: 'missing_model' });
      expect(unusableModel.circuits[0]?.detail).toContain('subcircuit TEST_LDO is absent');
    } finally { await cleanup(); }
  });

  it('does not count a modeled but unmeasured run as a pass', async () => {
    const { repo, schematic, cleanup } = await setup();
    try {
      const result = await runRegulatorOpCheck(repo, schematic, 'docs', registry, {
        execute: async () => ({ exitCode: 0, stdout: 'No. of Data Rows : 0', stderr: '' }),
      });
      expect(result.circuits[0]).toMatchObject({ status: 'fail', reason: 'simulation_failed' });
    } finally { await cleanup(); }
  });
});

const ngspiceInstalled = spawnSync('ngspice', ['--version'], { timeout: 3000 }).error === undefined;
describe.skipIf(ngspiceInstalled)('ngspice missing executable', () => {
  it('reports an actionable missing-binary failure from the real subprocess path', async () => {
    const { repo, schematic, cleanup } = await setup();
    try {
      const result = await runRegulatorOpCheck(repo, schematic, 'docs', registry);
      expect(result.circuits[0]).toMatchObject({ status: 'fail', reason: 'missing_ngspice' });
      expect(result.circuits[0]?.detail).toContain('install ngspice');
    } finally { await cleanup(); }
  });
});
describe.skipIf(!ngspiceInstalled)('ngspice integration', () => {
  it('runs the local ngspice binary on the modeled regulator fixture', async () => {
    const { repo, schematic, cleanup } = await setup();
    try {
      const result = await runRegulatorOpCheck(repo, schematic, 'docs', registry);
      expect(result.circuits[0]).toMatchObject({ status: 'pass', measured: expect.closeTo(3.3, 2) });
    } finally { await cleanup(); }
  });
});

const kicadInstalled = spawnSync('kicad-cli', ['version'], { timeout: 3000 }).error === undefined;
describe.skipIf(!kicadInstalled)('check --spice CLI', () => {
  it('includes a failed subcheck in --json', async () => {
    const { repo, cleanup } = await setup(false);
    try {
      const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
      const tsx = path.join(path.dirname(fileURLToPath(import.meta.url)), '..',
        'node_modules', 'tsx', 'dist', 'cli.mjs');
      const output = await execa(process.execPath,
        [tsx, cli, '--repo', repo, '--json', 'check', '--spice'], { reject: false, timeout: 90_000 });
      expect(output.exitCode).toBe(1);
      expect(JSON.parse(output.stdout).spice.circuits[0]).toMatchObject({
        ref: 'U1', status: 'fail', reason: 'missing_model', target: 3.3, min: 3.2, max: 3.4,
      });
    } finally { await cleanup(); }
  }, 120_000);
});
