import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { STAGES } from '../src/commands/create.js';
import { bootstrapKicadProject } from '../src/kicad/bootstrap.js';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import type { SchematicIntent } from '../src/kicad/draft/ir.js';
import { runErc } from '../src/kicad/cli.js';
import { checkDrift } from '../src/memory/drift.js';
import { FIXTURE } from './helpers.js';

const stage = STAGES.find((s) => s.name === 'firmware')!;
const EVIDENCE = '# Firmware not applicable\n\nProgrammable components: none\n\n' +
  'Reason: The connector and resistor form a hardware-only load with no software-controlled behavior.\n';
const SCH = 'applicability-test.kicad_sch';

/** Real stock symbols and KiCad ERC, with no provider/model calls. */
async function template(switchPart: 'MIC2544' | 'TPS2065' | null = null): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'copperhead-fw-template-'));
  await bootstrapKicadProject(root, '# Applicability test');
  const intent: SchematicIntent = {
    version: 1,
    parts: [
      { ref: 'J1', libId: 'Connector_Generic:Conn_01x02', value: 'Conn_01x02', group: 'Power' },
      { ref: 'R1', libId: 'Device:R', value: '10k', group: 'Power' },
    ],
    nets: [
      { name: '+5V', pins: ['J1.1', 'R1.1'], kind: 'power' },
      { name: 'GND', pins: ['J1.2', 'R1.2'], kind: 'ground' },
    ],
  };
  if (switchPart === 'MIC2544') {
    intent.parts.push(
      { ref: 'U1', libId: 'Power_Management:MIC2544-2YM', value: 'MIC2544-2YM', group: 'Power' },
      { ref: 'R2', libId: 'Device:R', value: '620R', group: 'Power' },
      { ref: 'J2', libId: 'Connector_Generic:Conn_01x02', value: 'Conn_01x02', group: 'Power' },
    );
    intent.nets[0]!.pins.push('U1.7');
    intent.nets[1]!.pins.push('U1.1', 'U1.3', 'R2.2', 'J2.2');
    intent.nets.push(
      { name: 'ILIM', pins: ['U1.4', 'R2.1'] },
      // OUT is already an Output pin; it must not gain a second PWR_FLAG driver.
      { name: 'OUT', pins: ['U1.6', 'U1.8', 'J2.1'], kind: 'signal' },
    );
    intent.noConnect = ['U1.2', 'U1.5'];
  }
  if (switchPart === 'TPS2065') {
    intent.parts.push(
      { ref: 'U1', libId: 'Power_Management:TPS2065CDBV', value: 'TPS2065CDBVR',
        footprint: 'Package_TO_SOT_SMD:SOT-23-5', group: 'Power' },
      { ref: 'C1', libId: 'Device:C', value: '100n', group: 'Power' },
      { ref: 'C2', libId: 'Device:C', value: '1u', group: 'Power' },
      { ref: 'J2', libId: 'Connector_Generic:Conn_01x02', value: 'Conn_01x02', group: 'Power' },
    );
    // TI's DBV pinout: OUT1, GND2, FLT3, active-high EN4, IN5.
    // Hardware straps EN high; no controller, register setup or firmware.
    intent.nets[0]!.pins = ['J1.1', 'U1.5', 'U1.4', 'C1.1'];
    intent.nets[1]!.pins.push('U1.2', 'C1.2', 'C2.2', 'J2.2');
    intent.nets.push({ name: 'OUT', pins: ['U1.1', 'R1.1', 'C2.1', 'J2.1'], kind: 'signal' });
    intent.noConnect = ['U1.3'];
  }
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'SUBSYSTEMS.md'), '# Subsystems\n\n## Power\nHardware-only load.\n');
  await writeFile(path.join(root, 'docs', 'BOM.md'),
    '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n| --- | --- | --- | --- | --- |\n' +
    intent.parts.map((p) => `| ${p.ref} | ${p.value} | ${p.footprint ?? ''} | ${p.value} | hardware-only test |`).join('\n') + '\n');
  await writeFile(path.join(root, 'docs', 'PINOUT.md'),
    '# Pinout\n\n| Refdes | Pin | Net |\n| --- | --- | --- |\n' +
    intent.nets.flatMap((n) => n.pins.map((ep) => {
      const [ref, pin] = ep.split('.');
      return `| ${ref} | ${pin} | ${n.name} |`;
    })).join('\n') + '\n');
  await writeFile(path.join(root, 'schematic.intent.json'), JSON.stringify(intent));
  const result = await draftSchematic({ repoRoot: root, schematic: SCH, docsDir: path.join(root, 'docs') });
  expect(result.ok, result.message).toBe(true);
  const erc = await runErc(path.join(root, SCH));
  expect(erc.ok, JSON.stringify(erc.violations)).toBe(true);
  expect(await checkDrift(root, 'docs', SCH)).toEqual([]);
  return root;
}

