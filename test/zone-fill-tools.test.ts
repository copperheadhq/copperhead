import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { runAgentLoop } from '../src/agent/loop.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { availableTools, dispatchTool, type RunContext } from '../src/agent/tools.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { boardTouched, startingUnrouted } from '../src/capabilities/fills.js';
import { runCheck } from '../src/commands/check.js';
import { STAGES } from '../src/commands/create.js';
import { buildSystemPrompt } from '../src/agent/prompts.js';
import { loadConfig } from '../src/config.js';
import { resetKicadCliCache, resolveKicadCli, unroutedCount } from '../src/kicad/cli.js';
import { listZones, refreshZoneFills, unfilledZones } from '../src/kicad/zones.js';

/**
 * Pour fills in agent runs (change refill-zone-fills, AC-22.8 to AC-22.15):
 * `run_drc` refilling a board the run edited, the read-only stale-fill note,
 * `fill_zones`, the unrouted baseline on filled pours, and the export gate.
 * The fixtures are those of test/zones.test.ts: `fresh` is filled, `stale`
 * is `fresh` with J2 moved into the pour, `unfilled` has outlines only.
 */
const ZONES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'zones');
const BOARD = 'zones.kicad_pcb';
const fixture = (name: string): Promise<string> => readFile(path.join(ZONES, `${name}.kicad_pcb`), 'utf8');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** The board with each zone replaced by a marker: everything a refill must leave alone. */
const outsideZones = (text: string): string => {
  let out = text;
  for (const z of [...listZones(text)].reverse()) out = out.slice(0, z.span.start) + '<zone>' + out.slice(z.span.end);
  return out;
};
/**
 * `fresh` with a ring of no-net track around J2 on both copper layers. The
 * stored fills run straight through the ring and still join J2's GND pad to
 * the pour; a fresh fill keeps clear of the track, which shuts J2 off.
 */
const ringed = (fresh: string): string => {
  const corners = [[122, 117], [130.5, 117], [130.5, 123], [122, 123]] as const;
  let n = 0;
  const segs = ['F.Cu', 'B.Cu'].flatMap((layer) =>
    corners.map(([x1, y1], i) => {
      const [x2, y2] = corners[(i + 1) % 4]!;
      n++;
      return `  (segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width 0.25) (layer "${layer}") (net 0) (uuid "5e5e5e5e-0000-4000-8000-0000000000${String(n).padStart(2, '0')}"))\n`;
    }),
  );
  expect(fresh.split('  (gr_rect').length).toBe(2);
  return fresh.replace('  (gr_rect', `${segs.join('')}  (gr_rect`);
};
/** `text` without its zones: a board with parts and no pour. */
const bare = (text: string): string => {
  let out = text;
  for (const z of [...listZones(text)].reverse()) {
    const lineStart = out.lastIndexOf('\n', z.span.start) + 1;
    out = out.slice(0, lineStart) + out.slice(z.span.end + 1);
  }
  return out;
};
/** The F.Cu outline of `unfilled`, as an agent would write a new pour. */
const fcuPour = async (): Promise<string> => {
  const unfilled = await fixture('unfilled');
  const z = listZones(unfilled)[0]!;
  return unfilled.slice(z.span.start, z.span.end);
};

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A repo holding `boardText` as the configured board, beside the fixture's project rules. */
async function zonesRepo(boardText: string): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-fills-'));
  dirs.push(repo);
  await copyFile(path.join(ZONES, 'zones.kicad_pro'), path.join(repo, 'zones.kicad_pro'));
  await writeFile(path.join(repo, BOARD), boardText, 'utf8');
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({ board: BOARD }), 'utf8');
  return repo;
}

async function makeCtx(repo: string, opts: { unlocked: boolean; boardAtStart?: string }): Promise<RunContext> {
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
    editsUnlocked: opts.unlocked,
    changeId: null,
    proposalValidated: opts.unlocked,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    boardAtStart: opts.boardAtStart ?? (await readFile(path.join(repo, BOARD), 'utf8')),
    lastLegibility: null,
    lastScore: null,
    repairCycles: 0,
    finishRequest: null,
  };
}

