import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { runInit } from '../src/memory/scaffold.js';
import { syncVerify, formatSyncReport, type SyncReport } from '../src/commands/sync.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * `sync` counterpart to the `check` half of #188. Drift and the forbidden-pin
 * check are both gated on the schematic existing, so a configured but absent
 * schematic disarmed the two of them together and `sync` still reported no
 * inconsistencies and exited 0.
 *
 * The report carries this as a violation rather than a resolvable item: the CLI
 * hands every resolvable item to the LLM resolve phase, and a file that is not
 * on disk is not something an agent should write its way out of.
 */

const FIXTURE_SCH = 'hardware/open-key.kicad_sch';

async function syncWith(schematic: string | null, opts: { removeFile?: boolean } = {}): Promise<SyncReport> {
  const { repo, cleanup } = await tempFixtureRepo();
  try {
    await runInit({ repoRoot: repo });
    await writeFile(
      path.join(repo, '.copperhead', 'config.json'),
      JSON.stringify({ docs: 'docs/', schematic, board: null, budgets: {} }, null, 2),
      'utf8',
    );
    if (opts.removeFile && schematic) {
      await rm(path.join(repo, schematic), { force: true });
    }
    return await syncVerify(repo);
  } finally {
    await cleanup();
  }
}

describe('sync with a configured but missing schematic', () => {
  it('reports it, where it previously found nothing at all', async () => {
    const report = await syncWith('hardware/moved-board.kicad_sch');
    const missing = report.violations.filter((v) => v.kind === 'schematic-missing');

    expect(missing).toHaveLength(1);
    expect(missing[0]!.description).toContain('hardware/moved-board.kicad_sch');
    expect(missing[0]!.governedBy).toBe('.copperhead/config.json');
  });

  it('says the checks did not run, not that nothing was wrong', async () => {
    const report = await syncWith('hardware/moved-board.kicad_sch');
    const text = formatSyncReport(report);

    expect(text).not.toBe('sync: no inconsistencies');
    expect(text).toContain('the file is missing');
    // the point of the message: silence here meant "not checked", not "clean"
    expect(text).toContain('did not run');
  });

  it('is a violation, not a resolvable item, so no agent is asked to fix it', async () => {
    const report = await syncWith('hardware/moved-board.kicad_sch');

    // the CLI exits 2 on violations before it ever reaches the resolve phase
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.resolvable.map((i) => i.kind)).not.toContain('schematic-missing');
  });

  it('behaves the same when the file is deleted after being configured', async () => {
    const report = await syncWith(FIXTURE_SCH, { removeFile: true });

    expect(report.violations.filter((v) => v.kind === 'schematic-missing')).toHaveLength(1);
  });

  it('stays silent when no schematic is configured', async () => {
    const report = await syncWith(null);

    expect(report.violations.filter((v) => v.kind === 'schematic-missing')).toEqual([]);
  });

  it('stays silent when the configured schematic is present', async () => {
    const report = await syncWith(FIXTURE_SCH);

    expect(report.violations.filter((v) => v.kind === 'schematic-missing')).toEqual([]);
  });
});
