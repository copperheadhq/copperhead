import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import { checkLegibility } from '../src/kicad/legibility.js';
import { listSymbols, readSheetGeometry } from '../src/kicad/sexp.js';

/**
 * Idiom micro-templates and the alignment pass (tasks 7.5/7.5a): the small
 * structures a human drafter draws by reflex. Every test drafts a real IR and
 * asserts on the emitted file, then requires a clean error-severity checker
 * gate, so an idiom that "works" by breaking legibility cannot pass.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const DRAFT_FIXTURE = path.join(HERE, 'fixtures', 'draft');

async function draftRepo(intent: unknown, groups: string[]): Promise<{
  repo: string;
  schematicPath: string;
  syms: Awaited<ReturnType<typeof listSymbols>>;
  cleanup: () => Promise<void>;
}> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-idiom-'));
  const docs = path.join(repo, 'docs');
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, 'SUBSYSTEMS.md'), groups.map((g) => `## ${g}`).join('\n\n') + '\n', 'utf8');
  await writeFile(path.join(repo, 'schematic.intent.json'), JSON.stringify(intent), 'utf8');
  const res = await draftSchematic({
    repoRoot: repo,
    schematic: 'board.kicad_sch',
    intentPath: 'schematic.intent.json',
    docsDir: docs,
    symbolDirs: [SYMLIB],
  });
  if (!res.ok) throw new Error(res.message);
  const leg = await checkLegibility(res.schematicPath, { docsDir: docs });
  expect(
    leg.findings.filter((f) => f.severity === 'error'),
    JSON.stringify(leg.findings, null, 2),
  ).toEqual([]);
  const syms = await listSymbols(res.schematicPath);
  return { repo, schematicPath: res.schematicPath, syms, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

const at = (syms: { ref: string; at: { x: number; y: number } }[], ref: string): { x: number; y: number } => {
  const s = syms.find((y) => y.ref === ref);
  expect(s, `symbol ${ref} missing from the sheet`).toBeDefined();
  return s!.at;
};

describe('drop chains: series passives restack as one straight run (AC-16.31)', () => {
  it('a series RC from a pin to ground hangs collinear on the stub axis with uniform gaps', async () => {
    const { syms, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
          { ref: 'R1', libId: 'Device:R', value: '1k', group: 'Main' },
          { ref: 'C1', libId: 'Device:C', value: '100n', group: 'Main' },
        ],
        nets: [
          { name: 'SIGT', pins: ['U1.4', 'R1.1'] },
          { name: 'MID', pins: ['R1.2', 'C1.1'] },
          { name: 'GND', pins: ['C1.2', 'U1.2'] },
        ],
      },
      ['Main'],
    );
    try {
      const u1 = at(syms, 'U1');
      const r1 = at(syms, 'R1');
      const c1 = at(syms, 'C1');
      // shared axis: the anchor pin's stub-end x (U1.4 sits at +10.16, stub 2.54)
      expect(r1.x).toBeCloseTo(u1.x + 12.7, 5);
      expect(c1.x).toBeCloseTo(r1.x, 5);
      // connectivity order top-to-bottom, uniform gap between leads
      expect(r1.y).toBeLessThan(c1.y);
      // gaps are HANG_GAP (three units): an odd count keeps a hung part's stub
      // end between pin rows instead of on the neighbouring pin's row
      expect(c1.y - 3.81 - (r1.y + 3.81)).toBeCloseTo(3.81, 5); // C1 top lead sits one gap below R1 bottom lead
      // the run starts one gap below the anchor's stub end
      expect(r1.y - 3.81).toBeCloseTo(u1.y - 5.08 + 3.81, 5);
    } finally {
      await cleanup();
    }
  }, 30000);

  it('a pull-up stacks on the pin it pulls, rail above (7.5)', async () => {
    const { syms, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'Main' },
        ],
        nets: [
          { name: 'VCC', pins: ['R1.1', 'U1.1'] },
          { name: 'SIG', pins: ['R1.2', 'U1.3'] },
        ],
      },
      ['Main'],
    );
    try {
      const u1 = at(syms, 'U1');
      const r1 = at(syms, 'R1');
      // U1.3 sits at -10.16 with VCC and GND pins one row above and below it;
      // the pull-up rises from that pin (bottom lead above the row, rail
      // above the part) beside the IC, in the shelf slot past the stub: the
      // stub axis itself would run the chain's wire through U1.1's VCC stub,
      // a crossing a drafter moves the part to avoid (the older idiom lifted
      // the lead off U1.1's row but kept the crossing).
      expect(r1.x).toBeLessThan(u1.x - 12.7); // left of U1.3's stub end
      expect(r1.y + 3.81).toBeLessThan(u1.y); // bottom lead above the pin row
      expect(r1.y).toBeLessThan(u1.y);
    } finally {
      await cleanup();
    }
  }, 30000);

  it('a two-resistor divider between rails straightens onto one axis', async () => {
    const { syms, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'Div' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'Div' },
        ],
        nets: [
          { name: 'VCC', pins: ['R1.1', 'U1.1'] },
          { name: 'MID', pins: ['R1.2', 'R2.1'] },
          { name: 'GND', pins: ['R2.2', 'U1.2'] },
        ],
      },
      ['Main', 'Div'],
    );
    try {
      const r1 = at(syms, 'R1');
      const r2 = at(syms, 'R2');
      expect(r2.x).toBeCloseTo(r1.x, 5);
      expect(r1.y).toBeLessThan(r2.y);
      expect(r2.y - 3.81 - (r1.y + 3.81)).toBeCloseTo(5.08, 5); // CHAIN_GAP: a divider between rails is the chain idiom
    } finally {
      await cleanup();
    }
  }, 30000);

  it('a chain that would run down a column of foreign stub ends is refused, not shorted', async () => {
    // U1.5 (directly below the anchor U1.4 on the same side) carries its own
    // net, so its stub end sits exactly on the would-be chain axis. The pass
    // must leave the columns alone; the first version of this pass shorted 5V
    // into DRIVE on the npn-switch reference board in exactly this shape.
    const { syms, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
          { ref: 'J1', libId: 'CopperConn:Conn_01x03', value: 'Conn_01x03', group: 'Main' },
          { ref: 'R1', libId: 'Device:R', value: '1k', group: 'Main' },
          { ref: 'C1', libId: 'Device:C', value: '100n', group: 'Main' },
        ],
        nets: [
          { name: 'SIGT', pins: ['U1.4', 'R1.1'] },
          { name: 'MID', pins: ['R1.2', 'C1.1'] },
          { name: 'GND', pins: ['C1.2', 'U1.2'] },
          { name: 'BUSY', pins: ['U1.5', 'J1.1'] },
        ],
      },
      ['Main'],
    );
    try {
      const u1 = at(syms, 'U1');
      const r1 = at(syms, 'R1');
      // not on the stub axis: the idiom declined rather than merge SIGT/BUSY
      expect(Math.abs(r1.x - (u1.x + 12.7))).toBeGreaterThan(0.01);
    } finally {
      await cleanup();
    }
  }, 30000);
});

describe('crystal flanking: load caps mirror about the crystal (7.5)', () => {
  it('both caps sit at equal offsets and a common height', async () => {
    const { syms, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
          { ref: 'Y1', libId: 'Device:Crystal', value: '16MHz', group: 'Main' },
          { ref: 'C1', libId: 'Device:C', value: '22p', group: 'Main' },
          { ref: 'C2', libId: 'Device:C', value: '22p', group: 'Main' },
        ],
        nets: [
          { name: 'OSC1', pins: ['U1.4', 'Y1.1', 'C1.1'] },
          { name: 'OSC2', pins: ['U1.5', 'Y1.2', 'C2.1'] },
          { name: 'GND', pins: ['C1.2', 'C2.2', 'U1.2'] },
        ],
      },
      ['Main'],
    );
    try {
      const y1 = at(syms, 'Y1');
      const c1 = at(syms, 'C1');
      const c2 = at(syms, 'C2');
      expect(c1.y).toBeCloseTo(c2.y, 5); // common height
      expect(Math.abs(c1.x - y1.x)).toBeCloseTo(Math.abs(c2.x - y1.x), 5); // equal offsets, mirrored
      expect(c1.x).toBeLessThan(y1.x);
      expect(c2.x).toBeGreaterThan(y1.x);
      expect(c1.y).toBeGreaterThan(y1.y); // hanging below their crystal
    } finally {
      await cleanup();
    }
  }, 30000);
});

describe('alignment holds where the columns already provide it (7.5a pins)', () => {
  it('a decoupling row has uniform gaps and a common height', async () => {
    const { syms, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
          { ref: 'C1', libId: 'Device:C', value: '100n', group: 'Main' },
          { ref: 'C2', libId: 'Device:C', value: '100n', group: 'Main' },
          { ref: 'C3', libId: 'Device:C', value: '100n', group: 'Main' },
          { ref: 'C4', libId: 'Device:C', value: '100n', group: 'Main' },
        ],
        nets: [
          { name: 'VCC', pins: ['U1.1', 'C1.1', 'C2.1', 'C3.1', 'C4.1'] },
          { name: 'GND', pins: ['U1.2', 'C1.2', 'C2.2', 'C3.2', 'C4.2'] },
        ],
      },
      ['Main'],
    );
    try {
      const xs = ['C1', 'C2', 'C3', 'C4'].map((r) => at(syms, r).x);
      const ys = ['C1', 'C2', 'C3', 'C4'].map((r) => at(syms, r).y);
      expect(new Set(ys.map((y) => y.toFixed(4))).size).toBe(1); // common height
      const gaps = [xs[1]! - xs[0]!, xs[2]! - xs[1]!, xs[3]! - xs[2]!];
      expect(gaps[1]).toBeCloseTo(gaps[0]!, 5);
      expect(gaps[2]).toBeCloseTo(gaps[0]!, 5);
    } finally {
      await cleanup();
    }
  }, 30000);
});

describe('balanced sheet: content sits centered in the usable frame (7.5a)', () => {
  it('the reference board is horizontally balanced', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-balance-'));
    try {
      await cp(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
      await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const papers: Record<string, number> = { A5: 210, A4: 297, A3: 420, A2: 594, A1: 841, A0: 1189 };
      const w = papers[res.report.paper]!;
      // sheet-level group rectangles only; a raw regex would also match the
      // symbol-space rectangles inside lib_symbols
      const sheets = await readSheetGeometry(res.schematicPath);
      const rects = sheets[0]!.rectangles;
      expect(rects.length).toBeGreaterThan(0);
      const minX = Math.min(...rects.map((r) => Math.min(r.x1, r.x2)));
      const maxX = Math.max(...rects.map((r) => Math.max(r.x1, r.x2)));
      const left = minX - 10; // frame inset
      const right = w - 10 - maxX;
      // grid snapping costs at most a unit either side
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1.28);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30000);
});

describe('everything on its pin (AC-16.40 to AC-16.47)', () => {
  const attachedOf = async (schematicPath: string): Promise<{ attached: number; twoPin: number }> => {
    const sheets = await readSheetGeometry(schematicPath);
    const { measureWiringStyle } = await import('../src/kicad/score.js');
    const ws = measureWiringStyle(sheets);
    return { attached: ws.twoPinAttached, twoPin: ws.twoPin };
  };
  const pinAbs = async (schematicPath: string, ref: string, pin: string): Promise<{ x: number; y: number }> => {
    const { pinsOfUnit, pinAbsolute } = await import('../src/kicad/sexp.js');
    const sh = (await readSheetGeometry(schematicPath))[0]!;
    const s = sh.symbols.find((y) => y.ref === ref)!;
    const p = pinsOfUnit(sh.libPins.get(s.libId) ?? [], s.unit).find((q) => q.number === pin)!;
    return pinAbsolute(s.at, s.mirror, p);
  };

  it('a series resistor into a base ends the run with the transistor on the row, base to the pin (AC-16.42)', async () => {
    const { schematicPath, syms, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
          { ref: 'R1', libId: 'Device:R', value: '1k', group: 'Main' },
          { ref: 'Q1', libId: 'Device:Q_NPN', value: 'NPN', group: 'Main' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'Main' },
        ],
        nets: [
          { name: 'DRV', pins: ['U1.4', 'R1.1'] },
          { name: 'Q1_B', pins: ['R1.2', 'Q1.B'] },
          { name: 'LOAD', pins: ['Q1.C', 'R2.1'] },
          { name: 'VCC', pins: ['U1.1', 'R2.2'], kind: 'power' },
          { name: 'GND', pins: ['U1.2', 'Q1.E'], kind: 'ground' },
        ],
      },
      ['Main'],
    );
    try {
      const drive = await pinAbs(schematicPath, 'U1', '4');
      const base = await pinAbs(schematicPath, 'Q1', 'B');
      const r1far = await pinAbs(schematicPath, 'R1', '2');
      // the base sits on the driving pin's row, past the resistor, facing it
      expect(base.y).toBeCloseTo(drive.y, 5);
      expect(r1far.y).toBeCloseTo(drive.y, 5);
      expect(base.x).toBeGreaterThan(r1far.x);
      const q1 = syms.find((s) => s.ref === 'Q1')!;
      expect(q1.at.rot).toBe(0); // never turned: collector up, emitter down
      // a wire joins the resistor's far lead to the base along the row
      const sh = (await readSheetGeometry(schematicPath))[0]!;
      const onRow = sh.wires.filter((w) => Math.abs(w.y1 - drive.y) < 0.01 && Math.abs(w.y2 - drive.y) < 0.01);
      const reach = (x: number): boolean => onRow.some((w) => Math.min(w.x1, w.x2) <= x + 0.01 && Math.max(w.x1, w.x2) >= x - 0.01);
      expect(reach(r1far.x) && reach(base.x)).toBe(true);
      // the resistor lies on the row, turned; its fields still read horizontally (AC-16.44)
      const r1 = syms.find((s) => s.ref === 'R1')!;
      expect(r1.at.rot % 180).toBe(90);
      const text = await (await import('node:fs/promises')).readFile(schematicPath, 'utf8');
      expect(text).toMatch(/\(property "Reference" "R1" \(at [\d.]+ [\d.]+ 90\)/);
      expect(text).toMatch(/\(property "Value" "1k" \(at [\d.]+ [\d.]+ 90\)/);
      const r1props = sh.symbols.find((s) => s.ref === 'R1')!.props;
      for (const p of r1props) expect(Math.abs(p.rot % 180)).toBe(0); // measured as drawn
      // the collector's load stacks on the collector (chain pass), and every two-lead part is attached
      const { attached, twoPin } = await attachedOf(schematicPath);
      expect(twoPin).toBe(2);
      expect(attached).toBe(2);
    } finally {
      await cleanup();
    }
  }, 30000);

  it('a transistor driven from a left-hand pin is mirrored so its base faces the pin (AC-16.42)', async () => {
    const { schematicPath, syms, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
          { ref: 'Q1', libId: 'Device:Q_NPN', value: 'NPN', group: 'Main' },
        ],
        nets: [
          { name: 'DRV', pins: ['U1.3', 'Q1.B'] }, // U1.3: the input pin on the MCU's left
          { name: 'GND', pins: ['U1.2', 'Q1.E'], kind: 'ground' },
        ],
      },
      ['Main'],
    );
    try {
      const drive = await pinAbs(schematicPath, 'U1', '3');
      const base = await pinAbs(schematicPath, 'Q1', 'B');
      expect(base.y).toBeCloseTo(drive.y, 5);
      expect(base.x).toBeLessThan(drive.x);
      const text = await (await import('node:fs/promises')).readFile(schematicPath, 'utf8');
      expect(text).toMatch(/\(lib_id "Device:Q_NPN"\)\s*\(at [\d.]+ [\d.]+ 0\)\s*\(mirror y\)/);
      const u1 = syms.find((s) => s.ref === 'U1')!;
      void u1;
    } finally {
      await cleanup();
    }
  }, 30000);

  it('a shunt on the net past a series part hangs from the run\'s far end (AC-16.43)', async () => {
    const { schematicPath, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
          { ref: 'R1', libId: 'Device:R', value: '1k', group: 'Main' },
          { ref: 'C1', libId: 'Device:C', value: '100n', group: 'Main' },
          { ref: 'U2', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Other' },
        ],
        nets: [
          { name: 'SIG', pins: ['U1.4', 'R1.1'] },
          // three endpoints, the third in another group: a node past the
          // resistor that nothing in this group anchors but the run itself
          { name: 'FILT', pins: ['R1.2', 'C1.1', 'U2.3'] },
          { name: 'GND', pins: ['U1.2', 'C1.2', 'U2.2'], kind: 'ground' },
        ],
      },
      ['Main', 'Other'],
    );
    try {
      const r1far = await pinAbs(schematicPath, 'R1', '2');
      const c1top = await pinAbs(schematicPath, 'C1', '1');
      // the cap drops straight from the row's end, one stub past the far lead
      expect(c1top.x).toBeCloseTo(r1far.x + 2.54, 5);
      expect(c1top.y).toBeGreaterThan(r1far.y);
      const { attached, twoPin } = await attachedOf(schematicPath);
      expect(twoPin).toBe(2);
      expect(attached).toBe(2);
    } finally {
      await cleanup();
    }
  }, 30000);

  it('a switch anchors its pull-up and debounce cap in a group with no IC (AC-16.41)', async () => {
    const { schematicPath, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'SW1', libId: 'Device:SW_Push', value: 'BTN', group: 'Buttons' },
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'Buttons' },
          { ref: 'C1', libId: 'Device:C', value: '100n', group: 'Buttons' },
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
        ],
        nets: [
          { name: 'BTN', pins: ['SW1.1', 'R1.2', 'C1.1', 'U1.3'] },
          { name: 'VCC', pins: ['R1.1', 'U1.1'], kind: 'power' },
          { name: 'GND', pins: ['SW1.2', 'C1.2', 'U1.2'], kind: 'ground' },
        ],
      },
      ['Buttons', 'Main'],
    );
    try {
      const sw = await pinAbs(schematicPath, 'SW1', '1');
      const r1 = await pinAbs(schematicPath, 'R1', '2');
      const c1 = await pinAbs(schematicPath, 'C1', '1');
      // pull-up above the switch's row, cap below, on one axis: the divider on its pin
      expect(r1.y).toBeLessThan(sw.y);
      expect(c1.y).toBeGreaterThan(sw.y);
      expect(r1.x).toBeCloseTo(c1.x, 5);
      // the switch is a two-pin part too, wired to both through its pin
      const { attached, twoPin } = await attachedOf(schematicPath);
      expect(twoPin).toBe(3);
      expect(attached).toBe(3);
    } finally {
      await cleanup();
    }
  }, 30000);

  it('two pins with a pull-up and a pull-down each draft as level combs, every part wired (AC-16.40)', async () => {
    const { schematicPath, cleanup } = await draftRepo(
      {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'Main' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'Main' },
          { ref: 'R3', libId: 'Device:R', value: '10k', group: 'Main' },
          { ref: 'R4', libId: 'Device:R', value: '10k', group: 'Main' },
        ],
        nets: [
          { name: 'A', pins: ['U1.4', 'R1.2', 'R2.1'] },
          { name: 'B', pins: ['U1.5', 'R3.2', 'R4.1'] },
          { name: 'VCC', pins: ['U1.1', 'R1.1', 'R3.1'], kind: 'power' },
          { name: 'GND', pins: ['U1.2', 'R2.2', 'R4.2'], kind: 'ground' },
        ],
      },
      ['Main'],
    );
    try {
      const [r1, r2, r3, r4] = await Promise.all(['R1', 'R2', 'R3', 'R4'].map((r) => pinAbs(schematicPath, r, '1')));
      // one axis per pin; the two rises level with each other, the two drops level
      expect(r1!.x).toBeCloseTo((await pinAbs(schematicPath, 'R2', '1')).x, 5);
      expect(r3!.x).toBeCloseTo(r4!.x, 5);
      expect(r1!.y).toBeCloseTo(r3!.y, 5);
      expect(r2!.y).toBeCloseTo(r4!.y, 5);
      const { attached, twoPin } = await attachedOf(schematicPath);
      expect(twoPin).toBe(4);
      expect(attached).toBe(4);
    } finally {
      await cleanup();
    }
  }, 30000);
});