describe('firmware applicability stage', () => {
  let passive: string;
  let fixedFunction: string;
  let tps2065: string;
  let root: string;
  beforeAll(async () => {
    passive = await template();
    fixedFunction = await template('MIC2544');
    tps2065 = await template('TPS2065');
  });
  afterAll(async () => {
    if (passive) await rm(passive, { recursive: true, force: true });
    if (fixedFunction) await rm(fixedFunction, { recursive: true, force: true });
    if (tps2065) await rm(tps2065, { recursive: true, force: true });
  });
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'copperhead-fw-test-'));
    await cp(passive, root, { recursive: true });
    await mkdir(path.join(root, 'firmware'));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const evidence = () => writeFile(path.join(root, 'firmware', 'README.md'), EVIDENCE);
  async function useMcuFixture(): Promise<void> {
    await cp(FIXTURE, root, { recursive: true });
    await writeFile(path.join(root, '.copperhead', 'config.json'), JSON.stringify({
      schematic: 'hardware/open-key.kicad_sch', docs: 'docs',
    }));
  }

  it('accepts documented passive hardware without any source file', async () => {
    await evidence();
    expect(await stage.isComplete(root, 'docs')).toBe(true);
  });

  it('accepts only the explicitly reviewed fixed-function MIC2544-2YM', async () => {
    await cp(fixedFunction, root, { recursive: true });
    await evidence();
    expect(await stage.isComplete(root, 'docs')).toBe(true);
  });

  it('accepts the exact reviewed TPS2065CDBV with real ERC and coherent docs', async () => {
    await cp(tps2065, root, { recursive: true });
    await writeFile(path.join(root, 'firmware', 'README.md'),
      '# Firmware not applicable\n\nProgrammable components: none\n\n' +
      'Reason: The fixed-function power switch is hardware-enabled; its protection operates without software.\n');
    expect(await stage.isComplete(root, 'docs')).toBe(true);
  });

  it('requires evidence even for an independently valid passive schematic', async () => {
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it.each([
    '', '# Firmware not applicable\n',
    EVIDENCE.replace('Programmable components: none', 'Programmable components: unknown'),
    EVIDENCE.replace(/Reason:.+/, 'Reason: '),
    EVIDENCE.replace(/Reason:.+/, 'Reason: TODO fill in the hardware rationale'),
    EVIDENCE.replace(/Reason:.+/, 'Reason: <a concrete explanation of the hardware-only operation>'),
    EVIDENCE.replace(/Reason:.+/, 'Reason: <!-- no firmware is necessary -->'),
    `\`\`\`md\n${EVIDENCE}\`\`\`\n`,
    `${EVIDENCE}\nProgrammable components: MCU\n`,
  ])('rejects empty, ambiguous or placeholder evidence (%#)', async (text) => {
    await writeFile(path.join(root, 'firmware', 'README.md'), text);
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it.each(['Custom:PassiveBoard', 'MCU_ST_STM32F1:STM32F103C8Tx', 'RF_Module:ESP32-WROOM-32',
    'FPGA_Lattice:iCE40HX1K-TQ144', 'Power_Management:UnreviewedSwitch',
    'Power_Management:TPS2051CDBV', 'Power_Management:TPS2065CDBVx-2',
    'Power_Management:TPS2065CDGN', 'Custom:TPS2065CDBV', 'Power_Management:TPS2065CDBV_Custom'])
  ('rejects unknown/custom and programmable symbols: %s', async (libId) => {
    await evidence();
    const file = path.join(root, SCH);
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('Device:R', libId));
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it('rejects a real MCU fixture even with an N/A declaration', async () => {
    await useMcuFixture();
    await evidence();
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it('detects an MCU in a hierarchical child sheet', async () => {
    await evidence();
    await cp(path.join(FIXTURE, 'hardware', 'open-key.kicad_sch'), path.join(root, 'child.kicad_sch'));
    const file = path.join(root, SCH);
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/\)\s*$/, '(sheet (property "Sheetname" "child") (property "Sheetfile" "child.kicad_sch")))'));
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it.each(['docs/BOM.md', 'docs/PINOUT.md', SCH, '.copperhead/config.json'])
  ('fails closed with missing %s', async (file) => {
    await evidence();
    await rm(path.join(root, file));
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it.each(['docs/BOM.md', 'docs/PINOUT.md', SCH])('fails closed with empty %s', async (file) => {
    await evidence();
    await writeFile(path.join(root, file), '');
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it('rejects a zero-symbol schematic', async () => {
    await evidence();
    await writeFile(path.join(root, SCH), '(kicad_sch (version 20231120) (lib_symbols))');
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it('rejects documentation drift', async () => {
    await evidence();
    const file = path.join(root, 'docs', 'BOM.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('10k', '20k'));
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it('rejects an ERC failure without weakening other checks', async () => {
    await evidence();
    // Removing wires leaves correctly documented parts but electrically open pins.
    const file = path.join(root, SCH);
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/\(wire\s+\(pts\s+\(xy [^)]+\)\s+\(xy [^)]+\)\)\s+\(stroke [\s\S]*?\(uuid "[^"]+"\)\s*\)/g, ''));
    expect((await runErc(file)).ok).toBe(false);
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it('uses the configured docs path for evidence consistency', async () => {
    await evidence();
    await cp(path.join(root, 'docs'), path.join(root, 'design-docs'), { recursive: true });
    await rm(path.join(root, 'docs'), { recursive: true });
    expect(await stage.isComplete(root, 'design-docs')).toBe(true);
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it.each(['', ' \n\t'])('does not count a zero-content pins.h as firmware (%#)', async (source) => {
    await useMcuFixture();
    await writeFile(path.join(root, 'firmware', 'pins.h'), source);
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it('preserves the real MCU firmware-source path', async () => {
    await useMcuFixture();
    await evidence();
    await mkdir(path.join(root, 'firmware', 'src'));
    await writeFile(path.join(root, 'firmware', 'src', 'main.c'), 'int main(void) { for (;;) {} }\n');
    expect(await stage.isComplete(root, 'docs')).toBe(true);
  });

  it('keeps all eight stage outcomes and puts documented applicability in stage 7', () => {
    expect(STAGES.map((s) => s.name)).toEqual([
      'spec-seed', 'architecture', 'part-selection', 'schematic',
      'layout-draft', 'outputs', 'firmware', 'devplan',
    ]);
    expect(stage.prompt('', 'design-docs')).toContain('design-docs/PINOUT.md');
    expect(stage.prompt('', 'docs')).toContain('do not invent an MCU or dummy source files');
  });
});
