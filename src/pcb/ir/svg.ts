/**
 * Minimal SVG rendering of a design straight from the IR, with diagnostics
 * drawn over it. Used by the evidence bundle's HTML report and by tests and
 * demos; it renders what the harness *sees*, which is the point: a KiCad
 * render cannot show a diagnostic.
 */
import type { PcbDesign } from './types.js';
import { copperStack } from './layers.js';
import type { Polygon } from './geometry.js';
import { bbox, bboxOf } from './geometry.js';
/** The slice of a verify diagnostic the renderer needs; kept structural so ir never depends on verify. */
export interface RenderDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  entityReferences: string[];
  region?: Polygon;
}

export interface SvgOptions {
  diagnostics?: RenderDiagnostic[];
  /** Pixels per millimetre. */
  scale?: number;
  title?: string;
  showCourtyards?: boolean;
  /** Draw the legend and title block under the board (default true); off for thumbnails. */
  legend?: boolean;
}

const COLORS: Record<string, string> = { 'F.Cu': '#c83434', 'B.Cu': '#3455c8', 'In1.Cu': '#3c9a5a', 'In2.Cu': '#8a4bc4', 'In3.Cu': '#2a9d9d', 'In4.Cu': '#9a6a2a' };
const mm = (nm: number) => (nm / 1e6).toFixed(4);

function pathOf(poly: Polygon): string {
  const ring = (r: { x: number; y: number }[]) => (r.length ? `M${r.map((p) => `${mm(p.x)},${mm(p.y)}`).join('L')}Z` : '');
  return [ring(poly.outer), ...poly.holes.map(ring)].join(' ');
}

