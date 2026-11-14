/**
 * Horizontal ink extent of KiCad's stroke font (newstroke), for text that
 * must be measured to contain what KiCad draws rather than to approximate it.
 *
 * The legibility checker's general text box (`TEXT_ADVANCE`, design C3) is
 * tuned short on purpose so it never invents a collision. A group caption is
 * the opposite case: the checker asks whether the caption stays inside its
 * group box, and a short box hides a caption that visibly escapes (#307). The
 * engine sizes group boxes with the same function, so its own drafts contain
 * their captions by construction and the checker only confirms it.
 *
 * Metrics were measured from `kicad-cli sch export svg` (9.0.8) stroke paths
 * at 10 mm, bold, `justify left top`, one entry per printable ASCII glyph from
 * U+0020, in fractions of the font height:
 *   - ADVANCE: pen travel to the next glyph, `(x(c*11) - x(c)) / 10`
 *   - INK_LEFT / INK_RIGHT: stroke centre-line extent from the glyph origin
 * Bold and regular advance identically; bold only thickens the pen.
 */

const ADVANCE = [
  0.7619, 0.4762, 0.7619, 1, 0.9524, 1.1429, 1.2381, 0.4762, 0.6667, 0.6667, 0.7619, 1.2381, 0.4762, 1.2381, 0.4762, 1.0476,
  0.9524, 0.9524, 0.9524, 0.9524, 0.9524, 0.9524, 0.9524, 0.9524, 0.9524, 0.9524, 0.4762, 0.4762, 1.2381, 1.2381, 1.2381, 0.8571,
  1.2857, 0.8571, 1, 1, 1, 0.9048, 0.8571, 1, 1.0476, 0.4762, 0.7619, 1, 0.8095, 1.1429, 1.0476, 1.0476,
  1, 1.0476, 1, 0.9524, 0.7619, 1.0476, 0.8571, 1.1429, 0.9524, 0.8571, 0.9524, 0.6667, 0.6667, 0.6667, 0.5714, 0.7619,
  0.381, 0.9048, 0.9048, 0.8571, 0.9048, 0.8571, 0.5714, 0.9048, 0.9048, 0.4762, 0.4762, 0.8095, 0.5238, 1.3333, 0.9048, 0.9048,
  0.9048, 0.9048, 0.619, 0.8095, 0.5714, 0.9048, 0.7619, 1.0476, 0.8095, 0.7619, 0.8095, 0.6667, 0.9524, 0.6667, 0.7143,
];
// NaN: a space draws no ink
const INK_LEFT = [
  NaN, 0.322, 0.322, 0.2268, 0.322, 0.322, 0.3697, 0.322, 0.3697, 0.2744, 0.2744, 0.3697, 0.322, 0.3697, 0.322, 0.2268,
  0.322, 0.322, 0.2744, 0.2744, 0.322, 0.322, 0.322, 0.2744, 0.322, 0.322, 0.322, 0.322, 0.3697, 0.3697, 0.3697, 0.322,
  0.322, 0.2268, 0.3697, 0.322, 0.3697, 0.3697, 0.3697, 0.322, 0.3697, 0.3697, 0.2744, 0.3697, 0.3697, 0.3697, 0.3697, 0.322,
  0.3697, 0.322, 0.3697, 0.322, 0.2268, 0.3697, 0.2268, 0.2744, 0.2744, 0.2268, 0.2744, 0.4173, 0.0363, 0.2744, 0.2268, 0.1316,
  0.2268, 0.322, 0.3697, 0.322, 0.322, 0.322, 0.2268, 0.322, 0.3697, 0.322, 0.1792, 0.3697, 0.3697, 0.3697, 0.3697, 0.322,
  0.3697, 0.322, 0.3697, 0.322, 0.2268, 0.3697, 0.2744, 0.2744, 0.2744, 0.2744, 0.2744, 0.322, 0.6078, 0.2744, 0.2268,
];
const INK_RIGHT = [
  NaN, 0.4173, 0.703, 1.0363, 0.8935, 1.084, 1.1792, 0.4173, 0.6554, 0.5601, 0.7506, 1.1316, 0.4173, 1.1316, 0.4173, 1.084,
  0.8935, 0.8935, 0.8935, 0.8935, 0.9411, 0.8935, 0.8935, 0.9411, 0.8935, 0.8935, 0.4173, 0.4173, 1.1316, 1.1316, 1.1316, 0.7982,
  1.2268, 0.8935, 0.9411, 0.9411, 0.9411, 0.8459, 0.8459, 0.9411, 0.9411, 0.3697, 0.6554, 0.9411, 0.8459, 1.0363, 0.9411, 0.9887,
  0.9411, 1.0363, 0.9411, 0.8935, 0.7982, 0.9411, 0.8935, 1.1316, 0.9411, 0.8935, 0.9411, 0.6554, 0.8935, 0.5125, 0.6078, 0.8935,
  0.3697, 0.7982, 0.8459, 0.7982, 0.7982, 0.7982, 0.6078, 0.7982, 0.7982, 0.4173, 0.4173, 0.7506, 0.5125, 1.2268, 0.7982, 0.8459,
  0.8459, 0.7982, 0.6554, 0.7506, 0.6078, 0.7982, 0.7506, 1.0363, 0.7982, 0.7506, 0.7982, 0.6554, 0.6078, 0.6078, 0.703,
];
/** A glyph outside the table (non-ASCII) is measured as the widest one, ink across its whole advance. */
const WIDEST = Math.max(...ADVANCE);
/** Extra width KiCad adds to a line when it aligns it centre or right: the
 * shift is `(sum of advances + ALIGN_PAD) * h / 2` and `* h` respectively. */
