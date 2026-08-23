import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  readSheetGeometry,
  pinAbsolute,
  type Bounds,
  type SheetGeometry,
  type TextItem,
  type LabelItem,
  type RectItem,
  type WireSeg,
  type PlacedSymbolGeom,
} from './sexp.js';
import type { LegibilityUserConfig } from '../config.js';

/**
 * Deterministic read-only legibility checker (design C1-C9). Pure geometry over
 * the sexp accessors: no serialization, no file writes, no subprocess, no
 * network, no LLM. `check` reports its findings; the create pipeline gates on
 * them (design C6).
 */

export const LEGIBILITY_FAMILIES = [
  'off-grid',
  'symbol-overlap',
  'text-collision',
  'wire-through-symbol',
  'out-of-frame',
  'ungrouped-symbol',
  'unlabeled-group',
  'group-overlap',
  'empty-title-block',
  'label-orientation',
  'low-utilization',
  'crowding',
  'cross-group-wire',
] as const;

export type LegibilityKind = (typeof LEGIBILITY_FAMILIES)[number];
export type Severity = 'error' | 'advisory';

const DEFAULT_SEVERITY: Record<LegibilityKind, Severity> = {
  'off-grid': 'error',
  'symbol-overlap': 'error',
  'text-collision': 'error',
  'wire-through-symbol': 'error',
  'out-of-frame': 'error',
  'ungrouped-symbol': 'error',
  'unlabeled-group': 'error',
  'group-overlap': 'error',
  'empty-title-block': 'error',
  'label-orientation': 'advisory',
  'low-utilization': 'advisory',
  crowding: 'advisory',
  'cross-group-wire': 'advisory',
};

export interface LegibilityThresholds {
  gridPitch: number;
  minPitch: number;
  utilization: number;
  maxWireLength: number;
  familyCap: number;
}

export const DEFAULT_THRESHOLDS: LegibilityThresholds = {
  gridPitch: 1.27,
  minPitch: 2.54,
  utilization: 0.5,
  maxWireLength: 50.8,
  familyCap: 10,
};

/** File-precision noise must never flip a finding (design C7). */
const TOL = 0.01;
/** Stroke-font advance as a fraction of height, tuned BELOW the true average (design C3). */
const TEXT_ADVANCE = 0.6;
/** Drawing-frame inset from the paper edge. */
const FRAME_BORDER = 10;
/** Reserved title-block rectangle in the bottom-right of the frame, clamped on small pages. */
const TITLE_BLOCK_W = 110;
const TITLE_BLOCK_H = 30;

/** Standard sizes as KiCad draws them for schematics: landscape, mm. */
const PAPER_SIZES: Record<string, { w: number; h: number }> = {
  A5: { w: 210, h: 148 },
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
  A1: { w: 841, h: 594 },
  A0: { w: 1189, h: 841 },
  A: { w: 279.4, h: 215.9 },
  B: { w: 431.8, h: 279.4 },
  C: { w: 558.8, h: 431.8 },
  D: { w: 863.6, h: 558.8 },
  E: { w: 1117.6, h: 863.6 },
  USLetter: { w: 279.4, h: 215.9 },
  USLegal: { w: 355.6, h: 215.9 },
  USLedger: { w: 431.8, h: 279.4 },
};

export interface LegibilityFinding {
  kind: LegibilityKind;
  severity: Severity;
  sheet: string;
  at: { x: number; y: number };
  refs: string[];
  detail: string;
}

export interface LegibilityReport {
  findings: LegibilityFinding[];
  counts: { error: number; advisory: number };
  skipped: { family: string; reason: string }[];
  disabled: string[];
  suppressed: { family: LegibilityKind; sheet: string; count: number }[];
  sheets: number;
}

interface ResolvedConfig {
  thresholds: LegibilityThresholds;
  severity: Record<LegibilityKind, Severity | 'off'>;
}