export function renderSvg(design: PcbDesign, opts: SvgOptions = {}): string {
  const scale = opts.scale ?? 14;
  const legendMode = opts.legend !== false;
  // the view hugs everything: the outline plus any copper or courtyard that strayed outside it
  const extents = [design.board.outline, ...design.components.flatMap((c) => [c.footprint.courtyard, ...c.pads.map((p) => p.copper)]).filter((p): p is Polygon => !!p)];
  const b = bboxOf(extents);
  const pad = legendMode ? 2e6 : 1.2e6;
  const shown = (opts.diagnostics ?? []).filter((d) => d.severity !== 'info');
  const legend = legendMode;
  const legendLines = legend ? (opts.title ? 1 : 0) + shown.length : 0;
  const legendH = legendLines ? (legendLines + 0.5) * 1.3e6 : 0;
  const minX = b.minX - pad;
  const minY = b.minY - pad;
  const w = legend ? Math.max(b.maxX - b.minX + 2 * pad, 60e6) : b.maxX - b.minX + 2 * pad;
  const h = b.maxY - b.minY + 2 * pad + legendH;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round((w / 1e6) * scale)}" height="${Math.round((h / 1e6) * scale)}" viewBox="${mm(minX)} ${mm(minY)} ${mm(w)} ${mm(h)}" font-family="sans-serif">`);
  out.push(`<rect x="${mm(minX)}" y="${mm(minY)}" width="${mm(w)}" height="${mm(h)}" fill="#f6f4ee"/>`);
  out.push(`<path d="${pathOf(design.board.outline)}" fill="#1f5c2e" stroke="#c9a400" stroke-width="0.15"/>`);
  for (const c of design.board.cutouts) out.push(`<path d="${pathOf(c)}" fill="#f6f4ee" stroke="#c9a400" stroke-width="0.15"/>`);
  for (const k of design.board.keepouts) out.push(`<path d="${pathOf(k.polygon)}" fill="none" stroke="#ff66cc" stroke-width="0.12" stroke-dasharray="0.4 0.2"/>`);
  // the stack back to front: B.Cu, the inner layers from the deepest up, F.Cu on top; inner copper a little lighter
  const stack = copperStack(design);
  const order = [...stack].reverse();
  const drawn = new Set<string>();
  for (const layer of order) {
    const color = COLORS[layer] ?? '#888';
    const inner = layer !== stack[0] && layer !== stack[stack.length - 1];
    for (const s of design.routing.segments.filter((s) => s.layer === layer)) {
      out.push(`<line x1="${mm(s.a.x)}" y1="${mm(s.a.y)}" x2="${mm(s.b.x)}" y2="${mm(s.b.y)}" stroke="${color}" stroke-width="${mm(s.width)}" stroke-linecap="round" opacity="${inner ? '0.75' : '0.9'}"/>`);
    }
    for (const c of design.components) {
      for (const p of c.pads) {
        if (!p.layers.includes(layer) || drawn.has(p.id)) continue;
        // a through-hole pad sits on every layer; draw it once, with the outer colour
        if (p.layers.length > 1 && layer !== stack[stack.length - 1]) continue;
        drawn.add(p.id);
        out.push(`<path d="${pathOf(p.copper)}" fill="${p.layers.length > 1 ? '#d9b13b' : color}" stroke="none" opacity="0.95"/>`);
        if (p.drill) out.push(`<circle cx="${mm(p.at.x)}" cy="${mm(p.at.y)}" r="${mm(p.drill.d / 2)}" fill="#f6f4ee"/>`);
      }
    }
  }
  for (const v of design.routing.vias) {
    out.push(`<circle cx="${mm(v.at.x)}" cy="${mm(v.at.y)}" r="${mm(v.size / 2)}" fill="#d9b13b"/><circle cx="${mm(v.at.x)}" cy="${mm(v.at.y)}" r="${mm(v.drill / 2)}" fill="#f6f4ee"/>`);
  }
  if (opts.showCourtyards !== false) {
    for (const c of design.components) {
      if (c.footprint.courtyard) out.push(`<path d="${pathOf(c.footprint.courtyard)}" fill="none" stroke="#e8e8e8" stroke-width="0.06" opacity="0.8"/>`);
      out.push(`<text x="${mm(c.at.x)}" y="${mm(c.at.y - 1e6)}" font-size="0.9" fill="#eee" text-anchor="middle" opacity="0.9">${escapeXml(c.reference)}</text>`);
    }
  }
  // diagnostics: numbered markers on the board, a legend underneath
  shown.forEach((d, i) => {
    const color = d.severity === 'error' ? '#ff2d2d' : '#ffb000';
    if (d.region) {
      const rb = bbox(d.region);
      const grow = 0.4e6;
      out.push(`<rect x="${mm(rb.minX - grow)}" y="${mm(rb.minY - grow)}" width="${mm(rb.maxX - rb.minX + 2 * grow)}" height="${mm(rb.maxY - rb.minY + 2 * grow)}" fill="none" stroke="${color}" stroke-width="0.2"/>`);
      // markers fan out to the right so several at one spot stay readable
      const mx = rb.maxX + grow + 1.0e6 + i * 1.6e6;
      const my = rb.minY - grow - 0.9e6;
      out.push(`<circle cx="${mm(mx)}" cy="${mm(my)}" r="0.75" fill="${color}" stroke="#000" stroke-width="0.05"/><text x="${mm(mx)}" y="${mm(my + 0.32e6)}" font-size="0.9" fill="#000" text-anchor="middle" font-weight="bold">${i + 1}</text>`);
    }
  });
  let ly = b.maxY + pad + 0.4e6;
  if (legend && opts.title) {
    out.push(`<text x="${mm(minX + 1e6)}" y="${mm(ly + 1e6)}" font-size="1.1" fill="#222" font-weight="bold">${escapeXml(opts.title)}</text>`);
    ly += 1.3e6;
  }
  if (legend) shown.forEach((d, i) => {
    const color = d.severity === 'error' ? '#c00' : '#b37400';
    const refs = d.entityReferences.length ? ` [${d.entityReferences.slice(0, 6).join(', ')}]` : '';
    out.push(`<text x="${mm(minX + 1e6)}" y="${mm(ly + 1e6)}" font-size="1.0" fill="${color}">${escapeXml(`${i + 1}. ${d.severity} ${d.code}${refs}${d.region ? '' : ' (no region)'}`)}</text>`);
    ly += 1.3e6;
  });
  out.push('</svg>');
  return out.join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}