const ALIGN_PAD = 0.2636;
/** Half the bold pen (KiCad draws bold at a pen of h / 5). */
const HALF_BOLD_PEN = 0.1;
/** Top-to-top distance of the lines of multi-line text, per height (1.61 at every size, bold or not). */
export const LINE_PITCH = 1.61;
/** Regular text sits up to 0.112 h to one side of where bold sits; the
 * table is bold, so both sides get this much slack and one extent covers
 * either weight. */
const WEIGHT_SLACK = 0.12;

const metric = (ch: string): { adv: number; left: number; right: number } => {
  const i = ch.codePointAt(0)! - 0x20;
  if (i < 0 || i >= ADVANCE.length) return { adv: WIDEST, left: 0, right: WIDEST };
  return { adv: ADVANCE[i]!, left: INK_LEFT[i]!, right: INK_RIGHT[i]! };
};

/**
 * Ink extent of `text` at font height `h` (mm) along its baseline, relative
 * to its anchor, for KiCad's horizontal justification. Multi-line text
 * measures its widest line. Conservative by at most `WEIGHT_SLACK * h` a side.
 */
export function strokeTextExtent(text: string, h: number, justify: 'left' | 'center' | 'right'): { minX: number; maxX: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const line of text.split('\n')) {
    let pen = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const ch of line) {
      const m = metric(ch);
      if (!Number.isNaN(m.left)) {
        lo = Math.min(lo, pen + m.left);
        hi = Math.max(hi, pen + m.right);
      }
      pen += m.adv;
    }
    if (lo === Infinity) continue;
    const shift = justify === 'left' ? 0 : justify === 'center' ? -(pen + ALIGN_PAD) / 2 : -(pen + ALIGN_PAD);
    minX = Math.min(minX, lo + shift);
    maxX = Math.max(maxX, hi + shift);
  }
  if (minX === Infinity) return { minX: 0, maxX: 0 };
  const pad = HALF_BOLD_PEN + WEIGHT_SLACK;
  return { minX: (minX - pad) * h, maxX: (maxX + pad) * h };
}

/** Height of the glyph cells `text` occupies: `h` per line, lines `LINE_PITCH * h` apart. */
export function strokeTextHeight(text: string, h: number): number {
  return h * (1 + (text.split('\n').length - 1) * LINE_PITCH);
}

/**
 * `text` broken at one space into two lines, at the space whose wider line is
 * the narrowest (ties: the earlier space), or null when it has no space to
 * break at. Left-justified, so the widths are the lines' ink extents.
 */
export function wrapTwoLines(text: string, h: number): string | null {
  let best: { text: string; w: number } | null = null;
  for (let i = text.indexOf(' '); i >= 0; i = text.indexOf(' ', i + 1)) {
    const a = text.slice(0, i).trimEnd();
    const b = text.slice(i + 1).trimStart();
    if (!a || !b) continue;
    const w = Math.max(strokeTextExtent(a, h, 'left').maxX, strokeTextExtent(b, h, 'left').maxX);
    if (!best || w < best.w - 1e-9) best = { text: `${a}\n${b}`, w };
  }
  return best?.text ?? null;
}
