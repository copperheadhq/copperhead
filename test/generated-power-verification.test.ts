import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runErc } from '../src/kicad/cli.js';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import type { SchematicIntent } from '../src/kicad/draft/ir.js';
import { powerNetToken, powerSymbolSource, pwrFlagSource, SymbolSource } from '../src/kicad/draft/symsource.js';
import { renameSymbolBlock } from '../src/kicad/emit.js';
import { child, children, parseSexp, pinNets } from '../src/kicad/sexp.js';
import { verifySchematicSymbols } from '../src/kicad/symlib.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SYMBOLS = path.join(FIXTURES, 'symlib');
type Source = { libId: string; sourceText: string };

// Independent installed-library fixtures: generated definitions must not be
// mistaken for nearby stock names, and ordinary power:* still uses its library.
const STOCK_POWER = ['GND', '+5V', 'VBUS', 'PWR_FLAG'].map((name) => `(symbol "${name}"
  (power)
  (property "Value" "${name}")
  (symbol "${name}_1_1"
    (pin ${name === 'PWR_FLAG' ? 'power_out' : 'power_in'} line (at 0 0 90) (length 0)
      (name "${name === 'PWR_FLAG' ? 'pwr' : name}") (number "1"))))`);

const embedded = ({ libId, sourceText }: Source): string => renameSymbolBlock(sourceText, libId);
const schematic = (blocks: string[]): string => `(kicad_sch (version 20250114) (generator test)
  (lib_symbols ${blocks.join('\n')}))\n`;
const appendBody = (source: string, body: string): string => `${source.slice(0, -1)}${body}\n)`;

