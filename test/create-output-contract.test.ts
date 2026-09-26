import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STAGES } from '../src/commands/create.js';

const roots: string[] = [];
const packageFiles = [
  'gerbers/board-F_Cu.gbr', 'gerbers/board-PTH.drl', 'outline.dxf', 'board.step',
  'board.svg', 'renders/design.svg', 'BOM.csv',
];
const complete = STAGES.find((stage) => stage.name === 'outputs')!.isComplete;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makePackage(omit?: string, empty = false): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ch-output-contract-'));
  roots.push(root);
  for (const name of packageFiles) {
    if (name === omit && !empty) continue;
    const file = path.join(root, 'outputs', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name === omit ? '' : `exported ${name}\n`);
  }
  return root;
}

describe('create requires the complete output package', () => {
  it('accepts all of the existing fabrication-tool outputs plus the ordering BOM', async () => {
    expect(await complete(await makePackage(), 'docs')).toBe(true);
  });

  it.each(packageFiles)('does not advance when %s is missing', async (name) => {
    expect(await complete(await makePackage(name), 'docs')).toBe(false);
  });

  it.each(packageFiles)('does not advance when %s was created empty by a failed exporter', async (name) => {
    expect(await complete(await makePackage(name, true), 'docs')).toBe(false);
  });

  it('accepts conventional alternative Gerber and STEP extensions', async () => {
    const root = await makePackage('gerbers/board-F_Cu.gbr');
    await writeFile(path.join(root, 'outputs', 'board.GTL'), 'G04*\n');
    await rm(path.join(root, 'outputs', 'board.step'));
    await writeFile(path.join(root, 'outputs', 'board.STP'), 'ISO-10303-21;\n');
    expect(await complete(root, 'docs')).toBe(true);
  });

  it('recognizes renders/board.svg as the schematic of a project named board', async () => {
    const root = await makePackage('renders/design.svg');
    await mkdir(path.join(root, 'outputs', 'renders'));
    await writeFile(path.join(root, 'outputs', 'renders', 'board.svg'), '<svg>schematic</svg>\n');
    expect(await complete(root, 'docs')).toBe(true);
    await rm(path.join(root, 'outputs', 'board.svg'));
    expect(await complete(root, 'docs')).toBe(false);
  });

  it('does not accept an empty firmware header as a generated scaffold', async () => {
    const root = await makePackage();
    await mkdir(path.join(root, 'firmware'));
    const header = path.join(root, 'firmware', 'pins.h');
    await writeFile(header, '');
    const firmwareComplete = STAGES.find((stage) => stage.name === 'firmware')!.isComplete;
    expect(await firmwareComplete(root, 'docs')).toBe(false);
    await writeFile(header, '#pragma once\n#define PIN_LED 2\n');
    expect(await firmwareComplete(root, 'docs')).toBe(true);
  });
});
