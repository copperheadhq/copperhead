import { describe, expect, it } from 'vitest';
import { compareElectrical, formatElectricalDiff, type ElectricalSnapshot } from '../src/commands/diff.js';
import path from 'node:path';
import { readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { execa } from 'execa';
import { runElectricalDiff } from '../src/commands/diff.js';
import { commitFixture, configureFixture, electricalFixture, hierarchicalFixture, SCHEMATIC } from './support/electrical-diff.js';

const snap = (components: ElectricalSnapshot['components'], pins: ElectricalSnapshot['pins']): ElectricalSnapshot => ({
  components, pins, nets: [...new Set(Object.values(pins).filter((net): net is string => net !== null))],
});

describe('electrical diff', () => {
  it('reports component and connection changes while ignoring object order', () => {
    const before = snap({ R1: { value: '10k', footprint: 'R_0603' }, U1: { value: 'MCU', footprint: 'QFN' } }, { 'U1.1': 'OLD_NET', 'R1.1': 'GND' });
    const after = snap({ U1: { value: 'MCU', footprint: 'QFN' }, R1: { value: '4k7', footprint: 'R_0603' }, C1: { value: '100n', footprint: '' } }, { 'U1.1': 'NEW_NET', 'R1.1': null });
    const diff = compareElectrical(before, after);
    expect(diff.components.added).toEqual(['C1 100n']);
    expect(diff.components.removed).toEqual([]);
    expect(diff.components.changed[0]?.ref).toBe('R1');
    expect(diff.connections.removed).toEqual(['R1.1 → GND', 'U1.1 → OLD_NET']);
    expect(diff.connections.added).toEqual(['U1.1 → NEW_NET']);
    expect(formatElectricalDiff(diff)).toContain('Connections removed:');
  });

  it('reports a clean design clearly', () => {
    const s = snap({ R1: { value: '10k', footprint: '' } }, { 'R1.1': 'VCC' });
    expect(formatElectricalDiff(compareElectrical(s, s))).toContain('No electrical changes.');
  });

  it('sorts changed references naturally regardless of insertion order', () => {
    const refs = ['R10', 'R2', 'R1'];
    const before = snap(Object.fromEntries(refs.map((r) => [r, { value: '10k', footprint: '' }])), {});
    const after = snap(Object.fromEntries(refs.map((r) => [r, { value: '20k', footprint: '' }])), {});
    expect(compareElectrical(before, after).components.changed.map((c) => c.ref)).toEqual(['R1', 'R2', 'R10']);
    const reversed = { ...after, components: Object.fromEntries(Object.entries(after.components).reverse()) };
    expect(compareElectrical(before, reversed)).toEqual(compareElectrical(before, after));
  });

  it('infers renames only for identical nonempty pin membership', () => {
    const before = snap({}, { 'U1.1': 'OLD', 'U1.2': 'OLD', 'U1.3': 'REMOVED' });
    const after = snap({}, { 'U1.1': 'NEW', 'U1.2': 'NEW', 'U1.4': 'ADDED' });
    const diff = compareElectrical(before, after, 'main');
    expect(diff.nets).toEqual({ renamed: [{ before: 'OLD', after: 'NEW' }], added: ['ADDED'], removed: ['REMOVED'] });
    expect(formatElectricalDiff(diff)).toContain('Electrical changes since main');
    expect(formatElectricalDiff(diff)).toContain('  Renamed: OLD → NEW');
    expect(formatElectricalDiff(diff)).toContain('  Added: ADDED');
    expect(formatElectricalDiff(diff)).toContain('  Removed: REMOVED');
    expect(compareElectrical({ ...before, pins: {} }, { ...after, pins: {} }).nets.renamed).toEqual([]);
  });
});

describe('electrical diff against real KiCad fixtures', () => {
  it('compares baseline values and nets, preserving dirty files and the Git index', async () => {
    const { repo, cleanup } = await electricalFixture();
    try {
      const file = path.join(repo, SCHEMATIC);
      const current = (await readFile(file, 'utf8')).replace('"Value" "1k"', '"Value" "2.2k"').replaceAll('KEY_DAH', 'KEY_DASH');
      await writeFile(file, current);
      const indexBefore = await readFile(path.join(repo, '.git/index'));
      const filesBefore = await readdir(repo);
      const diff = await runElectricalDiff(repo, 'HEAD');
      expect(diff.components.changed).toEqual([{ ref: 'R2', before: '1k (Resistor_SMD:R_0603_1608Metric)', after: '2.2k (Resistor_SMD:R_0603_1608Metric)' }]);
      expect(diff.nets.renamed).toEqual([{ before: 'KEY_DAH', after: 'KEY_DASH' }]);
      expect(diff.connections.added).toContain('U1.5 → KEY_DASH');
      expect(diff.baseCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(await readFile(file, 'utf8')).toBe(current);
      expect(await readFile(path.join(repo, '.git/index'))).toEqual(indexBefore);
      expect(await readdir(repo)).toEqual(filesBefore);
    } finally { await cleanup(); }
  });

  it('ignores whitespace-only changes in real schematic text', async () => {
    const { repo, cleanup } = await electricalFixture();
    try {
      const file = path.join(repo, SCHEMATIC);
      await writeFile(file, (await readFile(file, 'utf8')).replaceAll('\n', '\n\n'));
      expect(formatElectricalDiff(await runElectricalDiff(repo, 'HEAD'))).toContain('No electrical changes.');
    } finally { await cleanup(); }
  });

  it('extracts nested historical sheets even when their current names differ', async () => {
    const { repo, cleanup } = await electricalFixture();
    try {
      const leaf = await hierarchicalFixture(repo);
      await commitFixture(repo);
      const file = path.join(repo, leaf);
      await writeFile(file, (await readFile(file, 'utf8')).replaceAll('KEY_DAH', 'KEY_DASH'));
      await rename(file, path.join(path.dirname(file), 'renamed.kicad_sch'));
      const parent = path.join(repo, 'hardware/blocks/child.kicad_sch');
      await writeFile(parent, (await readFile(parent, 'utf8')).replace('deep/channel.kicad_sch', 'deep/renamed.kicad_sch'));
      const diff = await runElectricalDiff(repo, 'HEAD');
      expect(diff.nets.renamed).toEqual([{ before: 'KEY_DAH', after: 'KEY_DASH' }]);
      expect(diff.components.added).toEqual([]);
    } finally { await cleanup(); }
  });

  it('accepts Windows separators in config on every platform', async () => {
    const { repo, cleanup } = await electricalFixture();
    try {
      await configureFixture(repo, 'hardware\\open-key.kicad_sch');
      expect(formatElectricalDiff(await runElectricalDiff(repo, 'HEAD'))).toContain('No electrical changes.');
    } finally { await cleanup(); }
  });

  it('reports new schematics as additions when absent from a valid baseline', async () => {
    const { repo, cleanup } = await electricalFixture();
    try {
      await execa('git', ['rm', '--cached', SCHEMATIC], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'baseline before schematic'], { cwd: repo });
      const diff = await runElectricalDiff(repo, 'HEAD');
      expect(diff.components.added).toEqual(['R1 10k', 'R2 1k', 'U1 ESP32-S3-MINI']);
      expect(diff.nets.added).toContain('KEY_DAH');
    } finally { await cleanup(); }
  });

  it('reports invalid revisions without leaking raw Git errors', async () => {
    const { repo, cleanup } = await electricalFixture();
    try {
      await expect(runElectricalDiff(repo, 'not-a-real-revision')).rejects.toThrow('cannot resolve base revision "not-a-real-revision"');
      await expect(runElectricalDiff(repo, '--output=owned')).rejects.toThrow('cannot resolve base revision');
    } finally { await cleanup(); }
  });

  it('names missing baseline child sheets instead of treating them as empty', async () => {
    const { repo, cleanup } = await electricalFixture();
    try {
      const leaf = await hierarchicalFixture(repo);
      await commitFixture(repo);
      await execa('git', ['rm', '--cached', leaf], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'broken baseline'], { cwd: repo });
      await expect(runElectricalDiff(repo, 'HEAD')).rejects.toThrow('missing referenced sheet "' + leaf + '" in base revision');
    } finally { await cleanup(); }
  });

  it('rejects configured paths and child references that escape the repository', async () => {
    const { repo, cleanup } = await electricalFixture();
    try {
      await configureFixture(repo, '../outside.kicad_sch');
      await expect(runElectricalDiff(repo, 'HEAD')).rejects.toThrow('escapes repo root');
      await configureFixture(repo);
      await hierarchicalFixture(repo);
      const file = path.join(repo, SCHEMATIC);
      await writeFile(file, (await readFile(file, 'utf8')).replace('blocks/child.kicad_sch', '../../outside.kicad_sch'));
      await expect(runElectricalDiff(repo, 'HEAD')).rejects.toThrow('escapes repo root');
    } finally { await cleanup(); }
  });
});
