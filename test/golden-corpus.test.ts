import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checkLegibility } from '../src/kicad/legibility.js';
import { scoreSchematic } from '../src/kicad/score.js';
import { draftSchematic } from '../src/kicad/draft/draft.js';

/**
 * The three-tier golden benchmark corpus (design D8).
 *
 * - Tier A (known-good): zero error findings and a composite at/above the
 *   pinned floor — the standing false-positive net for checker and scorer.
 * - Tier B (known-bad): the exact finding list and a composite at/below the
 *   pinned ceiling — the detection-regression net.
 * - Tier C (engine output): byte-identical drafted schematic and its exact
 *   score — the engine-regression and determinism net.
 *
 * Goldens change ONLY via `COPPERHEAD_UPDATE_GOLDENS=1 npm test` — the diff is
 * the review artifact. A mismatch without the flag fails; nothing is written.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures', 'golden');
const UPDATE = process.env.COPPERHEAD_UPDATE_GOLDENS === '1';

async function goldenJson<T>(name: string, actual: T): Promise<T> {
  const p = path.join(GOLDEN, name);
  if (UPDATE) {
    await mkdir(GOLDEN, { recursive: true });
    await writeFile(p, JSON.stringify(actual, null, 2) + '\n', 'utf8');
    return actual;
  }
  expect(existsSync(p), `golden ${name} missing — run COPPERHEAD_UPDATE_GOLDENS=1 npm test`).toBe(true);
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

describe('golden corpus: Tier A (known-good sheets, AC-16.16)', () => {
  const sheets = [
    {
      name: 'legibility-clean',
      sch: path.join(HERE, 'fixtures', 'legibility', 'clean.kicad_sch'),
      docs: path.join(HERE, 'fixtures', 'legibility', 'docs'),
    },
    {
      name: 'open-key',
      sch: path.join(HERE, 'fixtures', 'open-key', 'hardware', 'open-key.kicad_sch'),
      docs: null, // caption vocabulary lives in the target repo after init
    },
  ];
  for (const sheet of sheets) {
    it(`${sheet.name}: zero error findings and composite at or above the pinned floor`, async () => {
      const leg = await checkLegibility(sheet.sch, { docsDir: sheet.docs });
      expect(leg.findings.filter((f) => f.severity === 'error')).toEqual([]);
      const score = await scoreSchematic(sheet.sch, { docsDir: sheet.docs });
      const pin = await goldenJson(`tierA-${sheet.name}.json`, { floor: Math.floor(score.composite) });
      expect(score.composite).toBeGreaterThanOrEqual(pin.floor);
    });
  }
});

describe('golden corpus: Tier B (known-bad sheets, AC-16.17)', () => {
  it('ugly fixture: the pinned finding list keeps being detected, composite at or below the ceiling', async () => {
    const sch = path.join(HERE, 'fixtures', 'legibility', 'ugly.kicad_sch');
    const docs = path.join(HERE, 'fixtures', 'legibility', 'docs');
    const leg = await checkLegibility(sch, { docsDir: docs });
    const actual = leg.findings.map((f) => ({ kind: f.kind, severity: f.severity, sheet: f.sheet, refs: f.refs }));
    const pinned = await goldenJson('tierB-ugly-findings.json', actual);
    expect(actual).toEqual(pinned);

    const score = await scoreSchematic(sch, { docsDir: docs });
    expect(score.cap).not.toBeNull(); // errors must cap the composite (AC-16.15)
    const pin = await goldenJson('tierB-ugly-score.json', { ceiling: Math.ceil(score.composite) });
    expect(score.composite).toBeLessThanOrEqual(pin.ceiling);
  });
});

describe('golden corpus: Tier C (engine output, AC-16.18)', () => {
  it('the reference IR drafts byte-identically to the pinned golden with the pinned score', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-golden-'));
    try {
      await cp(path.join(HERE, 'fixtures', 'draft', 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
      await cp(path.join(HERE, 'fixtures', 'draft', 'docs'), path.join(repo, 'docs'), { recursive: true });
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [path.join(HERE, 'fixtures', 'symlib')],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const text = await readFile(res.schematicPath, 'utf8');

      const goldenSch = path.join(GOLDEN, 'tierC-board.kicad_sch');
      if (UPDATE) {
        await mkdir(GOLDEN, { recursive: true });
        await writeFile(goldenSch, text, 'utf8');
      }
      expect(existsSync(goldenSch), 'tierC golden missing — run COPPERHEAD_UPDATE_GOLDENS=1 npm test').toBe(true);
      expect(text).toBe(await readFile(goldenSch, 'utf8'));

      const score = await scoreSchematic(res.schematicPath, { docsDir: path.join(repo, 'docs') });
      const pinned = await goldenJson('tierC-score.json', {
        composite: score.composite,
        cap: score.cap,
        legibility: score.legibility,
      });
      expect({ composite: score.composite, cap: score.cap, legibility: score.legibility }).toEqual(pinned);
      expect(score.legibility.error).toBe(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 60000);

  it('goldens never change without the update flag', async () => {
    // the suite itself is the guard: this asserts the flag defaults off in CI
    expect(UPDATE && process.env.CI ? 'update-in-ci' : 'ok').toBe('ok');
  });
});