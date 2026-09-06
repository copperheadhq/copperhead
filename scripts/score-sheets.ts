/**
 * Score any set of schematics on one table: the gated composite (which needs
 * the drafting standard's conventions) beside the convention-free wiring-style
 * composite and its raw ratios. The point is calibration: human-drawn sheets
 * and engine drafts of comparable circuits side by side.
 *
 * Usage:
 *   npm run scoresheets                       KiCad demos corpus + the reference boards
 *   npm run scoresheets -- path/a.kicad_sch dir/   any sheets or project directories
 *   COPPERHEAD_CORPUS_DIR=... npm run scoresheets
 *
 * A directory scores `<dir>/<dir>.kicad_sch` when it exists, else its first
 * `.kicad_sch`. No LLM, no network, no subprocess.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { scoreSchematic, measureWiringStyle } from '../src/kicad/score.js';
import { readSheetGeometry } from '../src/kicad/sexp.js';

const CORPUS = process.env.COPPERHEAD_CORPUS_DIR ?? '/usr/share/kicad/demos';
const REFERENCES = path.join('manual-tests', 'reference-boards');

function sheetOf(p: string): string | null {
  if (statSync(p).isFile()) return p;
  const name = path.basename(p);
  const own = path.join(p, `${name}.kicad_sch`);
  if (existsSync(own)) return own;
  const first = readdirSync(p).find((f) => f.endsWith('.kicad_sch'));
  return first ? path.join(p, first) : null;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets: { name: string; sheet: string }[] = [];
if (args.length) {
  for (const a of args) {
    const s = sheetOf(a);
    if (s) targets.push({ name: path.basename(a, '.kicad_sch'), sheet: s });
  }
} else {
  if (existsSync(CORPUS)) {
    for (const d of readdirSync(CORPUS).sort()) {
      const s = sheetOf(path.join(CORPUS, d));
      if (s) targets.push({ name: `demo:${d}`, sheet: s });
    }
  }
  if (existsSync(REFERENCES)) {
    for (const d of readdirSync(REFERENCES).sort()) {
      const s = path.join(REFERENCES, d, 'reference', `${d}.kicad_sch`);
      if (existsSync(s)) targets.push({ name: `ref:${d}`, sheet: s });
    }
  }
}

const f2 = (n: number): string => n.toFixed(2);
const rows: string[][] = [['sheet', 'parts', '2-pin attached', 'islands', 'power/part', 'labels/part', 'crossings', 'style', 'composite']];
for (const t of targets) {
  try {
    const sheets = await readSheetGeometry(t.sheet);
    const ws = measureWiringStyle(sheets);
    const r = await scoreSchematic(t.sheet, { docsDir: null });
    const m = (name: string): number => r.metrics.find((x) => x.name === name)?.raw ?? Number.NaN;
    rows.push([
      t.name,
      String(ws.parts),
      ws.twoPin ? f2(ws.twoPinAttached / ws.twoPin) : '-',
      ws.twoPin ? f2(ws.twoPinIslands / ws.twoPin) : '-',
      ws.parts ? f2(ws.powerSymbols / ws.parts) : '-',
      ws.parts ? f2(ws.labels / ws.parts) : '-',
      String(m('wire-crossings')),
      f2(r.style.composite),
      `${f2(r.composite)}${r.cap ? ' (cap)' : ''}`,
    ]);
  } catch (err) {
    rows.push([t.name, 'error', (err as Error).message.slice(0, 60), '', '', '', '', '', '']);
  }
}
const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
for (const r of rows) console.log(r.map((c, i) => (i === 0 ? (c ?? '').padEnd(widths[i]!) : (c ?? '').padStart(widths[i]!))).join('  '));
