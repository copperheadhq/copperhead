import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBoardLayout } from '../src/kicad/layout/layout.js';
import { resolveFreeroutingJar } from '../src/kicad/layout/freerouting.js';
import { runDrc } from '../src/kicad/cli.js';
import { hardViolations } from '../src/kicad/report.js';

/**
 * The board pipeline (issue #252) against a real design, not a fixture: populate
 * from the schematic netlist, place, route through Freerouting, and verify the
 * result is DRC-clean and fully routed.
 *
 * Gated twice, because it needs both halves of the real tooling:
 *   - a local KiCad corpus (default `/usr/share/kicad/demos`) to read a real
 *     `.kicad_sch` from, and
 *   - a Freerouting jar + JRE (the `COPPERHEAD_TEST_FREEROUTING_JAR` gate).
 *
 *   COPPERHEAD_TEST_CORPUS=1 COPPERHEAD_TEST_FREEROUTING_JAR=1 \
 *     COPPERHEAD_FREEROUTING_JAR=/path/to.jar \
 *     npx vitest run test/route-real-design.test.ts
 *
 * The golden `.kicad_pcb` is read in place and never modified. Nothing is
 * committed here; the comparison report lives under `manual-tests/runs/`.
 */

const CORPUS = process.env.COPPERHEAD_CORPUS_DIR ?? '/usr/share/kicad/demos';
const PROJECT = process.env.COPPERHEAD_ROUTE_PROJECT ?? 'complex_hierarchy';
const ENABLED =
  process.env.COPPERHEAD_TEST_CORPUS === '1' &&
  !!process.env.COPPERHEAD_TEST_FREEROUTING_JAR &&
  existsSync(CORPUS);

async function rootSchOf(dir: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => []);
  const pro = files.find((f) => f.endsWith('.kicad_pro'));
  if (pro) {
    const base = pro.replace(/\.kicad_pro$/, '.kicad_sch');
    return files.includes(base) ? path.join(dir, base) : null;
  }
  const any = files.find((f) => f.endsWith('.kicad_sch'));
  return any ? path.join(dir, any) : null;
}

describe.skipIf(!ENABLED)('board pipeline against a real design', () => {
  it('populates, routes, and passes DRC on a real KiCad project', async () => {
    const dir = path.join(CORPUS, PROJECT);
    const sch = await rootSchOf(dir);
    expect(sch, `no root schematic in ${dir}`).not.toBeNull();

    const work = await mkdtemp(path.join(tmpdir(), 'copperhead-route-real-'));
    const pcb = path.join(work, 'board.kicad_pcb');
    try {
      const res = await runBoardLayout({ schPath: sch!, pcbPath: pcb, route: true, jarPath: resolveFreeroutingJar() });

      // The load-bearing assertions: a real design must populate fully, route
      // without introducing hard violations, and leave nothing unrouted.
      expect(res.unresolved, `unresolved footprints: ${res.unresolved.map((u) => u.footprint).join(', ')}`).toEqual([]);
      expect(res.routed).toBe(true);
      expect(res.drcViolations).toBe(0);
      expect(res.unroutedNets).toBe(0);
      expect(res.rolledBack).toBe(false);

      // Independently re-check the on-disk board, so the report cannot drift
      // from the file.
      const drc = await runDrc(pcb);
      expect(hardViolations(drc)).toEqual([]);
      expect(drc.unrouted).toEqual([]);
      expect((await readFile(pcb, 'utf8')).includes('(segment ')).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 600_000);
});
