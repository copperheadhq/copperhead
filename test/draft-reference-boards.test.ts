import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import { checkLegibility } from '../src/kicad/legibility.js';
import { runErc, probeKicadLoad } from '../src/kicad/cli.js';

/**
 * Reference boards (manual-tests/reference-boards/): committed reference projects with
 * symbols vendored from the REAL KiCad standard libraries. Hermetic by
 * construction — every draft resolves from the committed sym-lib-cache, never
 * from the machine's installed libraries — so the emitted bytes are identical
 * on any machine. ERC parsing is not version-independent: the cache vendors
 * whatever symbol format the KiCad that generated it spoke, so an incompatible
 * kicad-cli causes only the ERC assertion to be skipped with an actionable
 * reason. Regenerate references with `npm run refboards -- --update`.
 */

const CONTROL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'manual-tests', 'reference-boards');

describe('reference boards: the engine reproduces the committed pinned outputs', async () => {
  const boards = (await readdir(CONTROL, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

  for (const board of boards) {
    it(`${board}: byte-identical draft, clean ERC, clean legibility`, async (ctx) => {
      const src = path.join(CONTROL, board);
      const repo = await mkdtemp(path.join(tmpdir(), `copperhead-refboard-${board}-`));
      try {
        await cp(src, repo, { recursive: true });
        await rm(path.join(repo, 'reference'), { recursive: true, force: true });
        const config = JSON.parse(await readFile(path.join(src, '.copperhead', 'config.json'), 'utf8')) as {
          schematic: string;
        };
        const res = await draftSchematic({
          repoRoot: repo,
          schematic: config.schematic,
          docsDir: 'docs/',
          // no symbolDirs override: resolution MUST come from the committed cache
          symbolDirs: [],
        });
        expect(res.ok, res.ok ? '' : res.message).toBe(true);
        if (!res.ok) return;

        const reference = await readFile(path.join(src, 'reference', path.basename(config.schematic)), 'utf8');
        expect(res.text).toBe(reference);

        const leg = await checkLegibility(res.schematicPath, { docsDir: path.join(repo, 'docs') });
        expect(leg.findings.filter((f) => f.severity === 'error')).toEqual([]);

        // ERC is only meaningful if this kicad-cli can parse the committed
        // fixture. The reference boards vendor symbols from the real KiCad
        // libraries in the format of the KiCad that generated them; an older
        // kicad-cli rejects that format with an opaque "Failed to load
        // schematic" that reads like an engine bug when it is really a version
        // mismatch. Probe the committed reference (byte-identical to the draft
        // checked above): skip ERC on the canonical load failure, fail on any
        // unexpected probe error.
        const probe = await probeKicadLoad(path.join(src, 'reference', path.basename(config.schematic)));
        if (probe.status === 'unloadable') {
          ctx.skip(
            `installed kicad-cli cannot load the committed reference fixture (${probe.detail}); ` +
              `ERC is skipped because of a KiCad compatibility issue — run under a compatible KiCad version`,
          );
        } else if (probe.status === 'unexpected') {
          throw new Error(`unexpected kicad-cli load failure on the committed reference fixture: ${probe.detail}`);
        }

        const erc = await runErc(res.schematicPath);
        expect(erc.violations).toEqual([]);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }, 60000);
  }
});