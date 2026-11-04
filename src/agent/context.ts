import type { CopperheadConfig } from '../config.js';
import type { CheckReport } from '../kicad/report.js';
import type { ObligationsLedger } from './ledger.js';
import type { Transcript } from './transcript.js';
import type { SafeWriteHooks } from '../capabilities/helpers.js';

/**
 * A structured reason a run could not finish (AC-18.1). `constraint` names a key
 * in the constraint registry; `required` is what it demands and `found` the
 * candidate that fails it, both in prose a reader can act on.
 */
export interface RefusalBlocker {
  kind: 'constraint-conflict';
  constraint: string;
  required: string;
  found: string;
}

export interface FinishRequest {
  outcome: 'done' | 'refuse';
  summary: string;
  /** Blockers whose constraint key the registry holds (design D1): the only ones that count. */
  blockers?: RefusalBlocker[];
  /** Blockers naming a key the registry does not hold: kept as prose, never a stop (AC-18.2). */
  unverifiedBlockers?: RefusalBlocker[];
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
  stageGate?: () => Promise<string | null>;
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
  /** Optional file operation hooks for testing atomic recovery. */
  writeHooks?: SafeWriteHooks;
  finishRequest: FinishRequest | null;
}
