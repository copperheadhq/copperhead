import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import { checkLegibility } from '../src/kicad/legibility.js';
import { runErc } from '../src/kicad/cli.js';
import { readSheetGeometry } from '../src/kicad/sexp.js';

/**
 * Op-amp stages drafted the way a drafter draws them (AC-16.39, AC-16.73 to
 * AC-16.80). Fixtures are hermetic: symbols resolve from each fixture's
 * committed sym-lib-cache, never the installed libraries.
 */

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'draft-opamp');

async function draft(name: string) {
  const repo = await mkdtemp(path.join(tmpdir(), `copperhead-opamp-${name}-`));
  await cp(path.join(FIX, name), repo, { recursive: true });
  const res = await draftSchematic({ repoRoot: repo, schematic: 'c.kicad_sch', docsDir: 'docs/', symbolDirs: [] });
  if (!res.ok) throw new Error(res.message);
  const [sheet] = await readSheetGeometry(res.schematicPath);
  const sym = (ref: string) => sheet!.symbols.find((s) => s.ref === ref)!;
  return { repo, res, sheet: sheet!, sym };
}

describe('op-amp stages (AC-16.73 to AC-16.80)', () => {
  const cases: [string, boolean][] = [
    ['p18-inverting-amplifier', true],
    ['p58-summing-integrator', true],
    ['p56-simple-integrator', true],
    ['p15-voltage-follower', false],
    ['p53-non-inverting-amplifier', false],
    // an analog switch across the feedback resistor is neither feedback nor
    // an input: the switched-gain stage stays non-inverting side up
    ['p53-switched-gain', false],
  ];
  for (const [name, mirrored] of cases) {
    it(`${name}: ${mirrored ? 'inverting input on top' : 'library orientation kept'}, ERC and legibility clean`, async () => {
      const { repo, res, sym } = await draft(name);
      try {
        // AC-16.73: a summing junction turns the amplifier over; a follower or
        // non-inverting stage keeps the symbol's orientation
        expect(sym('U1').mirror === 'x').toBe(mirrored);
        // AC-16.74/75/79: no supply symbol on a feedback part, no wire across a
        // lead, no dangling wire end; ERC sees none of it
        const erc = await runErc(res.schematicPath);
        expect(erc.violations).toEqual([]);
        const leg = await checkLegibility(res.schematicPath, { docsDir: path.join(repo, 'docs') });
        expect(leg.findings.filter((f) => f.severity === 'error')).toEqual([]);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }, 60000);
  }

  it('a summer stacks its inputs on rows of their own, terminals at the ends (AC-16.39, AC-16.76)', async () => {
    const { repo, sym } = await draft('p58-summing-integrator');
    try {
      const [r1, r2, r3] = ['R1', 'R2', 'R3'].map(sym);
      // fan-in: three rows, reference order top to bottom, one column
      expect(r1!.at.y).toBeLessThan(r2!.at.y);
      expect(r2!.at.y).toBeLessThan(r3!.at.y);
      expect(new Set([r1!.at.x, r2!.at.x, r3!.at.x]).size).toBe(1);
      // each input's terminal lies straight before its resistor, on its row
      for (const [tp, r] of [['TP1', r1], ['TP2', r2], ['TP3', r3]] as const) {
        expect(Math.abs(sym(tp).at.y - r!.at.y)).toBeLessThan(0.01);
        expect(sym(tp).at.x).toBeLessThan(r!.at.x);
      }
      // the output terminal is right of the amplifier; the rail probes stand
      // past everything else in the group
      expect(sym('TP5').at.x).toBeGreaterThan(sym('U1').at.x);
      const others = ['J1', 'R1', 'R2', 'R3', 'C1', 'SW1', 'U1', 'TP1', 'TP2', 'TP3', 'TP5'].map((r) => sym(r).at.x);
      for (const probe of ['TP4', 'TP6']) expect(sym(probe).at.x).toBeGreaterThan(Math.max(...others));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 60000);
});
