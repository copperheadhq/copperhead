import type { CopperheadConfig } from '../config.js';
import type { CheckReport } from '../kicad/report.js';
import type { ObligationsLedger } from './ledger.js';
import type { Transcript } from './transcript.js';

export interface FinishRequest {
  outcome: 'done' | 'refuse';
  summary: string;
}

/** Mutable state one run threads through every tool call. */
export interface RunContext {
  repoRoot: string;
  config: CopperheadConfig;
  transcript: Transcript;
  ledger: ObligationsLedger;
  runId: string;
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  editsUnlocked: boolean;
  changeId: string | null;
  proposalValidated: boolean;
  filesTouched: Set<string>;
  decisions: string[];
  lastErc: CheckReport | null;
  lastDrc: CheckReport | null;
  /**
   * The board's text when the run started (null: no board then). An agent
   * run may leave nets unrouted, but never more than it started with: a
   * rise means it broke a connection (AC-15.39).
   */
  boardAtStart?: string | null;
  /** Unrouted connections on `boardAtStart`, computed on the first run_drc. */
  unroutedBaseline?: number;
  /** The caller's completion contract, checked by `finish` (see RunOptions.stageGate). */
  stageGate?: (ctx: RunContext) => Promise<string | null>;
  /** Last check_legibility counts; feeds the run summary's verification section. */
  lastLegibility: { error: number; advisory: number } | null;
  /** Last score composite (AC-16.21); recorded in the run summary. */
  lastScore: number | null;
  /** Last `check_drift` output; used by `generate_report` completion. */
  lastDrift?: string | null;
  repairCycles: number;
  /**
   * The most recent ERC and DRC reports, kept across edits. `lastErc`/`lastDrc`
   * are cleared by any schematic or board edit (they mean "verified since the
   * last edit"), so the repair budget compares against these instead (#331).
   */
  priorChecks?: { erc?: CheckReport; drc?: CheckReport };
  finishRequest: FinishRequest | null;
}
