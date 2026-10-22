/**
 * Write-time secret redaction for transcripts and summaries (AC-4.1).
 * Patterns are deliberately broad: losing a few characters of log fidelity
 * beats leaking a key.
 */
const PATTERNS: RegExp[] = [
  // At the start of a token any sk- run is a key. Glued to a word it is a key
  // only when it is long and holds a digit, as generated keys do: otherwise
  // "mask-defined", "risk-free" and "task-P" lost their tails, which also
  // broke review quotations that must survive verbatim, while a key printed
  // as "vsk-..." must still go.
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]+|sk-(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{16,}/g,
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

/**
 * Some endpoints embed a credential in the URL itself (a query param or
 * userinfo): Gemini's OpenAI-compat endpoint does this with ?key=....
 * redactSecrets only catches known key shapes, and a key embedded in a URL
 * query is not reliably one of them, so this drops the query and userinfo
 * entirely rather than pattern-matching, regardless of shape. Used anywhere
 * a configured `baseURL` is shown to the user or embedded in an error
 * message (doctor's credential display, makeProvider's compat errors).
 *
 * A schemeless host:port string (no `//`, e.g. "localhost:11434/v1" or
 * "myhost:8080/v1") parses as an opaque `scheme:path` URL rather than
 * throwing: `u.origin` is the literal string "null" and the rest ends up in
 * `pathname` verbatim, credential included. Trust the parsed origin only
 * when it is real; otherwise fall through to a structural strip (query,
 * fragment, userinfo) before the pattern-based fallback, same as the throw
 * case, instead of handing back the unparsed input.
 */
export function sanitizeEndpoint(url: string | undefined): string {
  if (!url) return '(no endpoint configured)';
  try {
    const u = new URL(url);
    if (u.origin !== 'null') return `${u.origin}${u.pathname}`;
  } catch {
    // fall through to the structural strip below
  }
  return redactSecrets(url.replace(/[?#].*$/s, '').replace(/^[^/]*@/, ''));
}
