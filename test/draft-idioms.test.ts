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
      expect(c1.y - 3.81 - (r1.y + 3.81)).toBeCloseTo(5.08, 5); // C1 top lead sits one gap below R1 bottom lead
      // the run starts one gap below the anchor's stub end
      expect(r1.y - 3.81).toBeCloseTo(u1.y - 5.08 + 5.08, 5);
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
      // U1.3 sits at -10.16; its stub extends left 2.54, and the pull-up sits
      // directly on that axis, lifted one grid row past the plain gap: the
      // one-gap position parks R1's bottom lead on U1.1's pin row, where the
      // VCC power stub runs straight through the pulled SIG node (I22, #204).
      // The bounded lift keeps the idiom and clears the contact.
      expect(r1.x).toBeCloseTo(u1.x - 12.7, 5);
      expect(r1.y + 3.81).toBeCloseTo(u1.y - 7.62, 5); // bottom lead one gap plus one lift above the stub end
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
      expect(r2.y - 3.81 - (r1.y + 3.81)).toBeCloseTo(5.08, 5);
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
