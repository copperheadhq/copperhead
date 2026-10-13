import { redactSecrets } from './redact.js';

/**
 * Formats a caught error for CLI stderr. Transcripts and summaries already
 * redact secret material at write time (AC-4.1); the CLI's own error output
 * was the one surface that printed a caught error's message straight to the
 * terminal with no redaction, so a key-shaped string reaching an error
 * message (a provider SDK error, a misconfigured endpoint) would leak there
 * even though it would have been caught everywhere else.
 */
export function formatCliError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactSecrets(message);
}
