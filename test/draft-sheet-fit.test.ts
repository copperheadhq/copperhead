import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { draftSchematicPlacement } from '../src/kicad/draft/engine.js';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import { readSheetGeometry } from '../src/kicad/sexp.js';
import { CAPTION_SIZE } from '../src/kicad/emit.js';
import { measureWiringStyle } from '../src/kicad/score.js';

/**
 * The paper pass as a gate: the sheet the engine picks is the smallest one
 * that holds the content once tall groups are re-rowed, the decoupling bank
 * counts toward a group's height like everything else, and whenever the
 * chosen sheet is mostly air the report says why. Before this, a 286-symbol
 * board drafted as one ribbon on A0 at 7% ink utilization with an empty notes
 * list: the bank sat outside the column budget, so the compaction retries
 * could not shorten the tallest group, and the failure was silent.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const CONTROL = path.join(HERE, '..', 'manual-tests', 'reference-boards');
const PAPER_DIMS: Record<string, { w: number; h: number }> = {
  A5: { w: 210, h: 148 },
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
  A1: { w: 841, h: 594 },
  A0: { w: 1189, h: 841 },
};
const FRAME = 10;
/** The legibility checker's low-utilization floor and the engine's compaction trigger. */
const UTILIZATION_FLOOR = 0.5;

