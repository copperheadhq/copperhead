/**
 * Pour fills in an agent run (change refill-zone-fills, design D6 to D9):
 * when `run_drc` refills, what it says about stale fills it may not write,
 * and the unrouted baseline counted on filled pours.
 */
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { RunContext } from '../agent/context.js';
import { unroutedCount } from '../kicad/cli.js';
import type { CheckReport } from '../kicad/report.js';
import {
  fillKey,
  refilledReport,
  refreshZoneFills,
  staleFills,
  unfilledZones,
  ZoneRefillUnavailableError,
} from '../kicad/zones.js';
import { markTouched } from './helpers.js';

/** Whether the run has already edited the board at `boardPath` (either path may be relative to the working directory). */
export function boardTouched(ctx: RunContext, boardPath: string): boolean {
  const board = path.resolve(boardPath);
  return [...ctx.filesTouched].some((f) => path.resolve(ctx.repoRoot, f) === board);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Refill a board the run has already edited, before its DRC (D6). The board
 * is already in the rollback snapshot's scope and already owes a passing
 * DRC, so the new fills are written straight to it. The write clears the
 * last DRC result but does not go through `markTouched`: fill data cannot
 * affect drift or the changelog, so obligations the agent closed stay
 * closed. A board whose fills and rules are unchanged since the last
 * refresh is not refilled again. Returns a line for the tool result (null
 * when there is nothing to say), and whether the refresh failed: that
 * leaves the board as it was, so the DRC that follows counts its stored
 * fills, and the failure is reported beside it.
 */
export async function refillEditedBoard(ctx: RunContext, boardPath: string): Promise<{ note: string | null; failed: boolean }> {
  const text = await readFile(boardPath, 'utf8');
  const key = await fillKey(boardPath, text);
  if (ctx.fillsCurrent === key) return { note: null, failed: false };
  let fresh;
  try {
    fresh = await refreshZoneFills(boardPath, text);
  } catch (err) {
    return {
      note: `pour fills were not refreshed: ${(err as Error).message}. The DRC below checks the fills stored in the board.`,
      failed: true,
    };
  }
  if (fresh.changed) {
    await writeFile(boardPath, fresh.text, 'utf8');
    ctx.lastDrc = null;
  }
  ctx.fillsCurrent = fresh.changed ? await fillKey(boardPath, fresh.text) : key;
  if (!fresh.zones.length) {
    return { note: fresh.idsAssigned ? 'gave an id to each pour that had none; the fills were already current' : null, failed: false };
  }
  return {
    note: `refilled ${plural(fresh.zones.length, 'pour', 'pours')} with KiCad's filler before DRC: ${fresh.zones.join('; ')}`,
    failed: false,
  };
}

/**
 * The `fill_zones` tool (D7): refill every pour on request and write the
 * board when its fills change. That is an ordinary board edit, recorded with
 * `markTouched`, so the board owes DRC, drift and a changelog entry.
 */
export async function fillZones(ctx: RunContext, rel: string, boardPath: string): Promise<{ ok: boolean; text: string }> {
  let fresh;
  try {
    fresh = await refreshZoneFills(boardPath);
  } catch (err) {
    return { ok: false, text: `not filled: ${(err as Error).message}` };
  }
  if (!fresh.report) return { ok: true, text: 'the board has no copper pours to fill; it was not changed' };
  if (!fresh.changed) {
    ctx.fillsCurrent = await fillKey(boardPath, fresh.text);
    return { ok: true, text: 'the pour fills are already current; the board was not changed' };
  }
  await writeFile(boardPath, fresh.text, 'utf8');
  markTouched(ctx, rel);
  ctx.fillsCurrent = await fillKey(boardPath, fresh.text);
  const what = fresh.zones.length
    ? `refilled ${plural(fresh.zones.length, 'pour', 'pours')}: ${fresh.zones.join('; ')}`
    : 'gave an id to each pour that had none; the fills were already current';
  return { ok: true, text: `${what}. Only fill data changed. Run run_drc to check the board.` };
}

/**
 * On a board `run_drc` may not write (D6, D8): when its DRC failed and a
 * refill would clear some of the findings, say so and how to refill. Never
 * writes the board. Null when the fills are current, a refill would not
 * help, or the DRC passed. The answer is kept per fill key, since the same
 * board and rules give the same DRC, so an unchanged board is checked once.
 */
export async function staleFillNote(ctx: RunContext, boardPath: string, report: CheckReport): Promise<string | null> {
  if (report.ok) return null;
  const text = await readFile(boardPath, 'utf8');
  const key = await fillKey(boardPath, text);
  if (ctx.fillsCurrent === key) return null;
  let found = ctx.staleFillsAt?.key === key ? ctx.staleFillsAt.found : undefined;
  if (!found) {
    try {
      found = await staleFills(boardPath, report, text);
    } catch (err) {
      return `could not check whether stale pour fills cause these findings: ${(err as Error).message}`;
    }
    if (found.zones.length) ctx.staleFillsAt = { key, found };
    else ctx.fillsCurrent = key;
  }
  if (!found.stale) return null;
  const how = ctx.editsUnlocked ? 'fill_zones refreshes them' : 'once a change is approved, fill_zones refreshes them';
  return (
    `the pour fills are stale: with fresh fills, ${plural(found.accountsFor, 'finding', 'findings')} below clear ` +
    `(${found.zones.join('; ')}). The board was not changed; ${how}.`
  );
}

/**
 * Why `export_outputs` must not run yet (D8), or null when it may: a copper
 * zone with no fill data, or stored fills that a refresh by this kicad-cli
 * would change. Fab outputs must hold the copper the committed board holds.
 * Without refill support, only zones with no fill data are caught (D10),
 * including a pour this run drew already marked filled. Nothing is written,
 * so the refresh is not read back.
 */
export async function exportFillGap(ctx: RunContext, boardPath: string): Promise<string | null> {
  const text = await readFile(boardPath, 'utf8');
  const unfilled = unfilledZones(text, ctx.boardAtStart ?? null).map((z) => z.label);
  const key = await fillKey(boardPath, text);
  if (!unfilled.length && ctx.fillsCurrent === key) return null;
  // a refresh names every pour it changes, unfilled ones included (with the id
  // it gave a pour that had none); without refill, only the unfilled are known
  let zones = unfilled;
  let cannotFill = '';
  try {
    zones = (await refreshZoneFills(boardPath, text, { verify: false })).zones;
    if (!zones.length) ctx.fillsCurrent = key;
  } catch (err) {
    if (!(err instanceof ZoneRefillUnavailableError)) {
      return `not exported, nothing written: the pour fills could not be checked: ${(err as Error).message}`;
    }
    cannotFill = ` ${err.message}; fill them in KiCad (press B) and export again.`;
  }
  if (!zones.length) return null;
  return (
    `not exported, nothing written: ${plural(zones.length, 'pour has', 'pours have')} no fill or a fill ` +
    `that KiCad would now compute differently, so the gerbers would not match the board: ${zones.join('; ')}.` +
    (cannotFill || ' Call fill_zones (or run_drc after a board edit) to refresh them, then export again.')
  );
}

/**
 * Unrouted connections on the board the run started from, counted with its
 * pours filled as KiCad fills them now beside the project's rule files (D9),
 * so a stale or missing fill at the start is not later blamed on the run.
 * Falls back to the plain count when refill is unavailable or fails.
 */
export async function startingUnrouted(boardPath: string, startText: string): Promise<number> {
  try {
    const filled = await refilledReport(boardPath, startText);
    if (filled) return filled.unrouted ?? 0;
  } catch {
    // no refill here: count as before
  }
  return unroutedCount(startText);
}
