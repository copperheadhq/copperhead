import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { draftSchematicPlacement } from '../src/kicad/draft/engine.js';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import { checkLegibility } from '../src/kicad/legibility.js';

/**
 * Sheet-level layout passes: shelf-wrap, stacked-pin collapse, power-value
 * placement, and label nudging. These run on the placement model rather than
 * the emitted bytes, so a failure names the geometry that moved instead of
 * pointing at a diff. The byte contract itself lives in draft-reference-boards.test.ts.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const CONTROL = path.join(HERE, '..', 'manual-tests', 'reference-boards');
const U = 1.27;
/** Default stub length, grid units (engine STUB). */
const STUB = 2;

/** Place an intent without touching the schematic on disk. */
async function place(intent: SchematicIntent, docsDir: string | null = null) {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-layout-'));
  try {
    const symsource = new SymbolSource(repo, [SYMLIB]);
    const v = await validateIntent(intent, symsource, docsDir);
    expect(v.ok, v.findings.map((f) => f.detail).join('; ')).toBe(true);
    const { model, report } = draftSchematicPlacement(v.validated!, 'board', '2020-01-01');
    return { model, report, symbols: v.validated!.symbols };
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

/** N single-MCU subsystems in declared order: the ribbon shelf-wrap reflows. */
function ribbon(n: number): SchematicIntent {
  const parts = [];
  const nets = [];
  const noConnect: string[] = [];
  for (let i = 1; i <= n; i++) {
    const group = `G${String(i).padStart(2, '0')}`;
    parts.push({ ref: `U${i}`, libId: 'CopperMCU:MCU8', value: 'MCU8', group });
    parts.push({ ref: `R${i}`, libId: 'Device:R', value: '10k', group });
    nets.push({ name: `SIG${i}`, pins: [`U${i}.4`, `R${i}.1`] });
    nets.push({ name: `OUT${i}`, pins: [`U${i}.5`, `R${i}.2`] });
    for (const p of ['3', '6', '7', '8']) noConnect.push(`U${i}.${p}`);
  }
  nets.push({ name: 'VCC', pins: Array.from({ length: n }, (_, i) => `U${i + 1}.1`) });
  nets.push({ name: 'GND', pins: Array.from({ length: n }, (_, i) => `U${i + 1}.2`) });
  return { version: 1, parts, nets, noConnect };
}

/** Group boxes bucketed into rows by top edge, each row left-to-right. */
function rowsOf(rects: { x1: number; y1: number; name?: string }[]): string[][] {
  const rows = new Map<number, { x: number; name: string }[]>();
  for (const r of rects) {
    const key = Math.round(r.y1);
    rows.set(key, [...(rows.get(key) ?? []), { x: r.x1, name: r.name ?? '' }]);
  }
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row.sort((a, b) => a.x - b.x).map((g) => g.name));
}

describe('shelf-wrap: the group ribbon reflows into rows (design D12)', () => {
  it('wraps a long ribbon into rows, preserves reading order, and fits a smaller sheet', async () => {
    const { model, report } = await place(ribbon(8));

    expect(report.notes).toContain('groups wrapped onto 2 rows to fit the sheet');
    const rows = rowsOf(model.rectangles);
    expect(rows).toEqual([
      ['G01', 'G02', 'G03', 'G04'],
      ['G05', 'G06', 'G07', 'G08'],
    ]);

    // the point of wrapping: eight groups in a single row is a ~9:1 ribbon that
    // forces a huge sheet; wrapped, the same content fits A4
    expect(report.paper).toBe('A4');
    const totalGroupWidth = model.rectangles.reduce((s, r) => s + (r.x2 - r.x1), 0);
    expect(totalGroupWidth).toBeGreaterThan(297);

    // rows are rows: no group box overlaps another
    for (let i = 0; i < model.rectangles.length; i++) {
      for (let j = i + 1; j < model.rectangles.length; j++) {
        const a = model.rectangles[i]!;
        const b = model.rectangles[j]!;
        const overlaps = a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
        expect(overlaps, `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
  });

  it('leaves a layout that already fits one row on one row, unwrapped and unannotated', async () => {
    const { model, report } = await place(ribbon(2));
    expect(report.notes).toEqual([]);
    expect(rowsOf(model.rectangles)).toEqual([['G01', 'G02']]);
  });

  it('wraps to the hinted paper width and keeps the hint', async () => {
    const { model, report } = await place({ ...ribbon(6), hints: { paper: 'A3' } });
    expect(report.paper).toBe('A3');
    // A3 is wider than the content-derived A4, so the same six groups need
    // fewer rows than they did without the hint
    expect(rowsOf(model.rectangles).length).toBeLessThanOrEqual(2);
  });

  it('notes an unknown paper hint and derives the sheet from content instead', async () => {
    const { report } = await place({ ...ribbon(2), hints: { paper: 'B7' } });
    expect(report.notes).toContain('paper hint "B7" is not a standard size; deriving paper from content');
    expect(report.paper).toBe('A5');
  });

  it('drafts an intent with nothing to place instead of throwing', async () => {
    const { model, report } = await place({ version: 1, parts: [], nets: [] });
    expect(model.rectangles).toEqual([]);
    expect(model.symbols).toEqual([]);
    expect(report.paper).toBe('A5');
  });

  it('a wrapped sheet still passes the legibility gate', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-wrap-'));
    try {
      const intent = ribbon(8);
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(
        path.join(repo, 'docs', 'SUBSYSTEMS.md'),
        ['# Subsystems', ...[...new Set(intent.parts.map((p) => p.group))].map((g) => `\n## ${g}\n\nBlock ${g}.`)].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(repo, 'docs', 'BOM.md'),
        ['# BOM', '', '| Refdes | Value | Footprint | MPN | Rationale |', '| --- | --- | --- | --- | --- |',
          ...intent.parts.map((p) => `| ${p.ref} | ${p.value} |  | UNVERIFIED | fixture |`)].join('\n'),
        'utf8',
      );
      await writeFile(path.join(repo, 'schematic.intent.json'), JSON.stringify(intent, null, 2), 'utf8');

      const res = await draftSchematic({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        docsDir: 'docs',
        symbolDirs: [SYMLIB],
      });
      expect(res.ok, res.ok ? '' : res.message).toBe(true);
      if (!res.ok) return;
      const leg = await checkLegibility(res.schematicPath, { docsDir: path.join(repo, 'docs') });
      expect(leg.findings.filter((f) => f.severity === 'error')).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30000);
});

describe('stacked pins are one point on the sheet', () => {
  /** PWRIC repeats its GND pin (2 and 4) at one coordinate, thermal-pad style. */
  const stacked: SchematicIntent = {
    version: 1,
    parts: [
      { ref: 'U1', libId: 'CopperStack:PWRIC', value: 'PWRIC', group: 'Reg' },
      { ref: 'J1', libId: 'CopperConn:Conn_01x03', value: 'Conn_01x03', group: 'Reg' },
    ],
    nets: [
      { name: 'VIN', pins: ['U1.1', 'J1.1'] },
      { name: 'GND', pins: ['U1.2', 'U1.4', 'J1.2'] },
      { name: 'VOUT', pins: ['U1.3', 'J1.3'] },
    ],
  };

  it('draws one stub, one power symbol, and one value at a repeated pin coordinate', async () => {
    const { model } = await place(stacked);
    const pwr = model.symbols.filter((s) => s.ref.startsWith('#PWR'));

    // three nets x two ENDPOINT POINTS each: U1's two GND pins share a point
    // and collapse, so GND gets two symbols and not three
    expect(pwr).toHaveLength(6);
    expect(pwr.filter((s) => s.value === 'GND')).toHaveLength(2);

    const at = (s: (typeof pwr)[number]) => `${s.at.x},${s.at.y}`;
    expect(new Set(pwr.map(at)).size).toBe(pwr.length);
    // and one stub per symbol: no wire drawn twice on top of itself
    const wireKeys = model.wires.map((w) => `${w.x1},${w.y1},${w.x2},${w.y2}`);
    expect(new Set(wireKeys).size).toBe(wireKeys.length);
    expect(model.wires).toHaveLength(6);
  });

  it('keeps the collapsed point connected to both stacked pins', async () => {
    const { model, symbols } = await place(stacked);
    const u1 = model.symbols.find((s) => s.ref === 'U1')!;
    const pins = symbols.get('U1')!.pins;
    const pin2 = pins.find((p) => p.number === '2')!;
    const pin4 = pins.find((p) => p.number === '4')!;
    const pointOf = (p: typeof pin2) => ({ x: u1.at.x + p.x, y: u1.at.y - p.y });
    expect(pointOf(pin2)).toEqual(pointOf(pin4));

    // the surviving stub leaves that shared point, so both pins stay on GND
    const shared = pointOf(pin2);
    const stubs = model.wires.filter((w) => w.x1 === shared.x && w.y1 === shared.y);
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.net).toBe('GND');
  });
});

describe('power-symbol value text lands away from the part it serves', () => {
  it('follows the stub outward rather than the net class', async () => {
    // PWRIC carries GND and VOUT on DOWNWARD pins: the rail bar draws its text
    // above by class, which would throw "VOUT" back across its own stub and
    // onto the symbol body. The text follows the stub instead.
    const { model } = await place({
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperStack:PWRIC', value: 'PWRIC', group: 'Reg' },
        { ref: 'J1', libId: 'CopperConn:Conn_01x03', value: 'Conn_01x03', group: 'Reg' },
      ],
      nets: [
        { name: 'VIN', pins: ['U1.1', 'J1.1'] },
        { name: 'GND', pins: ['U1.2', 'J1.2'] },
        { name: 'VOUT', pins: ['U1.3', 'J1.3'] },
      ],
    });

    const pwr = model.symbols.filter((s) => s.ref.startsWith('#PWR'));
    expect(pwr.length).toBeGreaterThan(0);
    for (const s of pwr) {
      const stub = model.wires.find((w) => w.x2 === s.at.x && w.y2 === s.at.y);
      expect(stub, `${s.ref} (${s.value}) has no stub`).toBeDefined();
      if (!stub) continue;
      if (stub.y1 === stub.y2) continue; // horizontal stub: text sits by class
      // vertical stub: the text continues past the bar, never back toward the pin
      expect(Math.sign(s.valueAt.y - s.at.y), `${s.ref} (${s.value}) text faces its pin`).toBe(
        Math.sign(stub.y2 - stub.y1),
      );
    }

    // the downward rail is the case that used to fail
    const vout = pwr.find((s) => s.value === 'VOUT' && model.wires.some((w) => w.x2 === s.at.x && w.y2 === s.at.y && w.y2 > w.y1));
    expect(vout, 'no downward VOUT stub in the fixture').toBeDefined();
    expect(vout!.valueAt.y).toBeGreaterThan(vout!.at.y);
  });
});

describe('label nudging keeps a stub label attached and clear', () => {
  it('rides a colliding label outward along its own stub (buck-12v-5v)', async () => {
    // Nets draft in name order, so "COMP" cannot see the trunk "COMP_Z" is
    // about to run through its label. The nudge pass fixes that after routing.
    const src = path.join(CONTROL, 'buck-12v-5v');
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-nudge-'));
    try {
      await cp(src, repo, { recursive: true });
      const intent = JSON.parse(await readFile(path.join(repo, 'schematic.intent.json'), 'utf8')) as SchematicIntent;
      // no symbolDirs override: resolution comes from the committed cache
      const symsource = new SymbolSource(repo, []);
      const v = await validateIntent(intent, symsource, path.join(repo, 'docs'));
      expect(v.ok, v.findings.map((f) => f.detail).join('; ')).toBe(true);
      const { model } = draftSchematicPlacement(v.validated!, 'buck-12v-5v', '2020-01-01');

      // pin points of every placed part, to tell a pin stub from a trunk
      const pinPoints = new Set<string>();
      for (const s of model.symbols) {
        for (const p of v.validated!.symbols.get(s.ref)?.pins ?? []) {
          pinPoints.add(`${s.at.x + p.x},${s.at.y - p.y}`);
        }
      }
      const stubOf = (l: { x: number; y: number }) =>
        model.wires.find((w) => w.x2 === l.x && w.y2 === l.y && pinPoints.has(`${w.x1},${w.y1}`));

      const stubLabels = model.labels.map((l) => ({ l, w: stubOf(l) })).filter((e) => e.w !== undefined);
      expect(stubLabels.length).toBeGreaterThan(0);

      // every stub label is still an endpoint of the stub that starts at its
      // pin: nudging extends the wire, it never detaches the label from it
      const lengths = stubLabels.map((e) => Math.hypot(e.w!.x2 - e.w!.x1, e.w!.y2 - e.w!.y1) / U);
      for (const len of lengths) {
        expect(len).toBeGreaterThan(STUB - 0.001);
        expect(len).toBeLessThanOrEqual(STUB + 4); // MAX_LABEL_NUDGE
      }
      // and at least one of them actually moved
      expect(lengths.some((len) => len > STUB + 0.001)).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30000);
});
