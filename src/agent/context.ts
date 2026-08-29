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
  /** Last check_legibility counts; feeds the run summary's verification section. */
  lastLegibility: { error: number; advisory: number } | null;
  /** Last score composite (AC-16.21); recorded in the run summary. */
  lastScore: number | null;
  /** Last `check_drift` output; used by `generate_report` completion. */
  lastDrift?: string | null;
  repairCycles: number;
  finishRequest: FinishRequest | null;
}
