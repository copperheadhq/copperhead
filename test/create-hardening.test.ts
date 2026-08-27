import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { kicadLoadError, isProbeableKicadFile } from '../src/kicad/cli.js';
import { checkDrift, emptySchematicWarning } from '../src/memory/drift.js';
import { loadConfig } from '../src/config.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * Offline tests for the create-pipeline hardening (#19, #21, #23, #25) and
 * its re-review fixes: KiCad edit probe validation scoped to probeable files,
 * incremental repair of already-corrupt files, and the drift bootstrap
 * exemption with its check-side warning.
 */

const SCH = path.join('hardware', 'open-key.kicad_sch');

async function makeCtx(repo: string): Promise<RunContext> {
  const transcript = new Transcript(repo);
  await transcript.init();
  return {
    repoRoot: repo,
    config: await loadConfig(repo),
    transcript,
    ledger: new ObligationsLedger(),
    runId: 'test-run',
    interactive: false,
    confirm: async () => true,
    editsUnlocked: true,
    changeId: null,
    proposalValidated: false,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    repairCycles: 0,
    finishRequest: null,
  };
}

describe('KiCad edit probe validation (AC-15.20..15.22)', () => {
  it('only schematics and boards are probeable', () => {
    expect(isProbeableKicadFile('a.kicad_sch')).toBe(true);
    expect(isProbeableKicadFile('a.kicad_pcb')).toBe(true);
    expect(isProbeableKicadFile('a.kicad_pro')).toBe(false);
    expect(isProbeableKicadFile('a.kicad_sym')).toBe(false);
    expect(isProbeableKicadFile('a.kicad_mod')).toBe(false);
  });

  it('kicadLoadError: null on a good schematic, text on a corrupt one, null on unprobeable kinds', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, SCH);
      expect(await kicadLoadError(sch)).toBeNull();
      const pro = path.join(repo, 'project.kicad_pro');
      await writeFile(pro, '{ "version": 1 }\n', 'utf8');
      expect(await kicadLoadError(pro)).toBeNull();
      // KiCad ignores trailing garbage; an unbalanced paren inside the top
      // form is what actually fails the load
      await writeFile(sch, (await readFile(sch, 'utf8')).replace('(kicad_sch', '(kicad_sch (broken'), 'utf8');
      expect(await kicadLoadError(sch)).toBeTruthy();
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('an edit to a .kicad_pro is applied, not auto-reverted (AC-15.21)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, 'project.kicad_pro'), '{ "version": 1 }\n', 'utf8');
      const ctx = await makeCtx(repo);
      const res = await dispatchTool(ctx, 'edit_file', {
        path: 'project.kicad_pro',
        old_string: '"version": 1',
        new_string: '"version": 2',
      });
      expect(res).toContain('edited');
      expect(res).not.toContain('REVERTED');
      expect(await readFile(path.join(repo, 'project.kicad_pro'), 'utf8')).toContain('"version": 2');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('an edit that corrupts a loadable schematic is reverted with the kicad-cli reason (AC-15.20)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, SCH);
      const before = await readFile(sch, 'utf8');
      const ctx = await makeCtx(repo);
      const res = await dispatchTool(ctx, 'edit_file', {
        path: SCH,
        old_string: '(kicad_sch',
        new_string: '(kicad_sch (broken',
      });
      expect(res).toContain('REVERTED');
      expect(await readFile(sch, 'utf8')).toBe(before);
      expect(ctx.filesTouched.has(SCH)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('an already-unloadable schematic keeps repair edits instead of deadlocking (AC-15.22)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, SCH);
      await writeFile(sch, (await readFile(sch, 'utf8')).replace('(kicad_sch', '(kicad_sch (broken'), 'utf8');
      const ctx = await makeCtx(repo);
      const res = await dispatchTool(ctx, 'edit_file', {
        path: SCH,
        old_string: '(version 20231120)',
        new_string: '(version 20231121)',
      });
      expect(res).toContain('KEPT');
      expect(res).toContain('already unloadable');
      expect(await readFile(sch, 'utf8')).toContain('(version 20231121)');
      expect(ctx.filesTouched.has(SCH)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe('drift bootstrap exemption and check warning (AC-15.25, AC-15.26)', () => {
  const EMPTY_SCH = '(kicad_sch\n  (version 20231120)\n  (generator "eeschema")\n)\n';
  const BOM = '# BOM\n\n| Refdes | Value | Footprint |\n| --- | --- | --- |\n| R1 | 10k | R_0402 |\n| U1 | LDO | SOT-23 |\n';

  it('a zero-symbol schematic produces no drift mismatches even when BOM.md lists parts', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, SCH), EMPTY_SCH, 'utf8');
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'BOM.md'), BOM, 'utf8');
      expect(await checkDrift(repo, 'docs/', SCH)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('emptySchematicWarning names the mismatch without failing anything', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'BOM.md'), BOM, 'utf8');
      // symbols present: no warning
      expect(await emptySchematicWarning(repo, 'docs/', SCH)).toBeNull();
      // emptied schematic + populated BOM: warning
      await writeFile(path.join(repo, SCH), EMPTY_SCH, 'utf8');
      const warning = await emptySchematicWarning(repo, 'docs/', SCH);
      expect(warning).toContain('zero symbols');
      expect(warning).toContain('2 refdes');
    } finally {
      await cleanup();
    }
  });

  it('no warning when BOM.md is absent or lists nothing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, SCH), EMPTY_SCH, 'utf8');
      expect(await emptySchematicWarning(repo, 'docs/', SCH)).toBeNull();
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'BOM.md'), '# BOM\n\nnothing yet\n', 'utf8');
      expect(await emptySchematicWarning(repo, 'docs/', SCH)).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
