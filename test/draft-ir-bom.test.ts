import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { validateIntent, parseIntent, looksLikeDescription } from '../src/kicad/draft/ir.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';

/**
 * The BOM.md ↔ intent cross-check (`validateIntent`, design D6).
 *
 * Regression cover for the stage-4 deadlock: BOM.md's Value cell is drawn on
 * the sheet as the symbol's Value field, and the cross-check pins the intent's
 * value to that cell — so a description in the Value column is unsatisfiable.
 * The agent cannot shorten it (this gate refuses) and cannot leave it (the
 * legibility gate refuses), and `edit_file` is refused on a drafted sheet. A
 * live run burned all three stage-4 attempts on that loop because nothing ever
 * named BOM.md as the thing to change.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const DRAFT_FIXTURE = path.join(HERE, 'fixtures', 'draft');

async function fixtureRepo(): Promise<{ repo: string; docs: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-irbom-'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  await cp(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
  return { repo, docs: path.join(repo, 'docs'), cleanup: () => rm(repo, { recursive: true, force: true }) };
}

async function validateFixture(repo: string, docs: string) {
  const { intent } = parseIntent(await readFile(path.join(repo, 'schematic.intent.json'), 'utf8'));
  if (!intent) throw new Error('fixture intent did not parse');
  return validateIntent(intent, new SymbolSource(repo, [SYMLIB]), docs);
}

/** Rewrite one refdes's Value cell in the fixture BOM, keeping every other column. */
async function setBomValue(docs: string, ref: string, value: string): Promise<void> {
  const file = path.join(docs, 'BOM.md');
  const out = (await readFile(file, 'utf8'))
    .split('\n')
    .map((line) => {
      const cells = line.split('|');
      if (cells.length < 3 || cells[1]?.trim() !== ref) return line;
      cells[2] = ` ${value} `;
      return cells.join('|');
    })
    .join('\n');
  await writeFile(file, out, 'utf8');
}

describe('looksLikeDescription', () => {
  it('accepts component values, including long part numbers', () => {
    for (const v of ['10k', '4.7uF', '1M', '500mAh Li-Po', 'STM32F103C8T6', 'Conn_01x03', 'MCU8', '4.7uF, X5R, 10V, 0603']) {
      expect(looksLikeDescription(v), v).toBe(false);
    }
  });

  it('rejects the prose that deadlocked the live run', () => {
    for (const v of [
      '1S Li-Po cell, 500 mAh, bare leads',
      'P-MOSFET, `BAT_SENSE_EN` divider gate',
      'N-MOSFET, gate level-shifter for Q2',
      'TS bias network, value set at capture',
      'NTC thermistor, 10 kΩ, B = 3380 K',
    ]) {
      expect(looksLikeDescription(v), v).toBe(true);
    }
  });

  it('is not tripped by an empty cell', () => {
    expect(looksLikeDescription('')).toBe(false);
    expect(looksLikeDescription('   ')).toBe(false);
  });
});

describe('validateIntent: BOM.md cross-check', () => {
  it('passes on the fixture as committed', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      const res = await validateFixture(repo, docs);
      expect(res.findings.map((f) => f.detail)).toEqual([]);
      expect(res.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('reports a description in the Value column, and names BOM.md as the fix', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      // The intent still matches the cell exactly, so the equality check is
      // satisfied — this is precisely the state the live run could not escape.
      await setBomValue(docs, 'R1', '10k, divider top, 1% for the ADC path');
      const intentPath = path.join(repo, 'schematic.intent.json');
      const intent = JSON.parse(await readFile(intentPath, 'utf8'));
      intent.parts.find((p: { ref: string }) => p.ref === 'R1').value = '10k, divider top, 1% for the ADC path';
      await writeFile(intentPath, JSON.stringify(intent), 'utf8');

      const res = await validateFixture(repo, docs);
      expect(res.ok).toBe(false);
      const detail = res.findings.map((f) => f.detail).find((d) => d.includes('R1'));
      expect(detail).toBeDefined();
      expect(detail).toContain('is a description, not a component value');
      expect(detail).toContain('docs/BOM.md');
      expect(detail).toContain('Rationale');
    } finally {
      await cleanup();
    }
  });

  it('names the description even when the intent has already been shortened', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      // The agent's first instinct on an unreadable sheet is to shorten the
      // value in the IR — which makes the two differ. If the description check
      // only ran on a match, that instinct would be answered with "differs from
      // BOM.md's ..." and the agent would never learn the doc is the problem.
      // That is the loop this check exists to break.
      await setBomValue(docs, 'R1', '10k, divider top, 1% for the ADC path');
      const res = await validateFixture(repo, docs); // intent still says plain "10k"
      expect(res.ok).toBe(false);
      const details = res.findings.map((f) => f.detail).filter((d) => d.includes('R1'));
      expect(details.some((d) => d.includes('is a description, not a component value'))).toBe(true);
      // and it is not drowned out by the mismatch it necessarily causes
      expect(details.some((d) => d.includes('differs from BOM.md'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('folds encoding differences instead of failing on them (parity with checkDrift)', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      // `10k` in the intent vs `10 K` in the BOM: spacing and case only. The old
      // byte comparison refused this while checkDrift accepted it, so an intent
      // could satisfy neither gate.
      await setBomValue(docs, 'R1', '10 K');
      const res = await validateFixture(repo, docs);
      expect(res.findings.map((f) => f.detail).filter((d) => d.includes('R1'))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('still catches a real transcription slip (D6)', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      await setBomValue(docs, 'R1', '47k');
      const res = await validateFixture(repo, docs);
      expect(res.ok).toBe(false);
      expect(res.findings.map((f) => f.detail).find((d) => d.includes('R1'))).toContain('differs from BOM.md');
    } finally {
      await cleanup();
    }
  });

  it('ignores a supporting table: its rows are not parts', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      // A quiescent-current roll-up under the BOM. The old inline scan read every
      // pipe-line in the file, so this table's first cell became a refdes.
      const file = path.join(docs, 'BOM.md');
      await writeFile(
        file,
        (await readFile(file, 'utf8')) +
          ['', '## Quiescent current', '', '| Item | Typ | Max |', '| --- | --- | --- |', '| R1 | 0.05 µA | 0.5 µA |', ''].join('\n'),
        'utf8',
      );
      const res = await validateFixture(repo, docs);
      expect(res.findings.map((f) => f.detail)).toEqual([]);
      expect(res.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