function resolveConfig(user?: LegibilityUserConfig): ResolvedConfig {
  const t = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(t) as (keyof LegibilityThresholds)[]) {
    const v = user?.thresholds?.[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) t[key] = v;
  }
  const severity = { ...DEFAULT_SEVERITY } as Record<LegibilityKind, Severity | 'off'>;
  for (const [k, v] of Object.entries(user?.severity ?? {})) {
    if ((LEGIBILITY_FAMILIES as readonly string[]).includes(k) && (v === 'error' || v === 'advisory' || v === 'off')) {
      severity[k as LegibilityKind] = v;
    }
  }
  return { thresholds: t, severity };
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);
const boundsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.minX < b.maxX - TOL && b.minX < a.maxX - TOL && a.minY < b.maxY - TOL && b.minY < a.maxY - TOL;
const boundsContain = (outer: Bounds, inner: Bounds): boolean =>
  outer.minX <= inner.minX + TOL && outer.minY <= inner.minY + TOL && outer.maxX >= inner.maxX - TOL && outer.maxY >= inner.maxY - TOL;
const pointIn = (x: number, y: number, b: Bounds): boolean =>
  x > b.minX + TOL && x < b.maxX - TOL && y > b.minY + TOL && y < b.maxY - TOL;
const area = (b: Bounds): number => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
const center = (b: Bounds): { x: number; y: number } => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });

/** Edge-to-edge distance between two boxes; 0 when they touch or overlap. */
function edgeDistance(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
}

function union(bs: Bounds[]): Bounds | null {
  if (!bs.length) return null;
  return bs.reduce((acc, b) => ({
    minX: Math.min(acc.minX, b.minX),
    minY: Math.min(acc.minY, b.minY),
    maxX: Math.max(acc.maxX, b.maxX),
    maxY: Math.max(acc.maxY, b.maxY),
  }));
}

/** Transform a symbol-space box into schematic space (same math as pinAbsolute). */
function transformBounds(at: { x: number; y: number; rot: number }, mirror: 'x' | 'y' | null, b: Bounds): Bounds {
  const corners = [
    { x: b.minX, y: b.minY },
    { x: b.minX, y: b.maxY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
  ].map((c) => pinAbsolute(at, mirror, c));
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    minY: Math.min(...corners.map((c) => c.y)),
    maxX: Math.max(...corners.map((c) => c.x)),
    maxY: Math.max(...corners.map((c) => c.y)),
  };
}

/** Conservative text box, centered on the anchor; vertical when rotated 90/270. */
function textBounds(t: { text: string; x: number; y: number; rot: number; height: number }): Bounds {
  const w = Math.max(1, t.text.length) * TEXT_ADVANCE * t.height;
  const h = t.height;
  const vertical = Math.abs(t.rot % 180) === 90;
  const [bw, bh] = vertical ? [h, w] : [w, h];
  return { minX: t.x - bw / 2, minY: t.y - bh / 2, maxX: t.x + bw / 2, maxY: t.y + bh / 2 };
}

/**
 * Label text extends AWAY from the anchor in the rotation's direction (this is
 * how eeschema renders net/global labels: 0 rightward, 180 leftward, 90 upward,
 * 270 downward in schematic Y-down coordinates). Centering the box instead
 * would bleed half of it across the attachment point and invent collisions
 * with the very symbol the label serves — the false positive C3 forbids.
 *
 * KiCad never draws a label upside down: angles 180/270 are normalized to 0/90
 * at draw time with the DEFAULT justification mirrored, and a stored
 * `(justify …)` describes that drawn frame. So the effective justification is
 * the stored one when present, else left for 0/90 and right for 180/270 — and
 * left-justified text starts at the anchor (extends right / up) while
 * right-justified text ends there (extends left / down). This makes the three
 * wild encodings of a leftward label — angle 180 alone, angle 180 + justify
 * right (eeschema's own output, pinned by the open-key golden), and angle 0 +
 * justify right (the engine's emitter) — measure the same box; measuring any
 * of them on the wrong side of the anchor either invents a collision with the
 * symbol the label serves or hides a real one.
 */
