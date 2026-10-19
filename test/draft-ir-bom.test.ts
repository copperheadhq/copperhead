import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { validateIntent, parseIntent, looksLikeDescription } from '../src/kicad/draft/ir.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { FootprintResolver, isMechanicalPad, exposedPads } from '../src/kicad/footprints.js';
import { draftSchematicToText } from '../src/kicad/draft/draft.js';
import { mkdir } from 'node:fs/promises';

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

describe('footprint cross-check (#314, AC-15.34)', () => {
  /** Rewrite one refdes's Footprint cell in the fixture BOM. */
  async function setBomFootprint(docs: string, ref: string, footprint: string): Promise<void> {
    const file = path.join(docs, 'BOM.md');
    const out = (await readFile(file, 'utf8'))
      .split('\n')
      .map((line) => {
        const cells = line.split('|');
        if (cells.length < 4 || cells[1]?.trim() !== ref) return line;
        cells[3] = ` ${footprint} `;
        return cells.join('|');
      })
      .join('\n');
    await writeFile(file, out, 'utf8');
  }

  it('refuses an intent footprint that differs from its BOM row, naming both', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      await setBomFootprint(docs, 'C1', 'Capacitor_SMD:C_0603_1608Metric');
      const res = await validateFixture(repo, docs);
      expect(res.ok).toBe(false);
      const detail = res.findings.map((f) => f.detail).join('\n');
      expect(detail).toContain('C1 footprint "Capacitor_SMD:C_0402_1005Metric" differs from BOM.md\'s "Capacitor_SMD:C_0603_1608Metric"');
      expect(detail).toContain('do not substitute');
    } finally {
      await cleanup();
    }
  });

  it('reads a backtick-wrapped BOM cell as the same id', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      await setBomFootprint(docs, 'C1', '`Capacitor_SMD:C_0402_1005Metric`');
      expect((await validateFixture(repo, docs)).ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('with a footprint resolver, refuses symbol pins the footprint has no pad for', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      // intent and BOM agree on a one-pad footprint for a two-pin capacitor
      await setBomFootprint(docs, 'C1', 'TestPoint:TestPoint_Pad_D1.0mm');
      const intentPath = path.join(repo, 'schematic.intent.json');
      await writeFile(
        intentPath,
        (await readFile(intentPath, 'utf8')).replace('Capacitor_SMD:C_0402_1005Metric', 'TestPoint:TestPoint_Pad_D1.0mm'),
        'utf8',
      );
      const { intent } = parseIntent(await readFile(intentPath, 'utf8'));
      const footprints = await FootprintResolver.create({ projectDir: repo, global: false });
      const res = await validateIntent(intent!, new SymbolSource(repo, [SYMLIB]), docs, footprints);
      expect(res.ok).toBe(false);
      expect(res.findings.map((f) => f.detail).join('\n')).toContain(
        'C1: pin(s) 2 have no pad in footprint TestPoint:TestPoint_Pad_D1.0mm (its pads: 1)',
      );
      // without a resolver (standalone drafts, the reference corpus) the check does not run
      expect((await validateIntent(intent!, new SymbolSource(repo, [SYMLIB]), docs)).ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('refuses footprint pads the symbol has no pin for, since they would float (#325)', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      // a three-pad SOT-23 under a two-pin capacitor: pad 3 gets no net
      await setBomFootprint(docs, 'C1', 'Package_TO_SOT_SMD:SOT-23');
      const intentPath = path.join(repo, 'schematic.intent.json');
      await writeFile(intentPath, (await readFile(intentPath, 'utf8')).replace('Capacitor_SMD:C_0402_1005Metric', 'Package_TO_SOT_SMD:SOT-23'), 'utf8');
      const { intent } = parseIntent(await readFile(intentPath, 'utf8'));
      const footprints = await FootprintResolver.create({ projectDir: repo, global: false });
      const res = await validateIntent(intent!, new SymbolSource(repo, [SYMLIB]), docs, footprints);
      expect(res.ok).toBe(false);
      const detail = res.findings.map((f) => f.detail).join('\n');
      expect(detail).toContain('C1: pad(s) 3 of footprint Package_TO_SOT_SMD:SOT-23 have no symbol pin, so they would float unconnected on the board (its pads: 1, 2, 3)');
      expect(detail).toContain('use a footprint whose electrical pads are all pins of the symbol');
    } finally {
      await cleanup();
    }
  });

  it('mechanical, shield, thermal and unnumbered pads are unconnected by design and pass (#325)', async () => {
    for (const n of ['', 'MP', 'MP1', 'SH', 'S1', 'S2', 'EP', 'NC', 'nc2']) expect(isMechanicalPad(n)).toBe(true);
    for (const n of ['1', '2', 'A4', 'B1', '3', 'SHIELD', 'EPA']) expect(isMechanicalPad(n)).toBe(false);

    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      // a project-local two-pin footprint with a mounting pad and an unnumbered hole
      await mkdir(path.join(repo, 'Local.pretty'));
      await writeFile(
        path.join(repo, 'Local.pretty', 'Cap2_MP.kicad_mod'),
        '(footprint "Cap2_MP" (version 20240108) (generator "test") (layer "F.Cu")\n' +
          '  (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))\n' +
          '  (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))\n' +
          '  (pad "MP1" thru_hole circle (at 0 2) (size 1.5 1.5) (drill 0.8) (layers "*.Cu" "*.Mask"))\n' +
          '  (pad "" np_thru_hole circle (at 0 -2) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask"))\n' +
          ')\n',
        'utf8',
      );
      await writeFile(
        path.join(repo, 'fp-lib-table'),
        '(fp_lib_table\n\t(version 7)\n\t(lib (name "Local")(type "KiCad")(uri "${KIPRJMOD}/Local.pretty")(options "")(descr ""))\n)\n',
        'utf8',
      );
      await setBomFootprint(docs, 'C1', 'Local:Cap2_MP');
      const intentPath = path.join(repo, 'schematic.intent.json');
      await writeFile(intentPath, (await readFile(intentPath, 'utf8')).replace('Capacitor_SMD:C_0402_1005Metric', 'Local:Cap2_MP'), 'utf8');
      const { intent } = parseIntent(await readFile(intentPath, 'utf8'));
      const footprints = await FootprintResolver.create({ projectDir: repo, global: false });
      const res = await validateIntent(intent!, new SymbolSource(repo, [SYMLIB]), docs, footprints);
      expect(res.findings.map((f) => f.detail).join('\n')).toBe('');
      expect(res.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
  /** A project-local library of one or more footprints, listed in the project fp-lib-table. */
  async function localLibrary(repo: string, mods: Record<string, string>): Promise<void> {
    await mkdir(path.join(repo, 'Local.pretty'), { recursive: true });
    for (const [name, pads] of Object.entries(mods)) {
      await writeFile(path.join(repo, 'Local.pretty', `${name}.kicad_mod`), `(footprint "${name}" (version 20240108) (generator "test") (layer "F.Cu")\n${pads})\n`, 'utf8');
    }
    await writeFile(
      path.join(repo, 'fp-lib-table'),
      '(fp_lib_table\n\t(version 7)\n\t(lib (name "Local")(type "KiCad")(uri "${KIPRJMOD}/Local.pretty")(options "")(descr ""))\n)\n',
      'utf8',
    );
  }
  const smd = (n: string, x: number, extra = ''): string => `  (pad "${n}" smd rect (at ${x} 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")${extra})\n`;

  /** Validate the fixture with C1 on `Local:<name>`. */
  async function validateOn(repo: string, docs: string, name: string) {
    await setBomFootprint(docs, 'C1', `Local:${name}`);
    const intentPath = path.join(repo, 'schematic.intent.json');
    await writeFile(intentPath, (await readFile(intentPath, 'utf8')).replace('Capacitor_SMD:C_0402_1005Metric', `Local:${name}`), 'utf8');
    const { intent } = parseIntent(await readFile(intentPath, 'utf8'));
    const footprints = await FootprintResolver.create({ projectDir: repo, global: false });
    return validateIntent(intent!, new SymbolSource(repo, [SYMLIB]), docs, footprints);
  }

  it('an exposed pad the library marks as a heatsink is unconnected by design (the MCP73831 on its DFN-8-1EP)', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      await localLibrary(repo, { Cap2_Heatsink: smd('1', -1) + smd('2', 1) + smd('3', 0, ' (property pad_prop_heatsink)') });
      const res = await validateOn(repo, docs, 'Cap2_Heatsink');
      expect(res.findings.map((f) => f.detail).join('\n')).toBe('');
      expect(res.ok).toBe(true);
      expect(res.validated!.warnings).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('the highest-numbered pad of a footprint named for an exposed pad is that pad, marked or not', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      // KiCad's own DFN-8-1EP_3x2mm_P0.5mm_EP1.75x1.45mm numbers its unmarked exposed pad 9
      await localLibrary(repo, { 'DFN-2-1EP_2x2mm': smd('1', -1) + smd('2', 1) + smd('3', 0) });
      const res = await validateOn(repo, docs, 'DFN-2-1EP_2x2mm');
      expect(res.findings.map((f) => f.detail).join('\n')).toBe('');
      expect(res.ok).toBe(true);
      expect(res.validated!.warnings).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('a pad no pin names is refused when the library ships the variant the symbol fits (#325)', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      // the 16-contact receptacle beside the 6-contact one, in miniature
      await localLibrary(repo, { Cap3: smd('1', -1) + smd('2', 1) + smd('3', 3), Cap2: smd('1', -1) + smd('2', 1) });
      const res = await validateOn(repo, docs, 'Cap3');
      expect(res.ok).toBe(false);
      const detail = res.findings.map((f) => f.detail).join('\n');
      expect(detail).toContain('C1: pad(s) 3 of footprint Local:Cap3 have no symbol pin, so they would float unconnected on the board (its pads: 1, 2, 3)');
      expect(detail).toContain('use a footprint whose electrical pads are all pins of the symbol (Local:Cap2 in the same library matches)');
    } finally {
      await cleanup();
    }
  });

  it("a pad no pin names is a warning, not a refusal, when no footprint in its library fits the symbol (the FT232RL's NC leads)", async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      await localLibrary(repo, { Cap3: smd('1', -1) + smd('2', 1) + smd('3', 3), Cap4: smd('1', -1) + smd('2', 1) + smd('3', 3) + smd('4', 5) });
      const res = await validateOn(repo, docs, 'Cap3');
      expect(res.findings.map((f) => f.detail).join('\n')).toBe('');
      expect(res.ok).toBe(true);
      expect(res.validated!.warnings).toHaveLength(1);
      expect(res.validated!.warnings[0]).toContain('C1: pad(s) 3 of footprint Local:Cap3 have no symbol pin');
      expect(res.validated!.warnings[0]).toContain('unconnected by design');
    } finally {
      await cleanup();
    }
  });

  it('a symbol pin with no pad is still refused, whatever the library ships', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      await localLibrary(repo, { Cap1_3: smd('1', -1) + smd('3', 3) });
      const res = await validateOn(repo, docs, 'Cap1_3');
      expect(res.ok).toBe(false);
      expect(res.findings.map((f) => f.detail).join('\n')).toContain('C1: pin(s) 2 have no pad in footprint Local:Cap1_3');
    } finally {
      await cleanup();
    }
  });
  it('exposedPads: a footprint named for two exposed pads exempts its two highest unnamed numeric pads, and none the symbol names', () => {
    const pads = new Set(['1', '2', '3', '4', '5', '6', 'MP']);
    expect([...exposedPads('QFN-4-2EP_2x2mm', pads, new Set(['1', '2', '3', '4']))].sort()).toEqual(['5', '6']);
    expect([...exposedPads('QFN-4-2EP_2x2mm', pads, new Set(['1', '2', '3', '4', '6']))]).toEqual(['5']);
    expect([...exposedPads('DFN-6-1EP_2x2mm', pads, new Set(['1', '2', '3', '4', '5']))]).toEqual(['6']);
    expect(exposedPads('SOIC-8_3.9x4.9mm', pads, new Set(['1'])).size).toBe(0);
    expect(exposedPads('Deep_Well', pads, new Set(['1'])).size).toBe(0);
  });

  it('variantCovering: a bad id, an unknown library, a library missing on disk, and a malformed file are not candidates', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      await localLibrary(repo, { Cap3: smd('1', -1) + smd('2', 1) + smd('3', 3), Cap2: smd('1', -1) + smd('2', 1) });
      await writeFile(path.join(repo, 'Local.pretty', 'Broken.kicad_mod'), '(footprint "Broken" (pad "1" smd', 'utf8');
      const footprints = await FootprintResolver.create({ projectDir: repo, global: false });
      const pins = new Set(['1', '2']);
      expect(await footprints.variantCovering('Cap3', pins)).toBeNull();
      expect(await footprints.variantCovering('Nope:Cap3', pins)).toBeNull();
      // the malformed neighbour is skipped, the good one found
      expect(await footprints.variantCovering('Local:Cap3', pins)).toBe('Local:Cap2');
      await rm(path.join(repo, 'Local.pretty'), { recursive: true, force: true });
      expect(await footprints.variantCovering('Local:Cap3', pins)).toBeNull();
      void docs;
    } finally {
      await cleanup();
    }
  });

  it('variantCovering: of several fitting footprints, the one sharing the longest name prefix is named', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      // alphabetical order would pick Aaa2; the family's own two-pad variant wins
      await localLibrary(repo, { Cap3: smd('1', -1) + smd('2', 1) + smd('3', 3), Aaa2: smd('1', -1) + smd('2', 1), Cap2: smd('1', -1) + smd('2', 1) });
      const res = await validateOn(repo, docs, 'Cap3');
      expect(res.ok).toBe(false);
      expect(res.findings.map((f) => f.detail).join('\n')).toContain('(Local:Cap2 in the same library matches)');
    } finally {
      await cleanup();
    }
  });

  it('a part with both a missing pad and an unnamed pad is refused on both counts, without a variant hint', async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      await localLibrary(repo, { Cap1_3_4: smd('1', -1) + smd('3', 3) + smd('4', 5), Cap2: smd('1', -1) + smd('2', 1) });
      const res = await validateOn(repo, docs, 'Cap1_3_4');
      expect(res.ok).toBe(false);
      const detail = res.findings.map((f) => f.detail).join('\n');
      expect(detail).toContain('C1: pin(s) 2 have no pad in footprint Local:Cap1_3_4');
      expect(detail).toContain('pad(s) 3, 4');
      expect(detail).toContain('use a symbol whose pin numbers match');
      expect(detail).toContain('KiCad often ships a variant with the matching contact count');
      expect(detail).not.toContain('in the same library matches');
    } finally {
      await cleanup();
    }
  });

  it("the draft report's notes carry the pad warning", async () => {
    const { repo, docs, cleanup } = await fixtureRepo();
    try {
      await localLibrary(repo, { Cap3: smd('1', -1) + smd('2', 1) + smd('3', 3) });
      await setBomFootprint(docs, 'C1', 'Local:Cap3');
      const intentPath = path.join(repo, 'schematic.intent.json');
      await writeFile(intentPath, (await readFile(intentPath, 'utf8')).replace('Capacitor_SMD:C_0402_1005Metric', 'Local:Cap3'), 'utf8');
      const res = await draftSchematicToText({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: docs,
        symbolDirs: [SYMLIB],
        footprints: await FootprintResolver.create({ projectDir: repo, global: false }),
      });
      expect(res.ok, res.ok ? '' : res.message).toBe(true);
      if (res.ok) expect(res.report.notes.some((n) => n.includes('C1: pad(s) 3 of footprint Local:Cap3') && n.includes('unconnected by design'))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
