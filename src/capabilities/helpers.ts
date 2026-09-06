import { isKicadFile } from '../util/paths.js';
import type { RunContext } from '../agent/context.js';

export const str = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new Error(`missing required string arg "${key}"`);
  return v;
};

// U+FFFD (the Unicode replacement character) is what a byte sequence becomes
// when UTF-8 decoding fails — most often a multibyte glyph (Ω, µ, ±, °) split
// across a streaming chunk boundary and decoded per-chunk upstream in the
// provider SDK (I2). It never appears in a legitimately authored PCB doc, so
// its presence in a content-bearing tool arg means the value arrived corrupted.
// Reject the call before it lands on disk so the model re-emits; the corruption
// is nondeterministic (it depends on where a chunk boundary fell), so the retry
// almost always comes through clean — far cheaper than shipping a mangled value
// like "5.1kΩ" → "5.1k�" into DECISIONS.md and only noticing on review.
const REPLACEMENT_CHAR = '�';
export function corruptionError(fields: Record<string, unknown>): string | null {
  const bad = Object.entries(fields)
    .filter(([, v]) => typeof v === 'string' && v.includes(REPLACEMENT_CHAR))
    .map(([k]) => k);
  if (!bad.length) return null;
  return `rejected: the ${bad.join(', ')} value contains U+FFFD (�), the replacement character that signals a UTF-8 decoding error — a special character (e.g. Ω, µ, ±, °) was likely mangled in transit. Re-send this exact call with the intended character written correctly, or spell it in ASCII (e.g. "ohm", "uF", "+/-", "deg").`;
}

export function markTouched(ctx: RunContext, rel: string): void {
  ctx.filesTouched.add(rel);
  if (isKicadFile(rel)) {
    ctx.ledger.onKicadEdit(rel);
    if (rel.endsWith('.kicad_sch')) ctx.lastErc = null;
    if (rel.endsWith('.kicad_pcb')) ctx.lastDrc = null;
  } else if (rel.endsWith('.md')) {
    ctx.ledger.onDocEdit(rel);
  }
}
