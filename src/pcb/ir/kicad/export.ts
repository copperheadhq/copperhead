/**
 * KiCad board export by text surgery (RFC 11 §6.2, implementation spec §4.3).
 * A candidate is applied to the immutable source text: footprint `(at …)`
 * records are replaced in place (pad and text angles follow, because KiCad
 * stores them absolute), copper not in the preserved set is removed and the
 * candidate's copper appended, zone fills are dropped for the refill, and the
 * generator pair is stamped. Nothing serializes the IR; unmodelled records
 * keep their bytes.
 */
import { nmToMm, mdegToDeg, normMdeg } from '../units.js';
import type { PcbDesign, PlacedComponent, TrackSegment, TrackArc, Via } from '../types.js';
import { topLevelBlocks, childBlocks, stripChildren, type Block } from './blocks.js';
import { emitCopper } from './copper.js';

export const EXPORT_GENERATOR = 'copperhead-pcb';

export interface Candidate {
  placement?: PlacedComponent[];
  routing?: {
    segments: TrackSegment[];
    arcs?: TrackArc[];
    vias: Via[];
    /** Ids of source copper records to keep (default: none, i.e. replace all copper). */
    preserveIds?: Set<string>;
  };
}

export interface ExportOptions {
  generatorVersion?: string;
  /** Keep zone fills as they are (default: strip `filled_polygon` blocks so a refill is required). */
  keepFills?: boolean;
}

export interface ExportResult {
  text: string;
  moved: string[];
  rotated: string[];
  copperRemoved: number;
  copperAdded: number;
  /** Placement changes the exporter refused (a side flip), with the reason. */
  refused: { id: string; reason: string }[];
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

const fmtAt = (x: number, y: number, mdeg: number): string => {
  const deg = mdegToDeg(normMdeg(mdeg));
  const angle = deg === 0 ? '' : ` ${Number.isInteger(deg) ? deg : deg.toFixed(3).replace(/\.?0+$/, '')}`;
  return `(at ${nmToMm(x)} ${nmToMm(y)}${angle})`;
};

/** Direct-child `(uuid "…")` (or legacy tstamp) of a block. */
function blockId(b: Block): string | null {
  for (const c of childBlocks(b.text)) {
    if (c.head === 'uuid' || c.head === 'tstamp') {
      const m = /"([^"]*)"/.exec(c.text) ?? /\(\w+\s+(\S+)\)/.exec(c.text);
      return m?.[1] ?? null;
    }
  }
  return null;
}

/** Add `delta` millidegrees to every `(at x y [a])` that is a direct child of a direct child (pads, properties, texts). */
function rotateChildren(fpText: string, delta: number): string {
  if (delta === 0) return fpText;
  const kids = childBlocks(fpText).filter((k) => k.head === 'pad' || k.head === 'property' || k.head === 'fp_text');
  let out = '';
  let cursor = 0;
  for (const k of kids) {
    const at = childBlocks(k.text).find((c) => c.head === 'at');
    if (!at) continue;
    const m = /^\(at\s+(\S+)\s+(\S+)(?:\s+(\S+))?\s*\)$/.exec(at.text);
    if (!m) continue;
    const old = m[3] !== undefined ? Number(m[3]) * 1000 : 0;
    const next = normMdeg(Math.round(old + delta));
    const deg = mdegToDeg(next);
    const replacement = `(at ${m[1]} ${m[2]}${deg === 0 ? '' : ` ${Number.isInteger(deg) ? deg : deg.toFixed(3).replace(/\.?0+$/, '')}`})`;
    const abs = k.start + at.start;
    out += fpText.slice(cursor, abs) + replacement;
    cursor = abs + at.text.length;
  }
  return out + fpText.slice(cursor);
}

/**
 * Apply a candidate to the source text the design was imported from.
 * `design` must be the import of `sourceText` (positions are diffed against it).
 */
export function applyCandidate(sourceText: string, design: PcbDesign, candidate: Candidate, opts: ExportOptions = {}): ExportResult {
  const blocks = topLevelBlocks(sourceText);
  const result: ExportResult = { text: '', moved: [], rotated: [], copperRemoved: 0, copperAdded: 0, refused: [] };
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const placement = new Map((candidate.placement ?? []).map((p) => [p.id, p]));
  const preserve = candidate.routing?.preserveIds ?? new Set<string>();
  const replaceCopper = candidate.routing !== undefined;

  const pieces: string[] = [];
  let cursor = 0;
  const rootStart = sourceText.indexOf('(');
  const rootEnd = sourceText.lastIndexOf(')');
  for (const b of blocks) {
    let replacement: string | null = null;
    let drop = false;
    if (b.head === 'generator') replacement = `(generator "${EXPORT_GENERATOR}")`;
    else if (b.head === 'generator_version' && opts.generatorVersion) replacement = `(generator_version "${opts.generatorVersion}")`;
    else if (b.head === 'footprint') {
      const id = blockId(b);
      const want = id ? placement.get(id) : undefined;
      const have = id ? byId.get(id) : undefined;
      if (want && have) {
        if (want.side !== have.attributes.side) {
          result.refused.push({ id: have.id, reason: 'side flip is not supported by the v1 exporter (RFC 11 §8.1 bottomSide)' });
        } else {
          const delta = normMdeg(want.rotation - have.rotation);
          const moved = want.at.x !== have.at.x || want.at.y !== have.at.y;
          if (moved || delta !== 0) {
            let text = b.text;
            const at = childBlocks(text).find((c) => c.head === 'at');
            if (!at) throw new ExportError(`footprint ${have.reference} has no (at …) record`);
            text = text.slice(0, at.start) + fmtAt(want.at.x, want.at.y, want.rotation) + text.slice(at.end);
            text = rotateChildren(text, delta);
            replacement = text;
            if (moved) result.moved.push(have.reference);
            if (delta !== 0) result.rotated.push(have.reference);
          }
        }
      }
    } else if (replaceCopper && (b.head === 'segment' || b.head === 'arc' || b.head === 'via')) {
      const id = blockId(b);
      if (!id || !preserve.has(id)) {
        drop = true;
        result.copperRemoved++;
      }
    } else if (b.head === 'zone' && !opts.keepFills) {
      const stripped = stripChildren(b.text, 'filled_polygon');
      if (stripped !== b.text) replacement = stripped;
    }
    if (drop) {
      // swallow the whitespace that led up to the block so no blank line remains
      let s = b.start;
      while (s > cursor && /[ \t\r\n]/.test(sourceText[s - 1]!)) s--;
      pieces.push(sourceText.slice(cursor, s));
      cursor = b.end;
    } else if (replacement !== null) {
      pieces.push(sourceText.slice(cursor, b.start), replacement);
      cursor = b.end;
    }
  }
  let body = pieces.join('') + sourceText.slice(cursor, rootEnd);
  if (candidate.routing) {
    const names = { nets: new Map(design.nets.map((n) => [n.id, { code: n.code, name: n.name }])), namespace: design.designId, dialect: design.source.netDialect };
    const copper = emitCopper(candidate.routing, names);
    result.copperAdded = candidate.routing.segments.length + (candidate.routing.arcs?.length ?? 0) + candidate.routing.vias.length;
    if (copper) body = body.replace(/\s*$/, '') + '\n' + copper + '\n';
  }
  result.text = body + sourceText.slice(rootEnd);
  void rootStart;
  return result;
}
