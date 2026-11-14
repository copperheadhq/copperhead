/**
 * Spans of s-expression source text: where a list starts and ends, and its
 * direct children, honoring quoted strings. Writers that splice KiCad files
 * (board populate, the sym-lib-table rewrite) use these to keep every byte
 * they do not change, rather than serializing a parse tree (SPEC §1.3).
 */

export interface Span {
  start: number;
  /** exclusive */
  end: number;
  tag: string;
}

/** End (exclusive) of the list opening at `open`, honoring quoted strings. */
export function listEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  throw new Error('unbalanced s-expression');
}

/** Direct child lists of the list opening at `open`. */
export function childSpans(text: string, open: number): Span[] {
  const end = listEnd(text, open);
  const out: Span[] = [];
  for (let i = open + 1; i < end - 1; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < end && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '(') {
      const e = listEnd(text, i);
      out.push({ start: i, end: e, tag: /^\(\s*([^\s()"]+)/.exec(text.slice(i, i + 64))?.[1] ?? '' });
      i = e - 1;
    }
  }
  return out;
}
