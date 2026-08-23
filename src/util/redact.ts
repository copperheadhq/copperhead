/**
 * Write-time secret redaction for transcripts and summaries (AC-4.1).
 * Patterns are deliberately broad: losing a few characters of log fidelity
 * beats leaking a key.
 */
const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]+/g,
  // Auth schemes are case-insensitive (RFC 7235 §2.1), and the token charset has
  // to include base64's +, / and = or the match stops at the first one and the
  // tail of the secret gets written out verbatim.
  /Bearer\s+[A-Za-z0-9._+/=-]{16,}/gi,
  // Registry and forge tokens: a transcript that quotes a publish command or a
  // failing CI log can carry these just as easily as a model API key.
  // npm also issues UUID-shaped tokens, so the charset allows dashes.
  /npm_[A-Za-z0-9-]{36,}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  // Gemini and Groq keys: same idea as sk- above, just a different prefix.
  // Real keys are AIza + 35 chars, but AIzaSy (the common fifth/sixth pair)
  // isn't the only prefix Google issues - match on AIza alone so other
  // Google keys aren't left unredacted.
  /AIza[A-Za-z0-9_-]{20,}/g,
  /gsk_[A-Za-z0-9]{20,}/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}
