import { type SheetGeometry, type Bounds } from './sexp.js';
import { checkLegibilityWithGeometry, type LegibilityReport } from './legibility.js';
import type { LegibilityUserConfig } from '../config.js';

/**
 * Deterministic quantitative scorer (design D7/D11). The checker decides
 * pass/fail on unambiguous defects; this measures the judgment calls — wiring
 * economy, alignment, symmetry, balance — as a weighted 0-100 composite whose
 * per-metric breakdown is always reported. Any error-severity legibility
 * finding caps the composite below the known-good floor, so a high score can
 * never coexist with a gating defect. No LLM, no network, no subprocess.
 */

export interface ScoreMetric {
  name: string;
  /** Raw measured value, full precision before rounding. */
  raw: number;
  /** Normalized goodness in [0, 1]. */
  score: number;
  weight: number;
  /** Weighted contribution to the composite (points). */
  contribution: number;
}

export interface ScoreReport {
  composite: number;
  metrics: ScoreMetric[];
  /** Applied error-finding cap, or null. */
  cap: { appliedAt: number; reason: string } | null;
  legibility: { error: number; advisory: number };
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  'wire-crossings': 10,
  'wire-bends': 5,
  'wire-length': 5,
  'label-to-wire-ratio': 5,
  'group-cohesion': 10,
  'flow-direction': 10,
  utilization: 10,
  'axis-alignment': 10,
  'spacing-uniformity': 10,
  'straight-wire-ratio': 5,
  'label-alignment': 5,
  'whitespace-balance': 10,
  'pair-symmetry': 5,
};

/** Composite is capped this far below the Tier A floor when errors exist. */
const DEFAULT_FLOOR = 85;
const ERROR_CAP = 40;
/** Top-edge spread (mm) within which two group boxes count as the same row. */
const ROW_BAND = 12;

const PAPER: Record<string, { w: number; h: number }> = {
  A5: { w: 210, h: 148 },
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
  A1: { w: 841, h: 594 },
  A0: { w: 1189, h: 841 },
};

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const segLen = (s: Seg): number => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
const isVert = (s: Seg): boolean => s.x1 === s.x2;

function properCrossing(a: Seg, b: Seg): boolean {
  // orthogonal proper crossing (interiors intersect); shared endpoints are joins
  const [v, h] = isVert(a) && !isVert(b) ? [a, b] : !isVert(a) && isVert(b) ? [b, a] : [null, null];
  if (!v || !h) return false;
  const [hy, vx] = [h.y1, v.x1];
  const [hx1, hx2] = [Math.min(h.x1, h.x2), Math.max(h.x1, h.x2)];
  const [vy1, vy2] = [Math.min(v.y1, v.y2), Math.max(v.y1, v.y2)];
  return vx > hx1 + 0.01 && vx < hx2 - 0.01 && hy > vy1 + 0.01 && hy < vy2 - 0.01;
}

export interface ScoreOptions {
  docsDir?: string | null;
  config?: LegibilityUserConfig;
}

export async function scoreSchematic(rootSch: string, opts: ScoreOptions = {}): Promise<ScoreReport> {
  const { report, sheets } = await checkLegibilityWithGeometry(rootSch, {
    docsDir: opts.docsDir ?? null,
    ...(opts.config ? { config: opts.config } : {}),
  });
  return scoreFromGeometry(sheets, report, opts.config);
}