describe('verification of engine-generated power symbols', () => {
  let repo: string;
  let libraries: string;
  let schPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'copperhead-generated-power-'));
    libraries = path.join(repo, 'installed-symbols');
    await mkdir(libraries);
    await writeFile(path.join(libraries, 'power.kicad_sym'),
      `(kicad_symbol_lib (version 20231120) (generator test) ${STOCK_POWER.join('\n')})\n`);
    schPath = path.join(repo, 'board.kicad_sch');
    env = { KICAD_SYMBOL_DIR: libraries };
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function verifyBlocks(blocks: string[]) {
    await writeFile(schPath, schematic(blocks));
    return verifySchematicSymbols(schPath, env);
  }

  it.each([
    ['VBUS_RAW', 'rail', 'VBUS_RAW'],
    ['+5V_PROTECTED', 'rail', '+5V_PROTECTED'],
    ['GND', 'ground', 'GND'],
    ['AGND/chassis', 'ground', 'AGND_chassis'],
    ['ANA/+3.3 V', 'rail', 'ANA_+3.3_V'],
    ['-12.0V_AUX', 'rail', '-12.0V_AUX'],
  ] as const)('checks generated %s (%s), retaining its exact net name', async (net, kind, token) => {
    const source = powerSymbolSource(net, kind);
    expect(powerNetToken(net)).toBe(token);
    expect(source.libId).toBe(`copperhead_power:${token}`);
    const definition = parseSexp(source.sourceText)[0]!;
    expect(children(definition, 'property').find((p) => p[1] === 'Value')?.[2]).toBe(net);
    const pin = child(children(definition, 'symbol')[1]!, 'pin')!;
    expect(child(pin, 'name')?.[1]).toBe(net);
    expect(await verifyBlocks([embedded(source)])).toEqual({ findings: [], checked: 1, skipped: 0 });
  });

  it('checks PWR_FLAG and generated ports without any installed power library', async () => {
    await rm(path.join(libraries, 'power.kicad_sym'));
    expect(await verifyBlocks([
      embedded(pwrFlagSource()),
      embedded(powerSymbolSource('GND', 'ground')),
      embedded(powerSymbolSource('VBUS_RAW', 'rail')),
    ])).toEqual({ findings: [], checked: 3, skipped: 0 });
  });

  it('accepts whitespace-only differences without rewriting schematic bytes', async () => {
    const source = embedded(powerSymbolSource('VBUS_RAW', 'rail')).replace(/\n/g, '\r\n').replace(/\t/g, '    ');
    await writeFile(schPath, schematic([source]));
    const before = await readFile(schPath);
    expect(await verifySchematicSymbols(schPath, env)).toEqual({ findings: [], checked: 1, skipped: 0 });
    expect(await readFile(schPath)).toEqual(before);
  });

  it('preserves the pre-fix emitted bytes for rail, ground, sanitized names, and PWR_FLAG', () => {
    // Captured before moving the existing templates into their shared module.
    const sources: [Source, string][] = [
      [powerSymbolSource('VBUS_RAW', 'rail'), '20fa84d22c3c5b53e9b79e902ab6a8d10856f1e892cf7c205b5eac0641bc080f'],
      [powerSymbolSource('+5V_PROTECTED', 'rail'), '6c0cbcd477e2dab394cfacaf3f062c4ae088d115a79cbde4ec578112fc6ef6b8'],
      [powerSymbolSource('GND', 'ground'), '84a04f4809854d4b99ce787e91970598b4a294cf62e097884faa26a6f78f690e'],
      [powerSymbolSource('ANA/+3.3 V', 'rail'), 'b2c1085892f9cdadbceae049f2137b719de2c4b614533473be8a90eceac78b36'],
      [pwrFlagSource(), '2c8da71ac351af7229aeab0daf2394ad824bf032b1a0d16f2ae37760a1e5e09f'],
    ];
    for (const [source, expected] of sources) {
      expect(createHash('sha256').update(source.sourceText).digest('hex'), source.libId).toBe(expected);
    }
  });

  const mutations: [string, (source: string) => string][] = [
    ['pin type', (s) => s.replace('(pin power_in line', '(pin output line')],
    ['pin name', (s) => s.replace('(name "VBUS_RAW"', '(name "VCC"')],
    ['pin number', (s) => s.replace('(number "1"', '(number "2"')],
    ['pin location', (s) => s.replace('(at 0 0 90) (length 0)', '(at 2.54 0 90) (length 0)')],
    ['missing pin', (s) => s.replace(/\n\t\(symbol "VBUS_RAW_1_1"[\s\S]*\n\t\)\n\)$/, '\n)')],
    ['extra pin', (s) => appendBody(s, '(symbol "VBUS_RAW_2_1" (pin input line (at 2.54 0 0) (length 0) (name "GPIO") (number "2")))')],
    ['missing power marker', (s) => s.replace('\n\t(power)', '')],
    ['BOM metadata', (s) => s.replace('(in_bom no)', '(in_bom yes)')],
    ['board metadata', (s) => s.replace('(on_board no)', '(on_board yes)')],
    ['simulation metadata', (s) => s.replace('(exclude_from_sim yes)', '(exclude_from_sim no)')],
    ['reference metadata', (s) => s.replace('"Reference" "#PWR"', '"Reference" "U"')],
    ['value', (s) => s.replace('"Value" "VBUS_RAW"', '"Value" "VCC"')],
    ['unit name', (s) => s.replace('"VBUS_RAW_1_1"', '"MCU_1_1"')],
    ['extra MCU-like body', (s) => appendBody(s, '(symbol "VBUS_RAW_3_1" (rectangle (start -10 -10) (end 10 10)))')],
    ['extra property', (s) => appendBody(s, '(property "Footprint" "Package_QFP:LQFP-64")')],
  ];

  it.each(mutations)('rejects a generated rail with changed %s', async (_label, mutate) => {
    const source = powerSymbolSource('VBUS_RAW', 'rail');
    const clean = embedded(source);
    const counterfeit = mutate(clean);
    expect(counterfeit).not.toBe(clean);
    const result = await verifyBlocks([counterfeit]);
    expect(result).toMatchObject({ checked: 0, skipped: 0 });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ libId: source.libId, kind: 'generated-symbol' });
    expect(result.findings[0]!.detail).toBeTruthy();
  });

  it('rejects a mismatched lib_id even when its pins and metadata are genuine', async () => {
    const source = powerSymbolSource('VBUS_RAW', 'rail');
    const counterfeit = embedded(source).replace('"copperhead_power:VBUS_RAW"', '"copperhead_power:VCC"');
    const result = await verifyBlocks([counterfeit]);
    expect(result).toMatchObject({ checked: 0, skipped: 0 });
    expect(result.findings).toEqual([expect.objectContaining({ libId: 'copperhead_power:VCC', kind: 'generated-symbol' })]);
  });

  it('rejects a renamed arbitrary MCU under the reserved prefix', async () => {
    const mcu = await new SymbolSource(repo, [SYMBOLS], false).resolve('CopperMCU:MCU8');
    const result = await verifyBlocks([renameSymbolBlock(mcu.sourceText, 'copperhead_power:MCU8')]);
    expect(result).toMatchObject({ checked: 0, skipped: 0 });
    expect(result.findings).toEqual([expect.objectContaining({ libId: 'copperhead_power:MCU8', kind: 'generated-symbol' })]);
  });

  it('rejects changed PWR_FLAG pin type and forged rail definitions using its reserved name', async () => {
    const source = pwrFlagSource();
    const badFlag = embedded(source).replace('(pin power_out line', '(pin power_in line');
    const result = await verifyBlocks([badFlag]);
    expect(result.findings).toEqual([expect.objectContaining({ libId: source.libId, kind: 'generated-symbol' })]);
    expect(result.checked).toBe(0);
    const railResult = await verifyBlocks([embedded(powerSymbolSource('PWR_FLAG', 'rail'))]);
    expect(railResult.findings).toEqual([expect.objectContaining({ libId: source.libId, kind: 'generated-symbol' })]);
    expect(railResult.checked).toBe(0);
  });

  it('continues checking canonical power:* symbols against the installed library', async () => {
    const blocks = STOCK_POWER.map((source, i) => renameSymbolBlock(source, `power:${['GND', '+5V', 'VBUS', 'PWR_FLAG'][i]}`));
    expect(await verifyBlocks(blocks)).toEqual({ findings: [], checked: 4, skipped: 0 });
    const result = await verifyBlocks([blocks[0]!.replace('(pin power_in line', '(pin output line')]);
    expect(result).toMatchObject({ checked: 1, skipped: 0 });
    expect(result.findings).toEqual([expect.objectContaining({ libId: 'power:GND', kind: 'pin-mismatch' })]);
  });

  it('still reports ordinary symbol drift beside a genuine generated rail', async () => {
    const resistor = await new SymbolSource(repo, [SYMBOLS], false).resolve('Device:R');
    await writeFile(schPath, schematic([
      embedded(powerSymbolSource('VBUS_RAW', 'rail')),
      embedded(resistor).replace('(pin passive line', '(pin output line'),
    ]));
    const result = await verifySchematicSymbols(schPath, { KICAD_SYMBOL_DIR: SYMBOLS });
    expect(result).toMatchObject({ checked: 2, skipped: 0 });
    expect(result.findings).toEqual([expect.objectContaining({ libId: 'Device:R', kind: 'pin-mismatch' })]);
  });

  it('drafts and really ERC-checks distinct raw/protected rails, with read-only verification and stable bytes', async () => {
    const intent: SchematicIntent = JSON.parse(await readFile(path.join(FIXTURES, 'draft', 'schematic.intent.json'), 'utf8'));
    intent.parts.push({ ref: 'R3', libId: 'Device:R', value: '0', footprint: 'Resistor_SMD:R_0603_1608Metric', group: 'Power' });
    const originalSupply = intent.nets.find((n) => n.name === 'VCC')!;
    originalSupply.name = 'VBUS_RAW';
    originalSupply.kind = 'power';
    originalSupply.pins = ['J1.1', 'R3.1'];
    intent.nets.push({ name: '+5V_PROTECTED', kind: 'power', pins: ['R3.2', 'U1.1', 'C1.1'] });
    await writeFile(path.join(repo, 'schematic.intent.json'), JSON.stringify(intent));
    const options = { repoRoot: repo, schematic: 'board.kicad_sch', symbolDirs: [SYMBOLS] };
    const result = await draftSchematic(options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.generatedLibs.map((s) => s.libId).sort()).toEqual([
      'copperhead_power:+5V_PROTECTED', 'copperhead_power:GND', 'copperhead_power:PWR_FLAG', 'copperhead_power:VBUS_RAW',
    ]);
    expect(result.report.pwrFlags.sort()).toEqual(['+5V_PROTECTED', 'GND', 'VBUS_RAW']);
    expect(result.report.mergedNets).toEqual([]);
    const before = await readFile(schPath);
    const cachePath = path.join(repo, 'sym-lib-cache', 'copperhead_power.kicad_sym');
    const cacheBefore = await readFile(cachePath);
    const verifyEnv = { KICAD_SYMBOL_DIR: SYMBOLS, KICAD9_SYMBOL_DIR: libraries };
    expect(await verifySchematicSymbols(schPath, verifyEnv)).toEqual({ findings: [], checked: 8, skipped: 0 });
    expect(await readFile(schPath)).toEqual(before);
    expect(await readFile(cachePath)).toEqual(cacheBefore);
    const nets = new Map((await pinNets(schPath)).map((p) => [`${p.ref}.${p.pinNumber}`, p.net]));
    for (const net of intent.nets) {
      for (const pin of net.pins) expect(nets.get(pin), pin).toBe(net.name);
    }
    const erc = await runErc(schPath);
    expect(erc.violations).toEqual([]);
    expect(erc.ok).toBe(true);
    expect((await draftSchematic(options)).ok).toBe(true);
    expect(await readFile(schPath)).toEqual(before);
    expect(await readFile(cachePath)).toEqual(cacheBefore);
  }, 60000);
});