function labelBounds(l: { name: string; x: number; y: number; rot: number; height: number; justify?: 'left' | 'right' | null }): Bounds {
  const w = Math.max(1, l.name.length) * TEXT_ADVANCE * l.height;
  const h = l.height;
  const rot = ((l.rot % 360) + 360) % 360;
  const justified = l.justify ?? (rot === 180 || rot === 270 ? 'right' : 'left');
  if (rot === 90 || rot === 270) {
    return justified === 'left'
      ? { minX: l.x - h / 2, minY: l.y - w, maxX: l.x + h / 2, maxY: l.y }
      : { minX: l.x - h / 2, minY: l.y, maxX: l.x + h / 2, maxY: l.y + w };
  }
  return justified === 'right'
    ? { minX: l.x - w, minY: l.y - h / 2, maxX: l.x, maxY: l.y + h / 2 }
    : { minX: l.x, minY: l.y - h / 2, maxX: l.x + w, maxY: l.y + h / 2 };
}

function segIntersectsBounds(s: WireSeg, b: Bounds): boolean {
  // trivial reject / accept via endpoints, then conservative sampling along the
  // segment (segments here are axis-aligned or short; sampling at grid density
  // cannot miss a crossing wider than the tolerance)
  if (pointIn(s.x1, s.y1, b) || pointIn(s.x2, s.y2, b)) return true;
  const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  const steps = Math.max(2, Math.ceil(len / 0.5));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (pointIn(s.x1 + (s.x2 - s.x1) * t, s.y1 + (s.y2 - s.y1) * t, b)) return true;
  }
  return false;
}

const onGrid = (v: number, pitch: number): boolean => {
  const r = Math.abs(v - Math.round(v / pitch) * pitch);
  return r <= TOL;
};
const nearestGrid = (v: number, pitch: number): number => Math.round(v / pitch) * pitch;

const pointOnSeg = (x: number, y: number, s: WireSeg): boolean => {
  const cross = Math.abs((s.x2 - s.x1) * (y - s.y1) - (s.y2 - s.y1) * (x - s.x1));
  const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) || 1;
  if (cross / len > TOL) return false;
  const dot = (x - s.x1) * (s.x2 - s.x1) + (y - s.y1) * (s.y2 - s.y1);
  return dot >= -TOL && dot <= len * len + TOL;
};

/** Markdown headings (## and deeper) from SUBSYSTEMS.md and BOM.md name the caption vocabulary. */
async function loadCaptionNames(docsDir: string | null): Promise<{ names: string[] | null; reason: string | null }> {
  if (!docsDir) return { names: null, reason: 'no docs directory provided' };
  const names: string[] = [];
  let anyFile = false;
  for (const file of ['SUBSYSTEMS.md', 'BOM.md']) {
    const p = path.join(docsDir, file);
    if (!existsSync(p)) continue;
    anyFile = true;
    const text = await readFile(p, 'utf8');
    for (const m of text.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)) {
      const name = m[1]!.trim();
      if (name) names.push(name);
    }
  }
  if (!anyFile) return { names: null, reason: 'SUBSYSTEMS.md and BOM.md are absent' };
  if (!names.length) return { names: null, reason: 'no parseable subsystem or component-group headings in SUBSYSTEMS.md/BOM.md' };
  return { names, reason: null };
}

const captionMatches = (caption: string, names: string[]): boolean => {
  const c = caption.trim().toLowerCase();
  return names.some((n) => {
    const l = n.toLowerCase();
    return c === l || c.includes(l) || l.includes(c);
  });
};

interface Group {
  rect: RectItem;
  bounds: Bounds;
  caption: string | null;
  label: string;
}

interface SymbolGeom {
  sym: PlacedSymbolGeom;
  body: Bounds | null;
  pins: { x: number; y: number }[];
}

