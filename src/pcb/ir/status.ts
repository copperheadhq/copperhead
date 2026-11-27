/**
 * Terminal statuses of a layout run (RFC 11 §12.5). One enum, used identically
 * by the CLI, the agent tools, the benchmark, and the evidence bundle.
 */
export type LayoutStatus = 'PASS' | 'PARTIAL' | 'HOLD' | 'REFUSE' | 'UNSUPPORTED' | 'TIMEOUT' | 'ENGINE_ERROR' | 'INVALID_OUTPUT';

export const LAYOUT_STATUSES: readonly LayoutStatus[] = ['PASS', 'PARTIAL', 'HOLD', 'REFUSE', 'UNSUPPORTED', 'TIMEOUT', 'ENGINE_ERROR', 'INVALID_OUTPUT'];

/** Process exit code per status (implementation spec §2); usage errors keep 1. */
export const EXIT_CODE: Record<LayoutStatus, number> = {
  PASS: 0,
  PARTIAL: 0,
  HOLD: 2,
  REFUSE: 3,
  UNSUPPORTED: 4,
  TIMEOUT: 5,
  ENGINE_ERROR: 6,
  INVALID_OUTPUT: 7,
};

/** RFC 10 run state a layout status ends in. */
export function runState(status: LayoutStatus): 'SUCCEEDED' | 'WAITING_FOR_APPROVAL' | 'FAILED' {
  if (status === 'PASS' || status === 'PARTIAL') return 'SUCCEEDED';
  if (status === 'HOLD') return 'WAITING_FOR_APPROVAL';
  return 'FAILED';
}

export interface Outcome<TDiagnostic = unknown> {
  status: LayoutStatus;
  /** One line a human reads first. */
  summary: string;
  /** PARTIAL: what remains. HOLD: what is needed. REFUSE/UNSUPPORTED: why. */
  detail: string[];
  /** Diagnostics that produced this outcome, when any. */
  diagnostics: TDiagnostic[];
}

/** Why an engine invocation did not produce a usable result. */
export type EngineErrorKind =
  | 'no-binary'
  | 'no-runtime'
  | 'runtime-too-old'
  | 'timeout'
  | 'process-failed'
  /** The engine refused the board on its own safety rule (a grid it cannot route cleanly, a feature it does not do); no crash, and nothing to retry. */
  | 'declined'
  | 'no-output'
  | 'malformed-output'
  | 'empty-result'
  | 'schema-mismatch';

export class EngineError extends Error {
  constructor(
    public readonly kind: EngineErrorKind,
    message: string,
    /** What the operator can do about it. */
    public readonly fix: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