const boardOf = (repo: string): Promise<string> => readFile(path.join(repo, BOARD), 'utf8');

/**
 * Point copperhead at a kicad-cli wrapper that records each call in the
 * returned log, then runs the real one. Restored by the returned function.
 */
async function recordKicadCalls(): Promise<{ log: string; restore: () => void }> {
  const real = resolveKicadCli();
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-fills-wrap-'));
  dirs.push(dir);
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'kicad-cli');
  await writeFile(bin, `#!/bin/sh\necho "$@" >> "${log}"\nexec "${real}" "$@"\n`, 'utf8');
  await chmod(bin, 0o755);
  const saved = process.env.COPPERHEAD_KICAD_CLI;
  process.env.COPPERHEAD_KICAD_CLI = bin;
  resetKicadCliCache();
  return {
    log,
    restore: () => {
      if (saved === undefined) delete process.env.COPPERHEAD_KICAD_CLI;
      else process.env.COPPERHEAD_KICAD_CLI = saved;
      resetKicadCliCache();
    },
  };
}
const refills = async (log: string): Promise<number> =>
  existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter((l) => l.includes('--refill-zones')).length : 0;

describe('run_drc refills a board the run edited', { timeout: 300_000 }, () => {
  it('a move into a pour passes once the pour is refilled, and the format stays KiCad 8 (AC-22.8)', async () => {
    const fresh = await fixture('fresh');
    const repo = await zonesRepo(fresh);
    const ctx = await makeCtx(repo, { unlocked: true });
    expect(await dispatchTool(ctx, 'move_footprint', { ref: 'J2', x: 130, y: 110 })).toContain('moved J2');
    const moved = await boardOf(repo);
    expect(moved).toBe(await fixture('stale'));
    const res = await dispatchTool(ctx, 'run_drc', {});
    expect(res).toMatch(/refilled 2 pours with KiCad's filler before DRC: the GND zone on F\.Cu \(3c3c3c3c\); the GND zone on B\.Cu/);
    expect(res).toContain('DRC: clean');
    expect(ctx.lastDrc?.ok).toBe(true);
    const written = await boardOf(repo);
    expect(written).not.toBe(moved);
    expect(outsideZones(written)).toBe(outsideZones(moved));
    expect(written.slice(0, 40)).toContain('(version 20240108)');
  });

  it('fills a pour the agent drew with edit_file, joining the pads it covers (AC-22.9)', async () => {
    const start = bare(await fixture('fresh'));
    expect(listZones(start)).toEqual([]);
    const repo = await zonesRepo(start);
    const ctx = await makeCtx(repo, { unlocked: true });
    const anchor = '    (uuid "1a1a1a1a-0000-4000-8000-000000000001")\n  )\n';
    const added = await dispatchTool(ctx, 'edit_file', {
      path: BOARD,
      old_string: anchor,
      new_string: `${anchor}${await fcuPour()}\n`,
    });
    expect(added).not.toMatch(/REVERTED|error/i);
    expect(unfilledZones(await boardOf(repo))).toHaveLength(1);
    const res = await dispatchTool(ctx, 'run_drc', {});
    expect(res).toContain('refilled 1 pour');
    const written = await boardOf(repo);
    expect(unfilledZones(written)).toEqual([]);
    expect(listZones(written)[0]!.fills.length).toBeGreaterThan(0);
    // J1's and J2's GND pads were one unrouted connection on the bare board
    expect(await unroutedCount(start)).toBe(1);
    expect(ctx.lastDrc?.unrouted).toBe(0);
  });

  it('a refill reopens no obligation the run closed (AC-22.11)', async () => {
    const repo = await zonesRepo(await fixture('fresh'));
    const ctx = await makeCtx(repo, { unlocked: true });
    await dispatchTool(ctx, 'move_footprint', { ref: 'J2', x: 130, y: 110 });
    // the run closes everything a board edit opens except DRC
    ctx.lastErc = { ok: true, source: 'erc', violations: [] };
    for (const kind of ['erc', 'drift', 'changelog'] as const) ctx.ledger.clear(kind);
    expect(ctx.ledger.openObligations.map((o) => o.kind)).toEqual(['drc']);
    expect(await dispatchTool(ctx, 'run_drc', {})).toContain('refilled 2 pours');
    expect(ctx.ledger.openObligations).toEqual([]);
    expect(await dispatchTool(ctx, 'finish', { outcome: 'done', summary: 'moved J2' })).toContain('all gates satisfied');
  });

  it('does not refill a board it already refilled, until the board changes again', async () => {
    const repo = await zonesRepo(await fixture('fresh'));
    const ctx = await makeCtx(repo, { unlocked: true });
    const { log, restore } = await recordKicadCalls();
    try {
      await dispatchTool(ctx, 'move_footprint', { ref: 'J2', x: 130, y: 110 });
      await dispatchTool(ctx, 'run_drc', {});
      // the edited board, and once only the starting board for the unrouted baseline
      expect(await refills(log)).toBe(2);
      const filled = await boardOf(repo);
      expect(await dispatchTool(ctx, 'run_drc', {})).toContain('DRC: clean');
      expect(await refills(log)).toBe(2);
      expect(await boardOf(repo)).toBe(filled);
      await dispatchTool(ctx, 'move_footprint', { ref: 'J2', x: 125, y: 120 });
      await dispatchTool(ctx, 'run_drc', {});
      expect(await refills(log)).toBe(3);
      // back where it started, filled the way the fixture was
      expect(await boardOf(repo)).toBe(await fixture('fresh'));
    } finally {
      restore();
    }
  });

  it('is read-only before edits unlock and on a board the run has not touched, and names the stale fills (AC-22.10)', async () => {
    const stale = await fixture('stale');
    for (const unlocked of [false, true]) {
      const repo = await zonesRepo(stale);
      const ctx = await makeCtx(repo, { unlocked });
      const res = await dispatchTool(ctx, 'run_drc', {});
      expect(sha(await boardOf(repo))).toBe(sha(stale));
      expect(ctx.lastDrc?.ok).toBe(false);
      expect(res).toMatch(/the pour fills are stale: with fresh fills, \d+ findings? below clear \(the GND zone on F\.Cu \(3c3c3c3c\)/);
      expect(res).toContain(unlocked ? 'The board was not changed; fill_zones refreshes them.' : 'once a change is approved, fill_zones');
      expect(res).not.toContain('refilled');
    }
  });

  it('says nothing about fills on a failing board whose fills are current', async () => {
    // J1 moved onto J2 and the pours refilled: shorted pads no refill clears
    const moved = (await fixture('fresh')).replace('(at 110 110)', '(at 124 120)');
    const overlapped = (await refreshZoneFills(await zonesRepo(moved).then((r) => path.join(r, BOARD)))).text;
    const repo = await zonesRepo(overlapped);
    const ctx = await makeCtx(repo, { unlocked: false });
    const res = await dispatchTool(ctx, 'run_drc', {});
    expect(ctx.lastDrc?.ok).toBe(false);
    expect(res).not.toContain('stale');
    expect(sha(await boardOf(repo))).toBe(sha(overlapped));
  });
});

describe('fill_zones', { timeout: 300_000 }, () => {
  it('is absent until edits unlock, then refills a board the run had not touched, which then owes DRC (AC-22.13)', async () => {
    const repo = await zonesRepo(await fixture('stale'));
    const locked = await makeCtx(repo, { unlocked: false });
    expect(availableTools(locked).map((t) => t.name)).not.toContain('fill_zones');
    const ctx = await makeCtx(repo, { unlocked: true });
    expect(availableTools(ctx).map((t) => t.name)).toContain('fill_zones');
    const res = await dispatchTool(ctx, 'fill_zones', {});
    expect(res).toMatch(/^refilled 2 pours: .*Only fill data changed\. Run run_drc to check the board\./);
    expect(ctx.filesTouched.has(BOARD)).toBe(true);
    ctx.lastErc = { ok: true, source: 'erc', violations: [] };
    expect(await dispatchTool(ctx, 'finish', { outcome: 'done', summary: 'refilled' })).toContain(
      'DRC has not passed since the last board edit',
    );
    expect(await dispatchTool(ctx, 'run_drc', {})).toContain('DRC: clean');
    expect(await dispatchTool(ctx, 'fill_zones', {})).toBe('the pour fills are already current; the board was not changed');
  });
});

describe('the unrouted baseline counts filled pours (AC-22.14)', { timeout: 300_000 }, () => {
  it('a pad the stored fill reaches and a fresh fill does not is not blamed on the run', async () => {
    const start = ringed(await fixture('fresh'));
    const repo = await zonesRepo(start);
    // the stored fills still join J2's GND pad; refilled around the ring, they do not
    expect(await unroutedCount(start)).toBe(0);
    expect(await startingUnrouted(path.join(repo, BOARD), start)).toBe(1);
    const ctx = await makeCtx(repo, { unlocked: true });
    // a look before any edit, as the layout stage asks: read-only, on the stored fills
    await dispatchTool(ctx, 'run_drc', {});
    expect(ctx.lastDrc?.unrouted).toBe(0);
    expect(ctx.unroutedBaseline).toBeUndefined();
    await dispatchTool(ctx, 'move_footprint', { ref: 'J1', x: 110, y: 112 });
    const res = await dispatchTool(ctx, 'run_drc', {});
    expect(ctx.unroutedBaseline).toBe(1);
    expect(ctx.lastDrc?.unrouted).toBe(1);
    expect(res).not.toContain('unrouted_increase');
  });

  it('a board without pours keeps its first count as the baseline', async () => {
    const start = bare(await fixture('fresh'));
    const repo = await zonesRepo(start);
    const ctx = await makeCtx(repo, { unlocked: true });
    await dispatchTool(ctx, 'run_drc', {});
    expect(ctx.unroutedBaseline).toBe(1);
  });
});

describe('export_outputs and pour fills (AC-22.15)', { timeout: 300_000 }, () => {
  it('refuses a board with an unfilled pour and writes nothing', async () => {
    const repo = await zonesRepo(await fixture('unfilled'));
    const ctx = await makeCtx(repo, { unlocked: true });
    const res = await dispatchTool(ctx, 'export_outputs', {});
    expect(res).toMatch(/^not exported, nothing written: 2 copper pours have no fill/);
    expect(res).toContain('the GND zone on F.Cu (3c3c3c3c)');
    expect(res).toContain('Call fill_zones');
    expect(existsSync(path.join(repo, 'outputs'))).toBe(false);
  });

  it('refuses stale fills, and exports once they are current', async () => {
    const repo = await zonesRepo(await fixture('stale'));
    const ctx = await makeCtx(repo, { unlocked: true });
    expect(await dispatchTool(ctx, 'export_outputs', {})).toMatch(/^not exported, nothing written: 2 copper pours/);
    await dispatchTool(ctx, 'fill_zones', {});
    const res = await dispatchTool(ctx, 'export_outputs', {});
    expect(res).not.toContain('not exported');
    expect(res).toMatch(/produced: .*gerbers/);
    expect(existsSync(path.join(repo, 'outputs', 'gerbers'))).toBe(true);
  });
});

describe('check reports pour fills, read-only', { timeout: 300_000 }, () => {
  it('names stale fills and what they account for, and leaves the board alone (AC-22.16)', async () => {
    const stale = await fixture('stale');
    const repo = await zonesRepo(stale);
    const lines: string[] = [];
    const res = await runCheck(repo, (s) => lines.push(s));
    expect(res.ok).toBe(false);
    expect(res.drc?.ok).toBe(false);
    const fills = res.drc!.fills;
    expect(fills.stale).toBe(true);
    expect(fills.staleAccountsFor).toBeGreaterThan(0);
    expect(fills.staleAccountsFor).toBeLessThanOrEqual(res.drc!.violations);
    expect(fills.staleZones).toContain('the GND zone on F.Cu (3c3c3c3c)');
    expect(fills.unfilled).toEqual([]);
    expect(lines.join('\n')).toMatch(
      new RegExp(`fills: the pour fills are stale: with fresh fills, ${fills.staleAccountsFor} of the DRC findings clear`),
    );
    expect(sha(await boardOf(repo))).toBe(sha(stale));
  });

  it('names an unfilled pour without changing the result DRC gives (AC-22.17)', async () => {
    const unfilled = await fixture('unfilled');
    const repo = await zonesRepo(unfilled);
    const lines: string[] = [];
    const res = await runCheck(repo, (s) => lines.push(s));
    // nothing to clash with yet: DRC passes, so check does too
    expect(res.drc?.ok).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.drc!.fills).toEqual({
      stale: false,
      staleAccountsFor: 0,
      staleZones: [],
      unfilled: ['the GND zone on F.Cu (3c3c3c3c)', 'the GND zone on B.Cu (no uuid)'],
    });
    expect(lines.join('\n')).toContain('fills: 2 copper pour(s) have no fill, so they are not copper yet');
    expect(sha(await boardOf(repo))).toBe(sha(unfilled));
  });

  it('runs no extra kicad-cli for a passing board, or a failing one without pours', async () => {
    const { log, restore } = await recordKicadCalls();
    try {
      await runCheck(await zonesRepo(await fixture('fresh')), () => {});
      const overlapped = bare(await fixture('fresh')).replace('(at 110 110)', '(at 124 120)');
      const res = await runCheck(await zonesRepo(overlapped), () => {});
      expect(res.drc?.ok).toBe(false);
      expect(await refills(log)).toBe(0);
    } finally {
      restore();
    }
  });
});

describe('which board counts as edited', () => {
  it('matches the touched board however the repo root and file are spelled', () => {
    const ctx = { repoRoot: 'rel/repo', filesTouched: new Set(['./hw/b.kicad_pcb']) } as unknown as RunContext;
    expect(boardTouched(ctx, path.join('rel/repo', 'hw/b.kicad_pcb'))).toBe(true);
    expect(boardTouched(ctx, path.resolve('rel/repo/hw/b.kicad_pcb'))).toBe(true);
    expect(boardTouched(ctx, path.resolve('rel/repo/hw/other.kicad_pcb'))).toBe(false);
  });
});

describe('prompts', () => {
  it('the do rules and the layout-draft stage say run_drc fills pours and fills are never hand-written', async () => {
    const repo = await zonesRepo(await fixture('fresh'));
    const system = await buildSystemPrompt(repo, await loadConfig(repo), {});
    expect(system).toContain("run_drc fills the copper pours (zones) of a board this run changed with KiCad's own filler");
    expect(system).toContain('Never write filled_polygon data by hand');
    expect(system).toContain('call fill_zones');
    const stage = STAGES.find((s) => s.name === 'layout-draft')!.prompt('brief', 'docs');
    expect(stage).toContain("run_drc fills every copper pour with KiCad's own filler on a board this run changed");
    expect(stage).toContain('never write filled_polygon data yourself');
  });
});

describe('with a kicad-cli that cannot refill (D10)', { timeout: 300_000 }, () => {
  it('run_drc checks the stored fills and says so, fill_zones fails, and export refuses an unfilled pour', async () => {
    if (process.platform === 'win32') return;
    // the real kicad-cli, except that `pcb drc --help` offers no refill flags (KiCad 8)
    const real = resolveKicadCli();
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-fills-old-'));
    dirs.push(dir);
    const bin = path.join(dir, 'kicad-cli');
    await writeFile(
      bin,
      `#!/bin/sh\nif [ "$1 $2 $3" = "pcb drc --help" ]; then echo "Usage: pcb drc [--help] [--output OUTPUT_FILE] INPUT_FILE"; exit 0; fi\nexec "${real}" "$@"\n`,
      'utf8',
    );
    await chmod(bin, 0o755);
    const saved = process.env.COPPERHEAD_KICAD_CLI;
    process.env.COPPERHEAD_KICAD_CLI = bin;
    resetKicadCliCache();
    try {
      const repo = await zonesRepo(await fixture('fresh'));
      const ctx = await makeCtx(repo, { unlocked: true });
      await dispatchTool(ctx, 'move_footprint', { ref: 'J2', x: 130, y: 110 });
      const moved = await boardOf(repo);
      const res = await dispatchTool(ctx, 'run_drc', {});
      expect(res).toMatch(/^pour fills were not refreshed: this kicad-cli cannot refill zones .*The DRC below checks the fills stored in the board\.\nDRC: \d+ violation/s);
      expect(await boardOf(repo)).toBe(moved);
      expect(await dispatchTool(ctx, 'fill_zones', {})).toMatch(/not filled: this kicad-cli cannot refill zones/);
      const bare = await zonesRepo(await fixture('unfilled'));
      const exp = await dispatchTool(await makeCtx(bare, { unlocked: true }), 'export_outputs', {});
      expect(exp).toMatch(/^not exported, nothing written: 2 copper pours have no fill.*cannot refill zones.*fill them in KiCad \(press B\)/s);
      expect(existsSync(path.join(bare, 'outputs'))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.COPPERHEAD_KICAD_CLI;
      else process.env.COPPERHEAD_KICAD_CLI = saved;
      resetKicadCliCache();
    }
  });
});

/** Scripted provider: plays each turn in order, repeats the last one. */
function scriptedProvider(turns: Partial<Turn>[]): Provider {
  let i = 0;
  return {
    name: 'scripted',
    async chat(_messages: Msg[]): Promise<Turn> {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return {
        text: t.text ?? null,
        toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })),
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
}

describe('a failed run restores the fills too (AC-22.12)', { timeout: 300_000 }, () => {
  it('leaves the board byte-identical to its start after run_drc refilled it', async () => {
    const start = await fixture('fresh');
    const repo = await zonesRepo(start);
    await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n', 'utf8');
    await execa('git', ['init', '-q'], { cwd: repo });
    await execa('git', ['config', 'user.email', 'test@copperhead.local'], { cwd: repo });
    await execa('git', ['config', 'user.name', 'copperhead-test'], { cwd: repo });
    await execa('git', ['add', '-A'], { cwd: repo });
    await execa('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });
    let refilled = '';
    const provider = scriptedProvider([
      {
        toolCalls: [
          { name: 'propose_change', args: { id: 'move-j2', why: 'w', what_changes: '- move J2', tasks: '- [ ] move' } },
          { name: 'validate_change', args: {} },
        ],
      },
      { toolCalls: [{ name: 'move_footprint', args: { ref: 'J2', x: 130, y: 110 } }] },
      { toolCalls: [{ name: 'run_drc', args: {} }] },
      { toolCalls: [{ name: 'read_file', args: { path: BOARD, start_line: 1, end_line: 2 } }] },
    ]);
    const watching: Provider = {
      name: provider.name,
      async chat(messages: Msg[]): Promise<Turn> {
        // after run_drc, before the run fails: the refill is on disk
        if (!refilled && JSON.stringify(messages).includes('refilled 2 pours')) refilled = await boardOf(repo);
        return provider.chat(messages);
      },
    };
    const res = await runAgentLoop({ repoRoot: repo, request: 'move J2', model: 'gpt-5', provider: watching, maxTurns: 5, log: () => {} });
    expect(res.outcome).toBe('failure');
    expect(refilled).not.toBe('');
    expect(outsideZones(refilled)).toBe(outsideZones(await fixture('stale')));
    expect(refilled).not.toBe(await fixture('stale'));
    expect(sha(await boardOf(repo))).toBe(sha(start));
  });
});