export interface CheckLegibilityOptions {
  /** Directory holding SUBSYSTEMS.md/BOM.md for caption validation. */
  docsDir?: string | null;
  config?: LegibilityUserConfig;
}

export async function checkLegibility(rootSch: string, opts: CheckLegibilityOptions = {}): Promise<LegibilityReport> {
  const { thresholds: th, severity } = resolveConfig(opts.config);
  const sheets = await readSheetGeometry(rootSch);
  const captions = await loadCaptionNames(opts.docsDir ?? null);

  const disabled = LEGIBILITY_FAMILIES.filter((f) => severity[f] === 'off');
  const skipped: { family: string; reason: string }[] = [];
  if (captions.names === null && captions.reason) {
    skipped.push({ family: 'caption-validation', reason: `${captions.reason}; group captions not validated against docs` });
  }
  const raw: LegibilityFinding[] = [];
  const add = (kind: LegibilityKind, sheet: string, at: { x: number; y: number }, refs: string[], detail: string): void => {
    const sev = severity[kind];
    if (sev === 'off') return;
    raw.push({ kind, severity: sev, sheet, at: { x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100 }, refs, detail });
  };

  for (const sheet of sheets) {
    checkSheet(sheet, th, add, skipped, captions.names);
  }

  // Per-family per-sheet cap with an explicit suppressed count (design C5),
  // then off-grid first (design C9), remaining families in declaration order.
  const suppressed: { family: LegibilityKind; sheet: string; count: number }[] = [];
  const kept: LegibilityFinding[] = [];
  const perKey = new Map<string, number>();
  for (const f of raw) {
    const key = `${f.kind} ${f.sheet}`;
    const n = (perKey.get(key) ?? 0) + 1;
    perKey.set(key, n);
    if (n <= th.familyCap) kept.push(f);
    else {
      const s = suppressed.find((x) => x.family === f.kind && x.sheet === f.sheet);
      if (s) s.count++;
      else suppressed.push({ family: f.kind, sheet: f.sheet, count: 1 });
    }
  }
  const order = new Map(LEGIBILITY_FAMILIES.map((f, i) => [f, i === 0 ? -1 : i]));
  const findings = kept
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (order.get(a.f.kind)! - order.get(b.f.kind)!) || a.i - b.i)
    .map(({ f }) => f);

  return {
    findings,
    counts: {
      error: findings.filter((f) => f.severity === 'error').length,
      advisory: findings.filter((f) => f.severity === 'advisory').length,
    },
    skipped,
    disabled: [...disabled],
    suppressed,
    sheets: sheets.length,
  };
}

