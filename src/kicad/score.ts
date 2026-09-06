import { readSheetGeometry, pinsOfUnit, pinAbsolute, type SheetGeometry, type Bounds } from './sexp.js';
import { checkLegibility, type LegibilityReport } from './legibility.js';
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
  /**
   * Wiring style, scored without the drafting standard's conventions. The
   * composite above needs group boxes, captions and a title block, so a
   * hand-drawn sheet that lacks them is capped at 40 whatever its craft.
   * This block measures only how the parts connect — the thing a reader of
   * any schematic judges first — and is never capped, so an engine draft
   * and the human drawing of the same circuit compare on one scale.
   */
  style: { composite: number; metrics: ScoreMetric[] };
  /** Applied error-finding cap, or null. */
  cap: { appliedAt: number; reason: string } | null;
  legibility: { error: number; advisory: number };
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  'pin-attachment': 10,
  'island-parts': 5,
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

/**
 * Weights of the convention-free style composite. Calibrated on the KiCad
 * demo corpus (fifteen hand-drawn projects, 17 to 1138 parts): a person wires
 * 90 to 100 % of two-pin parts straight to another part, leaves 0 to 2 % as
 * label-only islands, draws 0.3 to 1.2 power symbols per part and, outside
 * bus-heavy boards, under one label per part. Engine drafts before pin
 * attachment measured 14 to 53 % attached and 9 to 13 % islands.
 */
const STYLE_WEIGHTS: Record<string, number> = {
  'pin-attachment': 30,
  'island-parts': 20,
  'power-symbol-economy': 15,
  'labels-per-part': 15,
  'crossings-per-wire': 10,
  'straight-wire-ratio': 10,
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

/** Library prefixes whose multi-pin symbols are not ICs for the style metrics. */
const NOT_IC = /^(Connector|Switch|TestPoint|Mechanical|Jumper|Graphic|Device:Crystal|Device:Q_|Device:D_|Device:LED)/;

export interface WiringStyle {
  parts: number;
  ics: number;
  twoPin: number;
  powerSymbols: number;
  labels: number;
  /** two-pin parts with at least one pin wired straight to another part */
  twoPinAttached: number;
  /** two-pin parts whose every pin ends in a label or nothing */
  twoPinIslands: number;
  icPins: number;
  icPinsWired: number;
  icPinsLabelled: number;
}

/**
 * How the parts of a sheet set connect, by following wires from each placed
 * pin: to another part's pin, to a power symbol, to a net label, or nowhere.
 * Wire joins are endpoint-to-endpoint and endpoint-onto-segment (a T), the
 * same two ways KiCad itself joins them.
 */
export function measureWiringStyle(sheets: SheetGeometry[]): WiringStyle {
  const W: WiringStyle = { parts: 0, ics: 0, twoPin: 0, powerSymbols: 0, labels: 0, twoPinAttached: 0, twoPinIslands: 0, icPins: 0, icPinsWired: 0, icPinsLabelled: 0 };
  const key = (x: number, y: number): string => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  for (const sh of sheets) {
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(k) !== r) {
        const n = parent.get(k)!;
        parent.set(k, r);
        k = n;
      }
      return r;
    };
    const add = (k: string): void => {
      if (!parent.has(k)) parent.set(k, k);
    };
    const union = (a: string, b: string): void => {
      add(a);
      add(b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const w of sh.wires) union(key(w.x1, w.y1), key(w.x2, w.y2));
    const placed = sh.symbols.map((s) => ({
      s,
      pins: pinsOfUnit(sh.libPins.get(s.libId) ?? [], s.unit).map((p) => pinAbsolute(s.at, s.mirror, p)),
    }));
    for (const { pins } of placed) for (const p of pins) add(key(p.x, p.y));
    for (const l of sh.labels) add(key(l.x, l.y));
    // a point on a segment's interior joins it (T junction); index segments by
    // their fixed coordinate so this stays linear in practice
    const horiz = new Map<number, Seg[]>();
    const vert = new Map<number, Seg[]>();
    for (const w of sh.wires) {
      if (Math.abs(w.y1 - w.y2) < 0.01) horiz.set(Math.round(w.y1 * 100), [...(horiz.get(Math.round(w.y1 * 100)) ?? []), w]);
      else if (Math.abs(w.x1 - w.x2) < 0.01) vert.set(Math.round(w.x1 * 100), [...(vert.get(Math.round(w.x1 * 100)) ?? []), w]);
    }
    for (const k of [...parent.keys()]) {
      const [xs, ys] = k.split(',');
      const x = Number(xs) / 100;
      const y = Number(ys) / 100;
      for (const w of horiz.get(Number(ys)) ?? []) {
        if (x > Math.min(w.x1, w.x2) + 0.01 && x < Math.max(w.x1, w.x2) - 0.01) union(k, key(w.x1, w.y1));
      }
      for (const w of vert.get(Number(xs)) ?? []) {
        if (y > Math.min(w.y1, w.y2) + 0.01 && y < Math.max(w.y1, w.y2) - 0.01) union(k, key(w.x1, w.y1));
      }
    }
    const compOf = (x: number, y: number): string => find(key(x, y));
    const labelComps = new Set(sh.labels.map((l) => compOf(l.x, l.y)));
    const pinComps = new Map<string, { ref: string; power: boolean }[]>();
    for (const { s, pins } of placed) {
      for (const p of pins) {
        const c = compOf(p.x, p.y);
        pinComps.set(c, [...(pinComps.get(c) ?? []), { ref: s.ref, power: s.isPower }]);
      }
    }
    W.labels += sh.labels.length;
    for (const { s, pins } of placed) {
      if (s.isPower) {
        W.powerSymbols++;
        continue;
      }
      if (!pins.length) continue;
      W.parts++;
      const kinds = pins.map((p) => {
        const c = compOf(p.x, p.y);
        const others = (pinComps.get(c) ?? []).filter((o) => o.ref !== s.ref);
        if (others.some((o) => !o.power)) return 'part';
        if (others.some((o) => o.power)) return 'power';
        if (labelComps.has(c)) return 'label';
        return 'open';
      });
      if (pins.length === 2) {
        W.twoPin++;
        if (kinds.includes('part')) W.twoPinAttached++;
        else if (kinds.every((k) => k === 'label' || k === 'open')) W.twoPinIslands++;
      }
      if (pins.length >= 3 && !NOT_IC.test(s.libId)) {
        W.ics++;
        for (const k of kinds) {
          W.icPins++;
          if (k === 'part') W.icPinsWired++;
          else if (k === 'label') W.icPinsLabelled++;
        }
      }
    }
  }
  return W;
}

