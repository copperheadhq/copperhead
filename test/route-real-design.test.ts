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
  it('populates fully and either routes hard-clean or rolls back safely', async () => {
    const dir = path.join(CORPUS, PROJECT);
    const sch = await rootSchOf(dir);
    expect(sch, `no root schematic in ${dir}`).not.toBeNull();

    const work = await mkdtemp(path.join(tmpdir(), 'copperhead-route-real-'));
    const pcb = path.join(work, 'board.kicad_pcb');
    try {
      const res = await runBoardLayout({ schPath: sch!, pcbPath: pcb, route: true, jarPath: resolveFreeroutingJar() });

      // A real design must populate fully: every schematic footprint resolves
      // from the project's own libs plus the stock install.
      expect(res.unresolved, `unresolved footprints: ${res.unresolved.map((u) => u.footprint).join(', ')}`).toEqual([]);

      // Verification-gated out (AC-2.1): a board is never reported routed when
      // routing left hard violations. The default `complex_hierarchy` is a dense
      // 68-part THT board that even the connectivity-aware placer (#141 ordering,
      // see src/kicad/layout/placement.ts) cannot route hard-clean with
      // Freerouting — the router leaves solder-mask bridges and optimizer shorts
      // on a dense through-hole board — so the pipeline must roll back to the
      // placed ratsnest rather than claim a clean route. A simpler project that
      // routes clean keeps `routed` true with zero violations.
      if (res.routed) {
        expect(res.drcViolations).toBe(0);
        expect(res.unroutedNets).toBe(0);
        expect(res.rolledBack).toBe(false);
      } else {
        expect(res.rolledBack).toBe(true);
        expect(res.drcViolations).toBeGreaterThan(0);
      }

      // Independently re-check the on-disk board, so the report cannot drift
      // from the file. Either outcome must leave a hard-clean board: the routed
      // board when clean, or the rolled-back ratsnest when not.
      const drc = await runDrc(pcb);
      expect(hardViolations(drc)).toEqual([]);
      const onDisk = await readFile(pcb, 'utf8');
      expect(onDisk.includes('(segment ')).toBe(res.routed);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 600_000);
});