function checkSheet(
  sheet: SheetGeometry,
  th: LegibilityThresholds,
  add: (kind: LegibilityKind, sheet: string, at: { x: number; y: number }, refs: string[], detail: string) => void,
  skipped: { family: string; reason: string }[],
  captionNames: string[] | null,
): void {
  const S = sheet.sheetName;

  // --- geometry prep ---
  const syms: SymbolGeom[] = sheet.symbols.map((sym) => {
    const lib = sheet.libBounds.get(sym.libId) ?? null;
    const pins = (sheet.libPins.get(sym.libId) ?? []).map((p) => pinAbsolute(sym.at, sym.mirror, p));
    // A body-less symbol (graphics-free lib entry) falls back to its pin extent
    // so geometric families still see it; a symbol with neither is skipped.
    const body = lib
      ? transformBounds(sym.at, sym.mirror, lib)
      : union(pins.map((p) => ({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y })));
    return { sym, body, pins };
  });
  const realSyms = syms.filter((s) => !s.sym.isPower);

  const visibleTexts: { owner: string; ownerRef: string | null; t: TextItem; box: Bounds }[] = [];
  for (const s of sheet.symbols) {
    for (const p of s.props) {
      if (!p.hidden && p.text) visibleTexts.push({ owner: `${s.ref} ${p.text === s.value ? 'Value' : 'Reference'}`, ownerRef: s.ref, t: p, box: textBounds(p) });
    }
  }
  for (const t of sheet.texts) {
    if (!t.hidden && t.text) visibleTexts.push({ owner: `text "${t.text}"`, ownerRef: null, t, box: textBounds(t) });
  }
  const labelBoxes = sheet.labels.map((l) => ({
    l,
    box: labelBounds(l),
    attached: sheet.wires.filter((w) => pointOnSeg(l.x, l.y, w)),
  }));

  // --- groups (design C1): sheet rectangles with a caption in the top band ---
  const groups: Group[] = sheet.rectangles.map((rect, i) => {
    const bounds: Bounds = {
      minX: Math.min(rect.x1, rect.x2),
      minY: Math.min(rect.y1, rect.y2),
      maxX: Math.max(rect.x1, rect.x2),
      maxY: Math.max(rect.y1, rect.y2),
    };
    const band = Math.min((bounds.maxY - bounds.minY) * 0.25, 10);
    const cap = sheet.texts.find(
      (t) => !t.hidden && t.text && pointIn(t.x, t.y, bounds) && t.y <= bounds.minY + band,
    );
    const caption = cap?.text ?? null;
    return { rect, bounds, caption, label: caption ?? `group#${i + 1}` };
  });

  // --- off-grid (reported first, design C9) ---
  for (const { sym } of syms) {
    if (!onGrid(sym.at.x, th.gridPitch) || !onGrid(sym.at.y, th.gridPitch)) {
      add('off-grid', S, { x: sym.at.x, y: sym.at.y }, [sym.ref], `symbol ${sym.ref} origin (${fmt(sym.at.x)}, ${fmt(sym.at.y)}) is off the ${th.gridPitch}mm grid; move it to (${fmt(nearestGrid(sym.at.x, th.gridPitch))}, ${fmt(nearestGrid(sym.at.y, th.gridPitch))})`);
    }
  }
  for (const w of sheet.wires) {
    for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]] as const) {
      if (!onGrid(x, th.gridPitch) || !onGrid(y, th.gridPitch)) {
        add('off-grid', S, { x, y }, [S], `wire endpoint (${fmt(x)}, ${fmt(y)}) is off the ${th.gridPitch}mm grid; move it to (${fmt(nearestGrid(x, th.gridPitch))}, ${fmt(nearestGrid(y, th.gridPitch))})`);
      }
    }
  }
  for (const l of sheet.labels) {
    if (!onGrid(l.x, th.gridPitch) || !onGrid(l.y, th.gridPitch)) {
      add('off-grid', S, { x: l.x, y: l.y }, [l.name], `label "${l.name}" at (${fmt(l.x)}, ${fmt(l.y)}) is off the ${th.gridPitch}mm grid; move it to (${fmt(nearestGrid(l.x, th.gridPitch))}, ${fmt(nearestGrid(l.y, th.gridPitch))})`);
    }
  }

  // --- symbol-overlap and crowding (unordered pairs, design C5) ---
  for (let i = 0; i < realSyms.length; i++) {
    for (let j = i + 1; j < realSyms.length; j++) {
      const a = realSyms[i]!;
      const b = realSyms[j]!;
      if (!a.body || !b.body) continue;
      if (boundsOverlap(a.body, b.body)) {
        add('symbol-overlap', S, center(a.body), [a.sym.ref, b.sym.ref], `symbol bodies of ${a.sym.ref} and ${b.sym.ref} overlap; separate them by at least ${th.minPitch}mm edge to edge`);
      } else {
        const d = edgeDistance(a.body, b.body);
        if (d < th.minPitch - TOL) {
          add('crowding', S, center(a.body), [a.sym.ref, b.sym.ref], `${a.sym.ref} and ${b.sym.ref} sit ${fmt(d)}mm apart edge to edge, below the readable pitch of ${th.minPitch}mm`);
        }
      }
    }
  }

  // --- text-collision (design C2/C3: pin text excluded, own body excluded, attached wire excluded) ---
  const collide = (box: Bounds, ownerRef: string | null, name: string, at: { x: number; y: number }, attachedWires: WireSeg[]): void => {
    for (const s of realSyms) {
      if (!s.body || s.sym.ref === ownerRef) continue;
      if (boundsOverlap(box, s.body)) {
        add('text-collision', S, at, [name, s.sym.ref], `${name} text overlaps the body of ${s.sym.ref}; move the text clear of the symbol`);
        return;
      }
    }
    for (const w of sheet.wires) {
      if (attachedWires.includes(w)) continue;
      if (segIntersectsBounds(w, box)) {
        add('text-collision', S, at, [name], `${name} text sits on a wire; move the text off the wire`);
        return;
      }
    }
  };
  for (const vt of visibleTexts) collide(vt.box, vt.ownerRef, vt.owner, { x: vt.t.x, y: vt.t.y }, []);
  for (const lb of labelBoxes) collide(lb.box, null, `label "${lb.l.name}"`, { x: lb.l.x, y: lb.l.y }, lb.attached);
  // text-over-text, each unordered pair once
  const allText = [
    ...visibleTexts.map((v) => ({ name: v.owner, box: v.box, at: { x: v.t.x, y: v.t.y } })),
    ...labelBoxes.map((lb) => ({ name: `label "${lb.l.name}"`, box: lb.box, at: { x: lb.l.x, y: lb.l.y } })),
  ];
  for (let i = 0; i < allText.length; i++) {
    for (let j = i + 1; j < allText.length; j++) {
      if (boundsOverlap(allText[i]!.box, allText[j]!.box)) {
        add('text-collision', S, allText[i]!.at, [allText[i]!.name, allText[j]!.name], `${allText[i]!.name} and ${allText[j]!.name} overlap; separate the two text items`);
      }
    }
  }

  // --- wire-through-symbol ---
  for (const w of sheet.wires) {
    for (const s of realSyms) {
      if (!s.body) continue;
      const endsOnPin = s.pins.some(
        (p) => (Math.abs(p.x - w.x1) <= TOL && Math.abs(p.y - w.y1) <= TOL) || (Math.abs(p.x - w.x2) <= TOL && Math.abs(p.y - w.y2) <= TOL),
      );
      if (!endsOnPin && segIntersectsBounds(w, s.body)) {
        add('wire-through-symbol', S, center(s.body), [s.sym.ref], `a wire crosses the body of ${s.sym.ref} without terminating on one of its pins; route it around the symbol`);
      }
    }
  }

  // --- groups: membership, captions, overlap ---
  for (const g of groups) {
    if (!g.caption) {
      add('unlabeled-group', S, center(g.bounds), [g.label], `group rectangle at (${fmt(g.bounds.minX)}, ${fmt(g.bounds.minY)}) has no caption in its top band; add a text caption naming the subsystem`);
    } else if (captionNames && !captionMatches(g.caption, captionNames)) {
      const nearest = captionNames[0]!;
      add('unlabeled-group', S, center(g.bounds), [g.caption], `group caption "${g.caption}" names nothing in SUBSYSTEMS.md or BOM.md; use a documented name (e.g. "${nearest}")`);
    }
  }
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i]!;
      const b = groups[j]!;
      if (boundsOverlap(a.bounds, b.bounds) && !boundsContain(a.bounds, b.bounds) && !boundsContain(b.bounds, a.bounds)) {
        add('group-overlap', S, center(a.bounds), [a.label, b.label], `group boxes "${a.label}" and "${b.label}" intersect; tile groups without overlap (full nesting is allowed)`);
      }
    }
  }
  for (const s of realSyms) {
    if (!s.body) continue;
    const containing = groups.filter((g) => boundsContain(g.bounds, s.body!));
    if (!containing.length) {
      const nearest = groups
        .map((g) => ({ g, d: edgeDistance(g.bounds, s.body!) }))
        .sort((a, b) => a.d - b.d)[0];
      add('ungrouped-symbol', S, center(s.body), [s.sym.ref], `${s.sym.ref} sits inside no group rectangle${nearest ? `; the nearest group is "${nearest.g.label}" (${fmt(nearest.d)}mm away)` : '; draw a captioned group rectangle around its subsystem'}`);
    }
  }

  // --- label-orientation: rotated where a horizontal draw would collide with nothing ---
  for (const lb of labelBoxes) {
    if (Math.abs(lb.l.rot % 180) !== 90) continue;
    const horizontal = labelBounds({ ...lb.l, rot: 0 });
    const collides =
      realSyms.some((s) => s.body && boundsOverlap(horizontal, s.body)) ||
      sheet.wires.some((w) => !lb.attached.includes(w) && segIntersectsBounds(w, horizontal)) ||
      allText.some((t) => t.name !== `label "${lb.l.name}"` && boundsOverlap(horizontal, t.box));
    if (!collides) {
      add('label-orientation', S, { x: lb.l.x, y: lb.l.y }, [lb.l.name], `label "${lb.l.name}" is rotated ${fmt(lb.l.rot)}° where a horizontal label would collide with nothing; draw it horizontal`);
    }
  }

  // --- page-relative checks (design C8: unknown paper skips loudly) ---
  const paper = resolvePaper(sheet);
  if (!paper) {
    skipped.push({ family: 'page-checks', reason: `sheet "${S}": paper "${sheet.paper.name ?? '(none)'}" is not a recognized standard size; out-of-frame and low-utilization skipped` });
  } else {
    const usable: Bounds = { minX: FRAME_BORDER, minY: FRAME_BORDER, maxX: paper.w - FRAME_BORDER, maxY: paper.h - FRAME_BORDER };
    const tbW = Math.min(TITLE_BLOCK_W, (usable.maxX - usable.minX) / 2);
    const tbH = Math.min(TITLE_BLOCK_H, (usable.maxY - usable.minY) / 4);
    const titleRegion: Bounds = { minX: usable.maxX - tbW, minY: usable.maxY - tbH, maxX: usable.maxX, maxY: usable.maxY };

    const items: { name: string; box: Bounds }[] = [
      ...realSyms.filter((s) => s.body).map((s) => ({ name: s.sym.ref, box: s.body! })),
      ...groups.map((g) => ({ name: `group "${g.label}"`, box: g.bounds })),
      ...allText.map((t) => ({ name: t.name, box: t.box })),
      ...sheet.wires.map((w, i) => ({ name: `wire#${i + 1}`, box: { minX: Math.min(w.x1, w.x2), minY: Math.min(w.y1, w.y2), maxX: Math.max(w.x1, w.x2), maxY: Math.max(w.y1, w.y2) } })),
    ];
    for (const item of items) {
      if (!boundsContain(usable, item.box)) {
        const edge = item.box.minX < usable.minX ? 'left' : item.box.maxX > usable.maxX ? 'right' : item.box.minY < usable.minY ? 'top' : 'bottom';
        add('out-of-frame', S, center(item.box), [item.name], `${item.name} extends outside the usable drawing frame (${edge} edge); move it inside the frame`);
      } else if (boundsOverlap(item.box, titleRegion)) {
        add('out-of-frame', S, center(item.box), [item.name], `${item.name} overlaps the reserved title-block region; move it clear of the bottom-right corner`);
      }
    }

    const content = union(items.map((i) => i.box));
    if (content) {
      const frac = area(content) / (area(usable) - area(titleRegion));
      if (frac < th.utilization - TOL) {
        const fit = suggestSmallerPaper(content, paper);
        add('low-utilization', S, center(content), [S], `content occupies ${(Math.round(frac * 100) / 100).toFixed(2)} of the usable frame (threshold ${th.utilization})${fit ? `; ${fit} would fit this content` : '; spread the groups to fill the frame'}`);
      }
    }
  }

  // --- cross-group-wire ---
  for (const w of sheet.wires) {
    const g1 = groups.find((g) => pointIn(w.x1, w.y1, g.bounds));
    const g2 = groups.find((g) => pointIn(w.x2, w.y2, g.bounds));
    const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    const net = sheet.labels.find((l) => pointOnSeg(l.x, l.y, w))?.name ?? '(unlabeled)';
    if (g1 && g2 && g1 !== g2) {
      add('cross-group-wire', S, { x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 }, [g1.label, g2.label, net], `a wire on net ${net} runs from group "${g1.label}" into group "${g2.label}"; replace it with a net label pair`);
    } else if (len > th.maxWireLength + TOL) {
      add('cross-group-wire', S, { x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 }, [g1?.label ?? S, net], `a ${fmt(len)}mm wire on net ${net} exceeds the ${th.maxWireLength}mm maximum; shorten the route or use a net label pair`);
    }
  }

  // --- empty-title-block ---
  const tb = sheet.titleBlock;
  const empty: string[] = [];
  if (!tb?.title) empty.push('title');
  if (!tb?.rev) empty.push('revision');
  if (!tb?.date) empty.push('date');
  if (empty.length) {
    const at = paperAnchor(sheet);
    add('empty-title-block', S, at, empty, `title block ${tb ? 'has empty' : 'is missing; fill in the'} ${empty.join(', ')} field(s)`);
  }
}

