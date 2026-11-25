/**
 * Block scanner over raw KiCad s-expression text. The IR reader parses each
 * top-level block on its own, and the exporter replaces blocks in place, so
 * both need the same view: head, byte offsets, and verbatim text. Strings and
 * escapes are honoured; nothing is serialized (SPEC §1.3 / design D4).
 */

export interface Block {
  head: string;
  /** Offset of the opening paren. */
  start: number;
  /** Offset one past the closing paren. */
  end: number;
  text: string;
}

/** End offset (exclusive) of the list opening at `start`, honouring quoted strings. */
export function blockEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
    } else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return n;
}

function headAt(text: string, start: number): string {
  let i = start + 1;
  while (i < text.length && !/[\s()"]/.test(text[i]!)) i++;
  return text.slice(start + 1, i);
}

/** Direct children of the list opening at `start` (default: the file's root list). */
export function childBlocks(text: string, start = text.indexOf('(')): Block[] {
  const out: Block[] = [];
  if (start < 0) return out;
  const end = blockEnd(text, start);
  let i = start + 1;
  // skip the head token
  while (i < end && !/[\s()"]/.test(text[i]!)) i++;
  while (i < end) {
    const c = text[i]!;
    if (c === '(') {
      const e = blockEnd(text, i);
      out.push({ head: headAt(text, i), start: i, end: e, text: text.slice(i, e) });
      i = e;
    } else if (c === '"') {
      i++;
      while (i < end && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
    } else i++;
  }
  return out;
}

/** Top-level records of a `.kicad_pcb` (children of `(kicad_pcb …)`). */
export function topLevelBlocks(text: string): Block[] {
  return childBlocks(text);
}

/** Remove the direct children with the given head from a block's text (used to drop zone fills). */
export function stripChildren(blockText: string, head: string): string {
  const kids = childBlocks(blockText).filter((b) => b.head === head);
  if (!kids.length) return blockText;
  let out = '';
  let cursor = 0;
  for (const k of kids) {
    // also swallow the whitespace before the child so indentation stays tidy
    let s = k.start;
    while (s > cursor && /[ \t\r\n]/.test(blockText[s - 1]!)) s--;
    out += blockText.slice(cursor, s);
    cursor = k.end;
  }
  out += blockText.slice(cursor);
  return out;
}
