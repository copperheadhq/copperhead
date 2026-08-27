/**
 * Board layout orchestration (issue #252): populate a `.kicad_pcb` from the
 * schematic netlist, place deterministically, optionally route through a local
 * Freerouting jar, and verify the result with DRC — rolling back to the placed
 * (unrouted) board if the router introduces real violations.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runDrc } from '../cli.js';
import type { CopperheadConfig } from '../../config.js';
import type { CheckReport } from '../report.js';
import { hardViolations } from '../report.js';
import { buildBoard, emitBoard, emitRoutedBoard, type UnresolvedFootprint } from '../board.js';
import { readNetlist } from '../netlist.js';
import { resolveFootprintCached } from '../fplib.js';
import { placeBoard } from './placement.js';
import { FreeroutingError, FreeroutingRoutingEngine, resolveFreeroutingJar, type FreeroutingFailureKind } from './freerouting.js';
import type { BoardModel, DesignRules, RoutedBoard } from './types.js';

export const DEFAULT_LAYOUT_RULES: DesignRules = {
  clearance: 0.2,
  trackWidth: 0.25,
  viaDiameter: 0.6,
  viaDrill: 0.3,
};

export interface PopulateResult {
  board: BoardModel;
  unresolved: UnresolvedFootprint[];
  componentCount: number;
}

/** Read the schematic netlist, resolve footprints, and place on a grid. */
export async function populateBoard(schPath: string): Promise<PopulateResult> {
  const netlist = await readNetlist(schPath);
  const { board, unresolved } = await buildBoard(netlist, (libId) => resolveFootprintCached(libId));
  placeBoard(board);
  return { board, unresolved, componentCount: netlist.components.length };
}

export interface BoardLayoutOptions {
  schPath: string;
  pcbPath: string;
  /** Run a local Freerouting jar. When false the board is left unrouted (ratsnest). */
  route?: boolean;
  /** Path to the Freerouting jar; resolved from env/config when omitted. */
  jarPath?: string;
  /** Config used to resolve the jar; defaults to env vars when omitted. */
  config?: Pick<CopperheadConfig, 'routing'>;
}

export interface BoardLayoutResult {
  ok: boolean;
  unresolved: UnresolvedFootprint[];
  componentCount: number;
  footprintCount: number;
  routed: boolean;
  /** The actual DRC report on the final board state — never synthesized. */
  drc: CheckReport;
  /** Hard (non-ratsnest) error-severity violations, from {@link hardViolations}. */
  drcViolations: number;
  unroutedNets: number;
  rolledBack: boolean;
  /** Why routing did not happen (null when routed, or routing was not requested). */
  routingError: FreeroutingFailureKind | null;
  routingErrorDetail: string | null;
  note: string;
}

/**
 * Full layout flow: populate + place → write the board → optionally route →
 * DRC → roll back to the placed board if the router introduced hard violations.
 *
 * Routing failures are reported, not swallowed: a board is only ever marked
 * `routed` when a real session was parsed and lowered. The DRC report returned
 * is the one `kicad-cli` produced for the final on-disk board, so a caller
 * storing it can never contradict a later `run_drc` on that same file.
 */
export async function runBoardLayout(opts: BoardLayoutOptions): Promise<BoardLayoutResult> {
  const { board, unresolved, componentCount } = await populateBoard(opts.schPath);
  const name = path.basename(opts.pcbPath, '.kicad_pcb');

  const placedText = emitBoard(board, name);
  await writeFile(opts.pcbPath, placedText, 'utf8');

  let routed = false;
  let routedText = placedText;
  let routingError: FreeroutingFailureKind | null = null;
  let routingErrorDetail: string | null = null;

  if (opts.route && board.footprints.length > 0) {
    try {
      const jarPath = opts.jarPath ?? resolveFreeroutingJar(opts.config);
      const engine = new FreeroutingRoutingEngine(jarPath);
      const result: RoutedBoard = await engine.route(board, DEFAULT_LAYOUT_RULES);
      routedText = emitRoutedBoard(board, name, result);
      routed = true;
      await writeFile(opts.pcbPath, routedText, 'utf8');
    } catch (e) {
      if (e instanceof FreeroutingError) {
        routingError = e.kind;
        routingErrorDetail = e.message;
      } else {
        routingError = 'process-failed';
        routingErrorDetail = e instanceof Error ? e.message : String(e);
      }
      // Leave the placed, unrouted board in place — but say so explicitly.
    }
  }

  const drc = await runDrc(opts.pcbPath);
  const unroutedNets = drc.unrouted.length;
  const drcViolations = hardViolations(drc).length;

  let rolledBack = false;
  if (routed && drcViolations > 0) {
    // The router produced shorts/clearance violations: restore the safe, placed board.
    await writeFile(opts.pcbPath, placedText, 'utf8');
    rolledBack = true;
    routed = false;
  }

  // Re-read DRC if we rolled back, so the report always matches the final file.
  const finalDrc = rolledBack ? await runDrc(opts.pcbPath) : drc;

  const ok = unresolved.length === 0 && drcViolations === 0 && !rolledBack;

  let note: string;
  if (routingError !== null) {
    note = `routing failed (${routingError}); placed board left as ratsnest`;
  } else if (unresolved.length > 0) {
    note = `${unresolved.length} footprint(s) unresolved: ${unresolved.map((u) => `${u.ref}:${u.footprint}`).join(', ')}`;
  } else if (rolledBack) {
    note = 'router introduced hard violations; rolled back to the placed board';
  } else if (drcViolations > 0) {
    note = `${drcViolations} hard DRC violation(s) remain`;
  } else if (routed) {
    note = `${unroutedNets} net(s) unrouted after routing`;
  } else {
    note = 'placed (unrouted ratsnest)';
  }

  return {
    ok,
    unresolved,
    componentCount,
    footprintCount: board.footprints.length,
    routed,
    drc: finalDrc,
    drcViolations,
    unroutedNets,
    rolledBack,
    routingError,
    routingErrorDetail,
    note,
  };
}

/** Human-readable report for the `layout_board` tool. */
export function formatBoardLayoutResult(r: BoardLayoutResult): string {
  const lines = [
    `placed ${r.footprintCount}/${r.componentCount} footprint(s)`,
    r.routed
      ? 'routed with Freerouting'
      : r.routingError !== null
        ? `routing failed (${r.routingError})`
        : 'not routed (ratsnest left in place)',
  ];
  if (r.routingErrorDetail) lines.push(`  ${r.routingErrorDetail}`);
  lines.push(
    r.rolledBack
      ? 'rolled back to the placed board (router introduced violations)'
      : r.drcViolations === 0
        ? 'DRC: no hard violations'
        : `DRC: ${r.drcViolations} hard violation(s)`,
  );
  lines.push(`${r.unroutedNets} net(s) unrouted`);
  if (r.unresolved.length) {
    lines.push(`unresolved footprints: ${r.unresolved.map((u) => `${u.ref} (${u.footprint})`).join(', ')}`);
  }
  lines.push(r.note);
  return lines.join('\n');
}
