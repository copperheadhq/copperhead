import { redactSecrets } from '../util/redact.js';

/** Envelope protocol version for the ToolResult shape (design D5). */
export const PROTOCOL_VERSION = 1;

export type ViewHint = 'diagnostic' | 'mutation' | 'query' | 'export';
export type ToolErrorKind = 'unavailable' | 'validation' | 'refusal' | 'exception';

export interface ToolResult {
  ok: boolean;
  summary: string;
  detail?: string;
  data?: unknown;
  error?: { kind: ToolErrorKind; message: string };
  viewHint?: ViewHint;
}

function redactEnvelopeText(text: string): string {
  let out = redactSecrets(text);
  for (const [name, val] of Object.entries(process.env)) {
    if (!val || val.length < 8) continue;
    if (!/_(KEY|SECRET|TOKEN)$/.test(name)) continue;
    if (out.includes(val)) out = out.split(val).join('[REDACTED]');
  }
  return out;
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactEnvelopeText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

/** Redact every string field at construction so render/dock never see secrets. */
export function seal(partial: ToolResult): ToolResult {
  return {
    ok: partial.ok,
    summary: redactEnvelopeText(partial.summary),
    ...(partial.detail !== undefined ? { detail: redactEnvelopeText(partial.detail) } : {}),
    ...(partial.data !== undefined ? { data: redactDeep(partial.data) } : {}),
    ...(partial.error
      ? { error: { kind: partial.error.kind, message: redactEnvelopeText(partial.error.message) } }
      : {}),
    ...(partial.viewHint ? { viewHint: partial.viewHint } : {}),
  };
}

export function okResult(text: string, viewHint?: ViewHint, data?: unknown): ToolResult {
  const first = text.split('\n')[0] ?? text;
  return seal({
    ok: true,
    summary: first,
    ...(text !== first ? { detail: text } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(viewHint ? { viewHint } : {}),
  });
}

export function failResult(kind: ToolErrorKind, message: string, viewHint?: ViewHint): ToolResult {
  const first = message.split('\n')[0] ?? message;
  return seal({
    ok: false,
    summary: first,
    error: { kind, message },
    ...(viewHint ? { viewHint } : {}),
  });
}

/** Flatten an envelope to the string providers already consume as tool Msg content. */
export function flatten(result: ToolResult): string {
  if (!result.ok) return result.error?.message ?? result.summary;
  if (result.detail) {
    return result.detail.startsWith(result.summary) ? result.detail : `${result.summary}\n${result.detail}`;
  }
  return result.summary;
}

/**
 * Wrap a legacy handler string. Error-shaped prefixes become typed failures so
 * validation/refusal are not retried; everything else is success. Flattened
 * text equals the original string.
 */
export function textResult(text: string, viewHint: ViewHint): ToolResult {
  if (
    /^error:/.test(text) ||
    text.startsWith('rejected:') ||
    text.startsWith('edit REVERTED') ||
    text.startsWith('validation FAILED')
  ) {
    return failResult('validation', text, viewHint);
  }
  if (
    text.startsWith('refused:') ||
    text.startsWith('cannot finish yet') ||
    text.startsWith('proposal validated but human declined')
  ) {
    return failResult('refusal', text, viewHint);
  }
  return okResult(text, viewHint);
}

export function isRetryableToolKind(kind: ToolErrorKind): boolean {
  return kind === 'exception';
}

export function unavailable(name: string, editsUnlocked: boolean): ToolResult {
  const message = `tool "${name}" is not available${editsUnlocked ? '' : ' (edit tools unlock after the proposal validates)'}`;
  return failResult('unavailable', message);
}