async function place(intent: SchematicIntent) {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-sheetfit-'));
  try {
    const v = await validateIntent(intent, new SymbolSource(repo, [SYMLIB]), null);
    expect(v.ok, v.findings.map((f) => f.detail).join('; ')).toBe(true);
    return draftSchematicPlacement(v.validated!, 'board', '2020-01-01');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

function expectInsideFrame(model: { paper: string; symbols: { ref: string; at: { x: number; y: number } }[] }) {
  const paper = PAPER_DIMS[model.paper]!;
  for (const s of model.symbols) {
    expect(s.at.x, `${s.ref} outside the frame`).toBeGreaterThanOrEqual(FRAME);
    expect(s.at.x, `${s.ref} outside the frame`).toBeLessThanOrEqual(paper.w - FRAME);
    expect(s.at.y, `${s.ref} outside the frame`).toBeGreaterThanOrEqual(FRAME);
    expect(s.at.y, `${s.ref} outside the frame`).toBeLessThanOrEqual(paper.h - FRAME);
  }
}

/** N MCUs on shared rails plus a decoupling bank of `caps` capacitors, all in one group. */
function mcusWithBank(n: number, caps: number): SchematicIntent {
  const parts = [];
  const noConnect: string[] = [];
  for (let i = 1; i <= n; i++) {
    parts.push({ ref: `U${i}`, libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' });
    for (const p of ['3', '4', '5', '6', '7', '8']) noConnect.push(`U${i}.${p}`);
  }
  for (let i = 1; i <= caps; i++) parts.push({ ref: `C${i}`, libId: 'Device:C', value: '100n', group: 'MAIN' });
  const nets = [
    { name: 'VCC', pins: [...Array.from({ length: n }, (_, i) => `U${i + 1}.1`), ...Array.from({ length: caps }, (_, i) => `C${i + 1}.1`)] },
    { name: 'GND', pins: [...Array.from({ length: n }, (_, i) => `U${i + 1}.2`), ...Array.from({ length: caps }, (_, i) => `C${i + 1}.2`)] },
  ];
  return { version: 1, parts, nets, noConnect };
}

/** N MCUs sharing only power rails: every one lands at the same layer depth,
 * so without balancing the group drafts as ONE full-height column (the shape
 * the compaction test in draft-layout.test.ts starts from). Nothing here is a
 * two-pin part, so no bank or idiom template moves a cell. */
function stack(n: number, paper?: string): SchematicIntent {
  const parts = [];
  const noConnect: string[] = [];
  for (let i = 1; i <= n; i++) {
    parts.push({ ref: `U${i}`, libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' });
    for (const p of ['3', '4', '5', '6', '7', '8']) noConnect.push(`U${i}.${p}`);
  }
  const nets = [
    { name: 'VCC', pins: Array.from({ length: n }, (_, i) => `U${i + 1}.1`) },
    { name: 'GND', pins: Array.from({ length: n }, (_, i) => `U${i + 1}.2`) },
  ];
  // a paper hint pins the sheet and skips compaction, so a hinted stack
  // isolates the in-group balance from the sheet budget's own column split
  return paper ? { version: 1, parts, nets, noConnect, hints: { paper } } : { version: 1, parts, nets, noConnect };
}

describe('the decoupling bank counts against the sheet budget', () => {
  it('lands a bank-heavy group on the sheet its cells need, not the one its bank rows forced', async () => {
    // Four MCUs and 24 caps: the columns are short, the bank is six rows at
    // the circuit's width. With the bank outside the budget this drafted on
    // A2 with no note; the cells ink about a third of A4.
    const { model, report } = await place(mcusWithBank(4, 24));
    expect(['A5', 'A4'], report.notes.join('; ')).toContain(report.paper);
    expect(report.sheetFit.paper).toBe(report.paper);
    expectInsideFrame(model);
  });

  it('shortens a group whose bank, not its columns, overflowed the budget', async () => {
    // Two MCUs and 30 caps: nothing to split in the columns, so only the
    // bank widening can make a smaller sheet hold it.
    const { model, report } = await place(mcusWithBank(2, 30));
    expect(['A5', 'A4'], report.notes.join('; ')).toContain(report.paper);
    expectInsideFrame(model);
  });
});

describe('a failed compaction is reported, never silent', () => {
  it('names each smaller sheet and how far the reflowed content missed it', async () => {
    const { report } = await place(mcusWithBank(4, 24));
    if (report.sheetFit.compaction === 'failed') {
      expect(report.sheetFit.misses.length).toBeGreaterThan(0);
      for (const m of report.sheetFit.misses) expect(m).toMatch(/^A[0-5] \d+×\d+ mm vs \d+×\d+ usable$/);
      const note = report.notes.find((n) => /^sheet not compacted:/.test(n));
      expect(note, report.notes.join('; ')).toBeDefined();
      for (const m of report.sheetFit.misses) expect(note).toContain(m);
    } else {
      expect(report.sheetFit.compaction).toBe('compacted');
      expect(report.notes.some((n) => /^sheet compacted:/.test(n))).toBe(true);
    }
  });

  it('gate: a sheet inked below the floor always carries a compaction verdict with a note behind it', async () => {
    const fixtures: [string, SchematicIntent][] = [
      ['mcus+bank 4/24', mcusWithBank(4, 24)],
      ['mcus+bank 2/30', mcusWithBank(2, 30)],
      ['mcus+bank 8/40', mcusWithBank(8, 40)],
      ['stack 12', stack(12)],
    ];
    for (const [name, intent] of fixtures) {
      const { report } = await place(intent);
      const sf = report.sheetFit;
      expect(sf.inkUtilization, name).toBeGreaterThan(0);
      expect(sf.inkUtilization, name).toBeLessThanOrEqual(1);
      expect(sf.compaction, name).not.toBe('overflow');
      // A5 is the floor: nothing smaller exists to compact onto
      if (sf.inkUtilization < UTILIZATION_FLOOR && sf.paper !== 'A5') {
        expect(['compacted', 'failed', 'banded'], `${name}: ${sf.paper} at ${Math.round(sf.inkUtilization * 100)}% with no verdict`).toContain(sf.compaction);
        expect(report.notes.some((n) => /^sheet (not )?compacted:|was wider than the sheet/.test(n)), `${name}: ${report.notes.join('; ')}`).toBe(true);
      }
    }
  });
});

describe('in-group column balance', () => {
  /** Distinct column axes the given refs sit on, and the largest count on one axis. */
  const columnsOf = (model: { symbols: { ref: string; at: { x: number } }[] }, refs: RegExp) => {
    const byX = new Map<number, number>();
    for (const s of model.symbols.filter((s) => refs.test(s.ref))) byX.set(s.at.x, (byX.get(s.at.x) ?? 0) + 1);
    return { axes: byX.size, tallest: Math.max(...byX.values()) };
  };

  it('re-rows a tall same-depth column into columns no taller than the group needs', async () => {
    // 16 cells that would stack to ~4x the group's square side: the balance
    // deals them into side-by-side columns before any sheet is chosen, so
    // the natural fit is already a small sheet
    const { model, report } = await place(stack(16, 'A3'));
    expect(report.sheetFit.compaction).toBe('pinned');
    const cols = columnsOf(model, /^U\d+$/);
    expect(cols.axes, `cells on ${cols.axes} column axes`).toBeGreaterThanOrEqual(3);
    expect(cols.tallest).toBeLessThanOrEqual(6);
    expectInsideFrame(model);
  });

  it('leaves a short column alone', async () => {
    // three parts are not worth re-rowing: the column stays a column
    const { model, report } = await place(stack(3, 'A4'));
    expect(report.sheetFit.compaction).toBe('pinned');
    expect(columnsOf(model, /^U\d+$/).axes).toBe(1);
  });

  it('keeps every chunk in declared row order', async () => {
    // chunks are consecutive runs of the original column, so a reader still
    // scans the group top-to-bottom then left-to-right
    const { model } = await place(stack(16, 'A3'));
    const cells = model.symbols.filter((s) => /^U\d+$/.test(s.ref)).map((s) => ({ n: Number(s.ref.slice(1)), x: s.at.x, y: s.at.y }));
    const axes = [...new Set(cells.map((r) => r.x))].sort((a, b) => a - b);
    let last = 0;
    for (const x of axes) {
      const col = cells.filter((r) => r.x === x).sort((a, b) => a.y - b.y);
      for (const r of col) {
        expect(r.n, `U${r.n} out of order at x=${x}`).toBeGreaterThan(last);
        last = r.n;
      }
    }
  });
});

describe('the IC leads its group', () => {
  /** Draft a committed reference board from its own symbol cache. */
  async function draftBoard(board: string) {
    const repo = await mkdtemp(path.join(tmpdir(), `copperhead-icfirst-${board}-`));
    try {
      await cp(path.join(CONTROL, board), repo, { recursive: true });
      const intent = JSON.parse(await readFile(path.join(repo, 'schematic.intent.json'), 'utf8')) as SchematicIntent;
      const v = await validateIntent(intent, new SymbolSource(repo, []), path.join(repo, 'docs'));
      expect(v.ok, `${board}: ${v.findings.map((f) => f.detail).join('; ')}`).toBe(true);
      return { intent, ...draftSchematicPlacement(v.validated!, board, '2020-01-01') };
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  it('puts the converter at the top-left of its group with the passives fanned to its right', async () => {
    // Edges are stored refdes-ordered and C, D, L, R sort before U, so plain
    // propagation used to push the IC to the deepest column on the right.
    const { intent, model } = await draftBoard('buck-12v-5v');
    const members = intent.parts.filter((p) => p.group === 'Converter').map((p) => p.ref);
    const at = (ref: string) => model.symbols.find((s) => s.ref === ref)!.at;
    const u1 = at('U1');
    // symbol origins are body centres: a passive in the IC's own top row has
    // a centre above the IC's, so "top" is the IC's row, not its origin. A
    // part hung on one of the IC's left pins (the compensation network on
    // COMP) sits left of it by design, within the shelf the IC reserves.
    const rowTolerance = 15;
    // the left shelf holds the IC's left-facing labels plus a slot per hang
    const shelf = 80;
    for (const ref of members.filter((r) => r !== 'U1')) {
      expect(at(ref).x, `${ref} far left of U1`).toBeGreaterThan(u1.x - shelf);
      // a pull-up hung on a pin rises above the row; anything else stays at
      // or below the IC's row
      const hungUp = model.wires.some((w) => Math.abs(w.x1 - w.x2) < 0.01 && Math.abs(w.x1 - at(ref).x) < 0.01 && Math.max(w.y1, w.y2) <= u1.y + rowTolerance);
      if (!hungUp) expect(at(ref).y, `${ref} above U1's row`).toBeGreaterThanOrEqual(u1.y - rowTolerance);
    }
    void rowTolerance;
    // nothing sits more than a row above the IC except a pull-up rising
    // from one of its pins, and nothing sits left of it except what hangs
    // on its left pins: the converter's COMP and RT networks are exactly
    // that, and belong there (the sheet the client drew puts them there)
  });

  it('keeps the connector column to the left of the IC', async () => {
    // inputs still enter from the left: a connector stays at depth 0
    const { model } = await draftBoard('usb-atmega-node');
    const at = (ref: string) => model.symbols.find((s) => s.ref === ref)!.at;
    expect(at('J1').x).toBeLessThan(at('U2').x); // Power Input's USB jack, Regulation's LDO
    expect(at('J1').x).toBeLessThan(at('U1').x); // and the MCU
  });
});

describe('group boxes enclose their text', () => {
  /** Text box at KiCad's plotted stroke-font advance (about 0.72 of the
   * height; 0.8 here, the engine's reserve), so "inside the box" means on
   * paper, not only under the checker's deliberately narrow metric. */
  const ADV = 0.8;
  const H = 1.27;
  const labelBox = (l: { name: string; x: number; y: number; rot: number }) => {
    const w = Math.max(1, l.name.length) * ADV * H;
    return l.rot === 180 ? { minX: l.x - w, maxX: l.x, minY: l.y - H / 2, maxY: l.y + H / 2 } : { minX: l.x, maxX: l.x + w, minY: l.y - H / 2, maxY: l.y + H / 2 };
  };
  const fieldBox = (t: string, x: number, y: number) => {
    const w = Math.max(1, t.length) * ADV * H;
    return { minX: x - w / 2, maxX: x + w / 2, minY: y - H / 2, maxY: y + H / 2 };
  };
  type B = { minX: number; maxX: number; minY: number; maxY: number };
  const crosses = (b: B, r: B): boolean => {
    const inside = b.minX >= r.minX - 0.01 && b.maxX <= r.maxX + 0.01 && b.minY >= r.minY - 0.01 && b.maxY <= r.maxY + 0.01;
    const outside = b.maxX <= r.minX + 0.01 || b.minX >= r.maxX - 0.01 || b.maxY <= r.minY + 0.01 || b.minY >= r.maxY - 0.01;
    return !inside && !outside;
  };

  async function draftBoard(board: string) {
    const repo = await mkdtemp(path.join(tmpdir(), `copperhead-enclose-${board}-`));
    try {
      await cp(path.join(CONTROL, board), repo, { recursive: true });
      const intent = JSON.parse(await readFile(path.join(repo, 'schematic.intent.json'), 'utf8')) as SchematicIntent;
      const v = await validateIntent(intent, new SymbolSource(repo, []), path.join(repo, 'docs'));
      expect(v.ok, `${board}: ${v.findings.map((f) => f.detail).join('; ')}`).toBe(true);
      return draftSchematicPlacement(v.validated!, board, '2020-01-01');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  it('gate: no label or field text crosses a group box edge on any reference board', async () => {
    const boards = (await readdir(CONTROL, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const board of boards) {
      const { model } = await draftBoard(board);
      const rects = model.rectangles.map((r) => ({ name: r.name, minX: Math.min(r.x1, r.x2), maxX: Math.max(r.x1, r.x2), minY: Math.min(r.y1, r.y2), maxY: Math.max(r.y1, r.y2) }));
      const offenders: string[] = [];
      for (const l of model.labels) for (const r of rects) if (crosses(labelBox(l), r)) offenders.push(`label ${l.name} vs "${r.name}"`);
      for (const s of model.symbols) {
        if (s.ref.startsWith('#')) continue;
        for (const r of rects) {
          if (crosses(fieldBox(s.ref, s.refAt.x, s.refAt.y), r)) offenders.push(`${s.ref} reference vs "${r.name}"`);
          if (crosses(fieldBox(s.value, s.valueAt.x, s.valueAt.y), r)) offenders.push(`${s.ref} value vs "${r.name}"`);
        }
      }
      expect(offenders, `${board}: ${offenders.join('; ')}`).toEqual([]);
      // and the boxes still keep clear of one another
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i]!;
          const b = rects[j]!;
          const apart = a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY;
          expect(apart, `${board}: "${a.name}" overlaps "${b.name}"`).toBe(true);
        }
      }
    }
  }, 60000);
});

describe('text keeps clear of text at paper width', () => {
  const ADV = 0.8;
  const H = 1.27;
  type B = { minX: number; maxX: number; minY: number; maxY: number };
  const centred = (t: string, x: number, y: number): B => {
    const w = Math.max(1, t.length) * ADV * H;
    return { minX: x - w / 2, maxX: x + w / 2, minY: y - H / 2, maxY: y + H / 2 };
  };
  const labelled = (l: { name: string; x: number; y: number; rot: number }): B => {
    const w = Math.max(1, l.name.length) * ADV * H;
    return l.rot === 180 ? { minX: l.x - w, maxX: l.x, minY: l.y - H / 2, maxY: l.y + H / 2 } : { minX: l.x, maxX: l.x + w, minY: l.y - H / 2, maxY: l.y + H / 2 };
  };
  const overlap = (a: B, b: B): boolean => a.minX < b.maxX - 0.05 && b.minX < a.maxX - 0.05 && a.minY < b.maxY - 0.05 && b.minY < a.maxY - 0.05;

  it('gate: no two text items overlap on any reference board', async () => {
    const boards = (await readdir(CONTROL, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const board of boards) {
      const repo = await mkdtemp(path.join(tmpdir(), `copperhead-textclear-${board}-`));
      try {
        await cp(path.join(CONTROL, board), repo, { recursive: true });
        const intent = JSON.parse(await readFile(path.join(repo, 'schematic.intent.json'), 'utf8')) as SchematicIntent;
        const v = await validateIntent(intent, new SymbolSource(repo, []), path.join(repo, 'docs'));
        expect(v.ok, `${board}: ${v.findings.map((f) => f.detail).join('; ')}`).toBe(true);
        const { model } = draftSchematicPlacement(v.validated!, board, '2020-01-01');
        const items: { name: string; b: B }[] = [];
        for (const l of model.labels) items.push({ name: `label ${l.name}`, b: labelled(l) });
        for (const s of model.symbols) {
          if (!s.hideRef) items.push({ name: `${s.ref} ref`, b: centred(s.ref, s.refAt.x, s.refAt.y) });
          if (!s.hideValue) items.push({ name: `${s.ref} "${s.value}"`, b: centred(s.value, s.valueAt.x, s.valueAt.y) });
        }
        for (const c of model.captions) {
          const w = Math.max(1, c.text.length) * ADV * CAPTION_SIZE;
          items.push({ name: `caption "${c.text}"`, b: { minX: c.x, maxX: c.x + w, minY: c.y, maxY: c.y + CAPTION_SIZE } });
        }
        const pairs: string[] = [];
        for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (overlap(items[i]!.b, items[j]!.b)) pairs.push(`${items[i]!.name} × ${items[j]!.name}`);
        expect(pairs, `${board}: ${pairs.join('; ')}`).toEqual([]);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
  }, 60000);
});

describe('pin-anchored hangs (#220 phase 3)', () => {
  /** Draft a committed reference board to text and measure how its parts connect. */
  async function measured(board: string) {
    const repo = await mkdtemp(path.join(tmpdir(), `copperhead-hang-${board}-`));
    try {
      await cp(path.join(CONTROL, board), repo, { recursive: true });
      const config = JSON.parse(await readFile(path.join(repo, '.copperhead', 'config.json'), 'utf8')) as { schematic: string; docs: string };
      const res = await draftSchematic({ repoRoot: repo, schematic: config.schematic, intentPath: 'schematic.intent.json', docsDir: config.docs });
      expect(res.ok, `${board}: ${res.ok ? '' : res.message}`).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      const sheets = await readSheetGeometry(res.schematicPath);
      return { ws: measureWiringStyle(sheets), report: res.report, sheets };
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  it('gate: the reference boards attach their two-pin parts at least this well', async () => {
    // a person attaches 0.90 to 1.00 (research/GOOD-SCHEMATIC.md); these
    // floors are where the engine stands with hangs and no rotation, so a
    // regression shows and progress can raise them
    // raised with each placement pass: connectors and switches now anchor
    // hangs and a transistor ends the run that drives it (npn-switch 0.25 to
    // 0.57, usb-atmega-node 0.71 to 0.88)
    const floors: Record<string, number> = { 'buck-12v-5v': 0.55, 'ldo-demo': 0.8, 'usb-atmega-node': 0.85, 'npn-switch': 0.55 };
    for (const [board, floor] of Object.entries(floors)) {
      const { ws } = await measured(board);
      const attached = ws.twoPin ? ws.twoPinAttached / ws.twoPin : 1;
      expect(attached, `${board}: ${ws.twoPinAttached}/${ws.twoPin} attached`).toBeGreaterThanOrEqual(floor);
      expect(ws.twoPinIslands / Math.max(1, ws.twoPin), `${board}: islands`).toBeLessThanOrEqual(0.1);
    }
  }, 120000);

  it('hangs the compensation network on the converter\'s COMP pin and wires it', async () => {
    // buck-12v-5v: R4 + C5 in series and C6 shunt on U1.6. Hung, all three
    // sit within wire span of the pin, so COMP draws as one wired net with a
    // single label, and the merged-net guard says the trunk touched nothing
    const { report, sheets } = await measured('buck-12v-5v');
    expect(report.mergedNets).toEqual([]);
    const labels = sheets[0]!.labels.filter((l) => l.name === 'COMP');
    expect(labels.length, 'COMP labels').toBe(1);
    expect(report.notes.filter((n) => /^hang refused/.test(n))).toEqual([]);
  }, 60000);

  it('lays a series part on its pin\'s row, turned to face the pin, and wires it (AC-16.36, AC-16.37)', async () => {
    // buck-12v-5v: the bootstrap cap C4 between BOOT and SW and the output
    // inductor L1 on SW are series elements and lie on their rows; the
    // library cap is vertical, so it is drawn rotated. The Schottky D1, a
    // horizontal-pinned diode to ground, turns upright to hang.
    const { sheets, report } = await measured('buck-12v-5v');
    expect(report.mergedNets).toEqual([]);
    const sh = sheets[0]!;
    const rotated = sh.symbols.filter((s) => !s.isPower && s.at.rot !== 0);
    expect(rotated.map((s) => s.ref).sort(), 'rotated parts').toEqual(expect.arrayContaining(['C4', 'D1']));
    // every rotated two-lead part has at least one lead wired straight to another part
    const ws = measureWiringStyle(sheets);
    expect(ws.twoPinAttached).toBeGreaterThan(0);
  }, 60000);

  it('a hang the clearance check refuses is reported, never silently dropped', async () => {
    // usb-atmega-node: the two pull-ups on the MCU's VSENSE pin cannot both
    // sit on that row cleanly today; the report says so by name
    const { report } = await measured('usb-atmega-node');
    for (const n of report.notes.filter((x) => /^hang refused/.test(x))) expect(n).toMatch(/could not be placed cleanly on U\d+\.\d+ in "MCU"; drawn in a column instead$/);
  }, 60000);
});

describe('nets are coloured by function', () => {
  it('colours a signal family together, rails and grounds by class, and leaves a lone signal alone', async () => {
    // usb-atmega-node: ISP_MISO/MOSI/SCK and UART_RX/TX are families; AREF
    // stands alone; +3V3 is a rail and GND a ground
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-colour-'));
    try {
      await cp(path.join(CONTROL, 'usb-atmega-node'), repo, { recursive: true });
      const intent = JSON.parse(await readFile(path.join(repo, 'schematic.intent.json'), 'utf8')) as SchematicIntent;
      const v = await validateIntent(intent, new SymbolSource(repo, []), path.join(repo, 'docs'));
      expect(v.ok).toBe(true);
      const { model } = draftSchematicPlacement(v.validated!, 'usb-atmega-node', '2020-01-01');
      const c = model.netColors!;
      expect(c.ISP_MISO).toBeDefined();
      expect(c.ISP_MISO).toEqual(c.ISP_MOSI);
      expect(c.ISP_MISO).toEqual(c.ISP_SCK);
      expect(c.UART_RX).toEqual(c.UART_TX);
      expect(c.UART_RX).not.toEqual(c.ISP_MISO);
      expect(c.AREF).toBeUndefined();
      expect(c['+3V3']).toEqual([170, 30, 30]);
      expect(c.GND).toEqual([70, 70, 70]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('reference boards pass the sheet-fit gate', () => {
  it('every committed board explains its paper when it inks less than the floor', async () => {
    const boards = (await readdir(CONTROL, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(boards.length).toBeGreaterThan(0);
    for (const board of boards) {
      const repo = await mkdtemp(path.join(tmpdir(), `copperhead-sheetfit-${board}-`));
      try {
        await cp(path.join(CONTROL, board), repo, { recursive: true });
        const intent = JSON.parse(await readFile(path.join(repo, 'schematic.intent.json'), 'utf8')) as SchematicIntent;
        const v = await validateIntent(intent, new SymbolSource(repo, []), path.join(repo, 'docs'));
        expect(v.ok, `${board}: ${v.findings.map((f) => f.detail).join('; ')}`).toBe(true);
        const { report } = draftSchematicPlacement(v.validated!, board, '2020-01-01');
        const sf = report.sheetFit;
        expect(sf.compaction, board).not.toBe('overflow');
        if (sf.inkUtilization < UTILIZATION_FLOOR && sf.paper !== 'A5') {
          expect(['compacted', 'failed', 'banded'], `${board}: ${sf.paper} at ${Math.round(sf.inkUtilization * 100)}%`).toContain(sf.compaction);
          expect(report.notes.some((n) => /^sheet (not )?compacted:|was wider than the sheet/.test(n)), `${board}: ${report.notes.join('; ')}`).toBe(true);
        }
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
  }, 60000);
});