function resolvePaper(sheet: SheetGeometry): { w: number; h: number } | null {
  if (sheet.paper.width !== null && sheet.paper.height !== null) {
    return { w: sheet.paper.width, h: sheet.paper.height };
  }
  const std = sheet.paper.name ? PAPER_SIZES[sheet.paper.name] : undefined;
  if (!std) return null;
  return sheet.paper.portrait ? { w: std.h, h: std.w } : std;
}

function paperAnchor(sheet: SheetGeometry): { x: number; y: number } {
  const p = resolvePaper(sheet);
  return p ? { x: p.w - FRAME_BORDER, y: p.h - FRAME_BORDER } : { x: 0, y: 0 };
}

function suggestSmallerPaper(content: Bounds, current: { w: number; h: number }): string | null {
  const needW = content.maxX - content.minX + 2 * FRAME_BORDER;
  const needH = content.maxY - content.minY + 2 * FRAME_BORDER + TITLE_BLOCK_H;
  const candidates = Object.entries(PAPER_SIZES)
    .filter(([, s]) => s.w >= needW && s.h >= needH && s.w * s.h < current.w * current.h)
    .sort((a, b) => a[1].w * a[1].h - b[1].w * b[1].h);
  return candidates.length ? `paper "${candidates[0]![0]}"` : null;
}

