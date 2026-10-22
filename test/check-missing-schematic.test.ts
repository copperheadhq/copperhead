import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { runInit } from '../src/memory/scaffold.js';
import { runCheck, type CheckResult } from '../src/commands/check.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * A configured-but-absent schematic must not read as a pass. Two repos are
 * involved and they are easy to conflate: one with nothing configured, which
 * has genuinely nothing to verify, and one that was configured to be checked
 * and quietly stopped being checked when the file moved or was renamed.
 */

const FIXTURE_SCH = 'hardware/open-key.kicad_sch';

interface Run {
  res: CheckResult;
  log: string[];
}

/** Run `check` over the fixture with `schematic` set to `schematic`. */
async function runWith(schematic: string | null, opts: { removeFile?: boolean } = {}): Promise<Run> {
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
    const log: string[] = [];
    const res = await runCheck(repo, (s) => log.push(s));
    return { res, log };
  } finally {
    await cleanup();
  }
}

describe('check with a configured but missing schematic', () => {
  it('does not report ok when the configured schematic is absent', async () => {
    const { res } = await runWith('hardware/moved-board.kicad_sch');

    expect(res.ok).toBe(false);
    expect(res.schematicMissing).toBe('hardware/moved-board.kicad_sch');
  }, 60_000);

  it('names the missing path instead of blaming the configuration', async () => {
    const { log } = await runWith('hardware/moved-board.kicad_sch');
    const erc = log.find((l) => l.startsWith('ERC skipped'));

    expect(erc).toContain('hardware/moved-board.kicad_sch');
    expect(erc).toContain('missing');
    // `copperhead init` is the wrong remedy: the config is fine, the file is not
    expect(erc).not.toContain('no schematic configured');
    expect(erc).not.toContain('copperhead init');
  }, 60_000);

  it('fails the same way when the file is deleted after being configured', async () => {
    const { res, log } = await runWith(FIXTURE_SCH, { removeFile: true });

    expect(res.ok).toBe(false);
    expect(res.schematicMissing).toBe(FIXTURE_SCH);
    expect(log.find((l) => l.startsWith('ERC skipped'))).toContain(FIXTURE_SCH);
  }, 60_000);

  it('leaves a repo with no schematic configured green and unchanged', async () => {
    const { res, log } = await runWith(null);

    expect(res.ok).toBe(true);
    expect(res.schematicMissing).toBeNull();
    expect(log).toContain('ERC skipped (no schematic configured; run copperhead init)');
  }, 60_000);

  it('distinguishes the two skips, which previously logged the same line', async () => {
    const missing = await runWith('hardware/moved-board.kicad_sch');
    const unset = await runWith(null);

    const ercOf = (r: Run): string | undefined => r.log.find((l) => l.startsWith('ERC skipped'));
    expect(ercOf(missing)).not.toEqual(ercOf(unset));
    expect(missing.res.ok).not.toEqual(unset.res.ok);
  }, 60_000);
});