export function scoreFromGeometry(
  sheets: SheetGeometry[],
  legibility: LegibilityReport,
  config?: LegibilityUserConfig,
): ScoreReport {
  const weights = { ...DEFAULT_WEIGHTS };
  for (const [k, v] of Object.entries(config?.score?.weights ?? {})) {
    if (k in weights && typeof v === 'number' && Number.isFinite(v) && v >= 0) weights[k] = v;
  }
  // Sanitized like the weights above: a floor of 0 (or a non-number) would
  // push the error cap `min(ERROR_CAP, floor - 1)` negative or NaN.
  const rawFloor = config?.score?.floor;
  const floor = typeof rawFloor === 'number' && Number.isFinite(rawFloor) && rawFloor >= 1 ? rawFloor : DEFAULT_FLOOR;

  // ---- collect geometry across sheets ----
  const segs: Seg[] = sheets.flatMap((s) => s.wires);
  const labels = sheets.flatMap((s) => s.labels);
  const realSyms = sheets.flatMap((s) =>
    s.symbols.filter((y) => !y.isPower).map((y) => ({ ...y, sheet: s.sheetName })),
  );

  // wire crossings
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) if (properCrossing(segs[i]!, segs[j]!)) crossings++;
  }

  // bends: points where exactly two segments of different orientation meet
  const ends = new Map<string, Seg[]>();
  for (const s of segs) {
    for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]] as const) {
      const k = `${x},${y}`;
      ends.set(k, [...(ends.get(k) ?? []), s]);
    }
  }
  let bends = 0;
  for (const list of ends.values()) {
    if (list.length === 2 && isVert(list[0]!) !== isVert(list[1]!)) bends++;
  }

  const totalLen = segs.reduce((s, w) => s + segLen(w), 0);

  // group cohesion: same-name label pairs, mean anchor distance vs sheet diagonal
  const byName = new Map<string, { x: number; y: number }[]>();
  for (const l of labels) byName.set(l.name, [...(byName.get(l.name) ?? []), { x: l.x, y: l.y }]);
  const paper = PAPER[sheets[0]?.paper.name ?? 'A4'] ?? PAPER.A4!;
  const diag = Math.hypot(paper.w, paper.h);
  const pairDists: number[] = [];
  for (const pts of byName.values()) {
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) pairDists.push(Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y));
    }
  }
  const meanPair = pairDists.length ? pairDists.reduce((a, b) => a + b, 0) / pairDists.length : 0;

  // flow-direction: cross-group label nets should connect adjacent groups in
  // reading order; a hop across intervening groups reads as against-the-flow
  // wiring
  const rects = sheets.flatMap((s) => s.rectangles.map((r) => ({
    minX: Math.min(r.x1, r.x2),
    maxX: Math.max(r.x1, r.x2),
    minY: Math.min(r.y1, r.y2),
    maxY: Math.max(r.y1, r.y2),
  })));
  // Reading order is rows first, then left-to-right within a row. Ordering by
  // minX alone was correct only while every group sat in one band; on a sheet
  // whose groups wrap onto several rows it interleaves row 2 back into row 1
  // and reports flow violations for a drawing that reads perfectly.
  const byRow = [...rects].sort((a, b) => a.minY - b.minY || a.minX - b.minX);
  const rows: (typeof rects)[] = [];
  for (const r of byRow) {
    const row = rows[rows.length - 1];
    // Rows are separated by a group box height; members of one row share a top
    // edge to within a symbol cell, so a generous band still cannot merge two.
    if (row && r.minY - row[0]!.minY <= ROW_BAND) row.push(r);
    else rows.push([r]);
  }
  const ordered = rows.flatMap((row) => [...row].sort((a, b) => a.minX - b.minX));
  const groupIdx = (x: number, y: number): number =>
    ordered.findIndex((r) => x > r.minX && x < r.maxX && y > r.minY && y < r.maxY);
  /** Which wrapped row a point falls in; -1 when it is in no group box. */
  const rowIdx = (x: number, y: number): number =>
    rows.findIndex((row) => row.some((r) => x > r.minX && x < r.maxX && y > r.minY && y < r.maxY));
  let crossNets = 0;
  let flowViolations = 0;
  for (const pts of byName.values()) {
    const gs = [...new Set(pts.map((p) => groupIdx(p.x, p.y)).filter((g) => g >= 0))];
    if (gs.length > 1) {
      crossNets++;
      if (Math.max(...gs) - Math.min(...gs) > 1) flowViolations++;
    }
  }

  // utilization + whitespace balance over the first sheet's usable frame
  const items: Bounds[] = [
    ...realSyms.map((s) => ({ minX: s.at.x - 2, minY: s.at.y - 2, maxX: s.at.x + 2, maxY: s.at.y + 2 })),
    ...rects,
  ];
  const content = items.length
    ? items.reduce((a, b) => ({
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
      }))
    : null;
  const usable = { minX: 10, minY: 10, maxX: paper.w - 10, maxY: paper.h - 10 - 30 };
  const usableArea = (usable.maxX - usable.minX) * (usable.maxY - usable.minY);
  const utilization = content
    ? Math.min(1, ((content.maxX - content.minX) * (content.maxY - content.minY)) / usableArea)
    : 0;
  const centroidOff = content
    ? Math.hypot(
        (content.minX + content.maxX) / 2 - (usable.minX + usable.maxX) / 2,
        (content.minY + content.maxY) / 2 - (usable.minY + usable.maxY) / 2,
      ) / (diag / 2)
    : 1;

  // axis alignment: symbols sharing an origin axis with at least one other
  const sharesAxis = (i: number): boolean =>
    realSyms.some((o, j) => j !== i && (Math.abs(o.at.x - realSyms[i]!.at.x) < 0.01 || Math.abs(o.at.y - realSyms[i]!.at.y) < 0.01));
  const axisAligned = realSyms.length > 1 ? realSyms.filter((_, i) => sharesAxis(i)).length / realSyms.length : 1;

  // spacing uniformity: variance of consecutive gaps within shared-x columns
  const cols = new Map<string, number[]>();
  for (const s of realSyms) {
    // Keyed by row as well as x: a column is a vertical run the eye reads as
    // one stack. Once groups wrap, two symbols in different rows can share an x
    // while sitting a whole row apart, and treating that jump as a "gap" pushes
    // the coefficient of variation — and the score — off a cliff.
    const k = `${s.sheet}:${Math.round(s.at.x * 100)}:${rowIdx(s.at.x, s.at.y)}`;
    cols.set(k, [...(cols.get(k) ?? []), s.at.y]);
  }
  const gapCVs: number[] = [];
  for (const ys of cols.values()) {
    if (ys.length < 3) continue;
    ys.sort((a, b) => a - b);
    const gaps = ys.slice(1).map((y, i) => y - ys[i]!);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    gapCVs.push(mean > 0 ? sd / mean : 0);
  }
  const spacingUniformity = gapCVs.length ? Math.max(0, 1 - gapCVs.reduce((a, b) => a + b, 0) / gapCVs.length) : 1;

  // pair symmetry: same-libId+value symbols in one group aligned on a shared axis
  const pairKeys = new Map<string, { x: number; y: number }[]>();
  for (const s of realSyms) {
    const g = groupIdx(s.at.x, s.at.y);
    const k = `${g}:${s.libId}:${s.value}`;
    pairKeys.set(k, [...(pairKeys.get(k) ?? []), { x: s.at.x, y: s.at.y }]);
  }
  let pairs = 0;
  let symmetric = 0;
  for (const pts of pairKeys.values()) {
    if (pts.length < 2) continue;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        pairs++;
        if (Math.abs(pts[i]!.x - pts[j]!.x) < 0.01 || Math.abs(pts[i]!.y - pts[j]!.y) < 0.01) symmetric++;
      }
    }
  }
  const pairSymmetry = pairs ? symmetric / pairs : 1;

  const horizLabels = labels.length
    ? labels.filter((l) => Math.abs(l.rot % 180) !== 90).length / labels.length
    : 1;
  const straightRatio = segs.length ? Math.max(0, 1 - bends / segs.length) : 1;
  const labelRatio = segs.length ? labels.length / segs.length : labels.length ? 1 : 0;

  // ---- normalize to [0,1] goodness and compose ----
  const raw: Record<string, { raw: number; score: number }> = {
    'wire-crossings': { raw: crossings, score: 1 / (1 + crossings) },
    'wire-bends': { raw: bends, score: 1 / (1 + bends / 8) },
    'wire-length': { raw: totalLen, score: 1 / (1 + totalLen / (4 * diag)) },
    'label-to-wire-ratio': { raw: labelRatio, score: labelRatio <= 1.5 ? 1 : 1.5 / labelRatio },
    'group-cohesion': { raw: meanPair, score: pairDists.length ? Math.max(0, 1 - meanPair / diag) : 1 },
    'flow-direction': { raw: flowViolations, score: crossNets ? 1 - flowViolations / crossNets : 1 },
    utilization: { raw: utilization, score: Math.min(1, utilization / 0.5) },
    'axis-alignment': { raw: axisAligned, score: axisAligned },
    'spacing-uniformity': { raw: spacingUniformity, score: spacingUniformity },
    'straight-wire-ratio': { raw: straightRatio, score: straightRatio },
    'label-alignment': { raw: horizLabels, score: horizLabels },
    'whitespace-balance': { raw: centroidOff, score: Math.max(0, 1 - centroidOff) },
    'pair-symmetry': { raw: pairSymmetry, score: pairSymmetry },
  };
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const metrics: ScoreMetric[] = Object.entries(raw).map(([name, m]) => ({
    name,
    raw: m.raw,
    score: m.score,
    weight: weights[name]!,
    contribution: (100 * weights[name]! * m.score) / totalWeight,
  }));
  let composite = metrics.reduce((a, m) => a + m.contribution, 0);

  let cap: ScoreReport['cap'] = null;
  if (legibility.counts.error > 0) {
    const capValue = Math.min(ERROR_CAP, floor - 1);
    if (composite > capValue) {
      cap = {
        appliedAt: capValue,
        reason: `${legibility.counts.error} error-severity legibility finding(s) cap the composite below the known-good floor (${floor})`,
      };
      composite = capValue;
    }
  }

  return {
    composite: Math.round(composite * 100) / 100,
    metrics,
    cap,
    legibility: legibility.counts,
  };
}

export function formatScore(report: ScoreReport): string {
  const lines = [`score: ${report.composite}/100`];
  if (report.cap) lines.push(`  cap: ${report.cap.appliedAt} — ${report.cap.reason}`);
  for (const m of report.metrics) {
    lines.push(
      `  ${m.name}: raw ${Math.round(m.raw * 10000) / 10000}, score ${Math.round(m.score * 1000) / 1000}, weight ${m.weight}, contributes ${Math.round(m.contribution * 100) / 100}`,
    );
  }
  return lines.join('\n');
}