/** Numbered human rendering shared by the agent tool and `check`. */
export function formatLegibility(report: LegibilityReport): string {
  if (!report.findings.length && !report.suppressed.length) {
    const notes = [
      ...report.skipped.map((s) => `note: ${s.family} skipped (${s.reason})`),
      ...(report.disabled.length ? [`note: disabled by config: ${report.disabled.join(', ')}`] : []),
    ];
    return [`legibility: ${report.sheets} sheet(s) checked, no findings`, ...notes].join('\n');
  }
  const lines: string[] = [
    `legibility: ${report.counts.error} error, ${report.counts.advisory} advisory finding(s) across ${report.sheets} sheet(s):`,
  ];
  report.findings.forEach((f, i) => {
    lines.push(`  ${i + 1}. [${f.severity}] ${f.kind} @ ${f.sheet} (${f.at.x}, ${f.at.y}) refs: ${f.refs.join(', ')} — ${f.detail}`);
  });
  for (const s of report.suppressed) {
    lines.push(`  … ${s.count} more ${s.family} finding(s) on sheet ${s.sheet} suppressed (per-family cap)`);
  }
  for (const s of report.skipped) lines.push(`  note: ${s.family} skipped (${s.reason})`);
  if (report.disabled.length) lines.push(`  note: disabled by config: ${report.disabled.join(', ')}`);
  return lines.join('\n');
}