export interface ScoreOptions {
  docsDir?: string | null;
  config?: LegibilityUserConfig;
}

export async function scoreSchematic(rootSch: string, opts: ScoreOptions = {}): Promise<ScoreReport> {
  const sheets = await readSheetGeometry(rootSch);
  const legibility = await checkLegibility(rootSch, {
    docsDir: opts.docsDir ?? null,
    ...(opts.config ? { config: opts.config } : {}),
  });
  return scoreFromGeometry(sheets, legibility, opts.config);
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

  // wiring style: how the parts connect (see STYLE_WEIGHTS for the calibration)
  const ws = measureWiringStyle(sheets);
  const attachment = ws.twoPin ? ws.twoPinAttached / ws.twoPin : 1;
  const islands = ws.twoPin ? ws.twoPinIslands / ws.twoPin : 0;
  const powerPerPart = ws.parts ? ws.powerSymbols / ws.parts : 0;
  const labelsPerPart = ws.parts ? ws.labels / ws.parts : 0;

  const horizLabels = labels.length
    ? labels.filter((l) => Math.abs(l.rot % 180) !== 90).length / labels.length
    : 1;
  const straightRatio = segs.length ? Math.max(0, 1 - bends / segs.length) : 1;
  const labelRatio = segs.length ? labels.length / segs.length : labels.length ? 1 : 0;

  // ---- normalize to [0,1] goodness and compose ----
  const raw: Record<string, { raw: number; score: number }> = {
    'pin-attachment': { raw: attachment, score: Math.min(1, attachment / 0.9) },
    'island-parts': { raw: islands, score: Math.max(0, 1 - islands / 0.2) },
    'power-symbol-economy': { raw: powerPerPart, score: powerPerPart <= 0.8 ? 1 : 0.8 / powerPerPart },
    'labels-per-part': { raw: labelsPerPart, score: labelsPerPart <= 1 ? 1 : 1 / labelsPerPart },
    'wire-crossings': { raw: crossings, score: 1 / (1 + crossings) },
    // the absolute count above floors at zero on any large board; per wire it
    // stays comparable across sizes (the 1138-part demo crosses 0.77 per wire,
    // the 89-part one 0.03)
    'crossings-per-wire': { raw: segs.length ? crossings / segs.length : 0, score: 1 / (1 + 10 * (segs.length ? crossings / segs.length : 0)) },
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
  const totalWeight = Object.entries(weights).reduce((a, [k, v]) => a + (k in raw ? v : 0), 0) || 1;
  const metrics: ScoreMetric[] = Object.entries(raw)
    .filter(([name]) => name in weights)
    .map(([name, m]) => ({
      name,
      raw: m.raw,
      score: m.score,
      weight: weights[name]!,
      contribution: (100 * weights[name]! * m.score) / totalWeight,
    }));
  let composite = metrics.reduce((a, m) => a + m.contribution, 0);
  const styleTotal = Object.values(STYLE_WEIGHTS).reduce((a, b) => a + b, 0);
  const styleMetrics: ScoreMetric[] = Object.entries(STYLE_WEIGHTS).map(([name, weight]) => ({
    name,
    raw: raw[name]!.raw,
    score: raw[name]!.score,
    weight,
    contribution: (100 * weight * raw[name]!.score) / styleTotal,
  }));
  const styleComposite = Math.round(styleMetrics.reduce((a, m) => a + m.contribution, 0) * 100) / 100;

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
    style: { composite: styleComposite, metrics: styleMetrics },
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
  if (report.style) {
    lines.push(`wiring style: ${report.style.composite}/100 (convention-free, never capped)`);
    for (const m of report.style.metrics) {
      lines.push(`  ${m.name}: raw ${Math.round(m.raw * 10000) / 10000}, score ${Math.round(m.score * 1000) / 1000}, weight ${m.weight}`);
    }
  }
  return lines.join('\n');
}