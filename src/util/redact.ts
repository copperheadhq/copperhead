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
  // Google OAuth2 access tokens (the Vertex route's wire credential when ADC
  // is in play). ya29. is the stable user/SA access-token prefix; the charset
  // includes the dots and dashes real tokens carry.
  /ya29\.[A-Za-z0-9._-]{20,}/g,
  // PEM private-key blocks, e.g. the private_key field of a GCP
  // service-account JSON quoted into a log. Matches the whole block including
  // header/footer so no key material survives; [\s\S] because the body spans
  // lines (escaped \n in JSON, real newlines in a .pem).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Defence in depth for a block whose footer never arrives: output truncated
  // mid-key, or a stream cut between header and footer. Anchored on the header
  // and consuming only the base64 body lines that follow it, so it stops at
  // the first line that isn't key material and can't swallow a log. Each
  // repetition must begin with a newline (not in the body charset), so there
  // is exactly one way to match — linear, no backtracking. The {16,} floor
  // keeps it off ordinary prose: real body lines are 64 chars, and without a
  // length floor a following word like "not" is itself valid base64 and gets
  // eaten off the front of the next line.
  //
  // Note this is a *bound on the damage*, not a second complete defence: it
  // needs the header in the same string as the body, so a caller that redacts
  // line by line still writes the body out. Callers must redact whole
  // messages before splitting (see repl.ts's log()).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\r?\n[A-Za-z0-9+/=]{16,})*/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}
