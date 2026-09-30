import { parseMarkdownTables, type TableRow } from '../memory/bom-table.js';

/**
 * Supplier-format BOM export (capability supplier-bom-export). Deterministic,
 * LLM-free, network-free: a pure transformation of BOM.md into files a supplier
 * accepts without hand-editing. BOM.md is the sole input (design D1) — it is
 * already drift-checked against the schematic, so exports inherit that
 * consistency guarantee.
 */

export type Supplier = 'jlcpcb' | 'digikey' | 'mouser';

export const SUPPLIERS: readonly Supplier[] = ['jlcpcb', 'digikey', 'mouser'];

/** CLI defaults for the quantity flags, shared so the "ignored for jlcpcb"
 *  note fires only when the user actually set a non-default value. */
export const DEFAULT_BOARDS = 1;
export const DEFAULT_SPARES = 10;

export function isSupplier(s: string): s is Supplier {
  return (SUPPLIERS as readonly string[]).includes(s);
}

export interface BomRow {
  refdes: string;
  value: string;
  footprint: string;
  /** MPN column value as written (may be a placeholder like "UNVERIFIED"). */
  mpn: string;
  manufacturer: string;
  /** LCSC part number when a column carries it, else ''. */
  lcsc: string;
  /** True when any cell carries the standalone token UNVERIFIED. */
  unverified: boolean;
  /** True when the MPN column carries an orderable part number (not a placeholder). */
  hasMpn: boolean;
}

// Header aliases → canonical field. Matched after normalizing a header cell to
// lowercase alphanumerics, so "LCSC Part #" and "lcsc_part" both hit `lcsc`.
const HEADER_ALIASES: Record<string, keyof Pick<BomRow, 'refdes' | 'value' | 'footprint' | 'mpn' | 'manufacturer' | 'lcsc'>> = {
  refdes: 'refdes',
  ref: 'refdes',
  designator: 'refdes',
  reference: 'refdes',
  value: 'value',
  comment: 'value',
  val: 'value',
  footprint: 'footprint',
  package: 'footprint',
  mpn: 'mpn',
  manufacturerpartnumber: 'mpn',
  mfrpartnumber: 'mpn',
  mfrpart: 'mpn',
  partnumber: 'mpn',
  manufacturer: 'manufacturer',
  mfr: 'manufacturer',
  lcsc: 'lcsc',
  lcscpart: 'lcsc',
  lcscpartnumber: 'lcsc',
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// MPN cells that mean "no orderable part number yet". `UNVERIFIED` is the
// init/scaffold placeholder (src/memory/scaffold.ts writes it into the MPN
// column for every extracted symbol); the rest are common human shorthand.
const MPN_PLACEHOLDERS = new Set(['', 'unverified', 'tbd', 'todo', 'tbc', 'na', 'none', '-', '—', '?']);

const isMpnPlaceholder = (mpn: string): boolean => MPN_PLACEHOLDERS.has(mpn.trim().toLowerCase());

const UNVERIFIED_RE = /\bUNVERIFIED\b/i;

/**
 * Parse BOM.md into rows by column header, tolerating extra/reordered columns.
 * Only the header row and data rows of the first parts table are used; a table
 * without a recognizable Refdes header yields no rows.
 *
 * NOTE: the drift gate this exporter runs behind (checkDrift in
 * ../memory/drift.ts) reads Refdes|Value|Footprint *by position*, not by header.
 * So while this parser tolerates reordering those base columns, reordering them
 * makes checkDrift compare the wrong cells and the export refuses with a bogus
 * drift message. Keep the base three columns first and in order; only append.
 */
export function parseBom(md: string): BomRow[] {
  const tableRows = parseMarkdownTables(md);
  const headerIdx = tableRows.findIndex((r) => r.cells.some((c) => HEADER_ALIASES[norm(c)] === 'refdes'));
  const header = headerIdx === -1 ? undefined : tableRows[headerIdx];
  if (!header) return [];
  const col: Partial<Record<keyof BomRow, number>> = {};
  header.cells.forEach((c, i) => {
    const field = HEADER_ALIASES[norm(c)];
    // First occurrence wins, so a stray later column never shadows the real one.
    if (field && col[field] === undefined) col[field] = i;
  });

  const at = (row: TableRow, field: keyof BomRow): string => {
    const i = col[field];
    return i === undefined ? '' : (row.cells[i] ?? '').trim();
  };

  const rows: BomRow[] = [];
  for (const row of tableRows.slice(headerIdx + 1)) {
    const refdes = at(row, 'refdes');
    if (!refdes) continue; // blank line / stray row
    const mpn = at(row, 'mpn');
    rows.push({
      refdes,
      value: at(row, 'value'),
      footprint: at(row, 'footprint'),
      mpn,
      manufacturer: at(row, 'manufacturer'),
      lcsc: at(row, 'lcsc'),
      unverified: row.cells.some((c) => UNVERIFIED_RE.test(c)),
      hasMpn: !isMpnPlaceholder(mpn),
    });
  }
  return rows;
}

/**
 * Passive footprint classifier (design D4): the library item after the `:` in a
 * KiCad footprint id starts with `R_`, `C_`, or `L_` for the passive classes
 * that lose parts to handling. Bare footprint names (no library) are matched
 * too, so `R_0603` and `Resistor_SMD:R_0603_1608Metric` both classify.
 */
export function isPassiveFootprint(footprint: string): boolean {
  const item = footprint.includes(':') ? footprint.slice(footprint.lastIndexOf(':') + 1) : footprint;
  return /^[RCL]_/.test(item.trim());
}

/**
 * Order quantity for one BOM line (requirement "Quantity arithmetic"):
 * `ceil(perBoardCount × boards × (1 + spares/100))`, raised to
 * `perBoardCount × boards + 2` for passive lines when the percentage yields
 * less — losing two 0402s to tweezers is the norm and percentage-only spares
 * under-order low-count passive lines (design D4).
 */
export function orderQuantity(
  perBoardCount: number,
  boards: number,
  sparesPercent: number,
  isPassive: boolean,
): number {
  const base = perBoardCount * boards;
  // `base * (100 + spares) / 100` keeps the multiply in whole units before the
  // divide, and the epsilon absorbs IEEE-754 dust so an exact result like 110
  // does not ceil to 111 (100 × 1.1 is 110.00000000000001 in float). The dust is
  // ~1e-13; 1e-9 is far below any real fractional quantity, so genuine fractions
  // (44.5 → 45) are unaffected.
  const withSpares = Math.ceil((base * (100 + sparesPercent)) / 100 - 1e-9);
  return isPassive ? Math.max(withSpares, base + 2) : withSpares;
}

/** Natural refdes ordering: R2 before R10, and R* before U*. */
function naturalCompare(a: string, b: string): number {
  const pa = a.match(/^([A-Za-z]*)(\d*)/);
  const pb = b.match(/^([A-Za-z]*)(\d*)/);
  const alpha = (pa?.[1] ?? '').localeCompare(pb?.[1] ?? '');
  if (alpha !== 0) return alpha;
  const na = pa?.[2] ? parseInt(pa[2], 10) : 0;
  const nb = pb?.[2] ? parseInt(pb[2], 10) : 0;
  if (na !== nb) return na - nb;
  return a.localeCompare(b);
}

/**
 * RFC-4180 field quoting: quote when the field holds a comma, quote, or newline.
 *
 * Fields opening with `=`, `+`, `-`, or `@` are also prefixed with an
 * apostrophe: BOM.md cells are agent-written, and a spreadsheet opened on the
 * export before upload would evaluate such a cell as a formula. No real MPN,
 * manufacturer, or designator starts with one, so nothing orderable is altered.
 */
function csvField(value: string): string {
  const v = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const csvRow = (fields: string[]): string => fields.map(csvField).join(',');

export interface ExportOptions {
  boards: number;
  spares: number;
  includeUnverified: boolean;
}

export interface ExportResult {
  /** The supplier CSV, ending in a newline. */
  csv: string;
  /** Rows that made it into the file, in emit order. */
  included: BomRow[];
  /** Rows excluded, with the reason, for the warnings footer. */
  excluded: { row: BomRow; reason: string }[];
  /** Human-readable warning/notice lines (stderr + --json). */
  warnings: string[];
}

interface Line {
  rows: BomRow[];
  /** Representative row (first, in refdes order) for value/footprint/mpn/etc. */
  head: BomRow;
  designators: string[];
}

/**
 * Split rows into included/excluded by the ordering rules (requirement
 * "Unorderable rows are excluded and reported"): MPN-less rows are always
 * excluded; UNVERIFIED rows are excluded unless `includeUnverified`, and even
 * then only when they carry a real MPN.
 */
function partition(
  rows: BomRow[],
  includeUnverified: boolean,
): { included: BomRow[]; excluded: ExportResult['excluded'] } {
  const included: BomRow[] = [];
  const excluded: ExportResult['excluded'] = [];
  for (const row of rows) {
    if (!row.hasMpn) {
      excluded.push({ row, reason: 'no MPN' });
    } else if (row.unverified && !includeUnverified) {
      excluded.push({ row, reason: 'UNVERIFIED' });
    } else {
      included.push(row);
    }
  }
  return { included, excluded };
}

function groupBy(rows: BomRow[], key: (r: BomRow) => string): Line[] {
  const map = new Map<string, BomRow[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = map.get(k);
    if (arr) arr.push(r);
    else map.set(k, [r]);
  }
  const lines: Line[] = [];
  for (const groupRows of map.values()) {
    const sorted = [...groupRows].sort((a, b) => naturalCompare(a.refdes, b.refdes));
    // Groups are never empty (a key exists because a row produced it).
    lines.push({ rows: sorted, head: sorted[0]!, designators: sorted.map((r) => r.refdes) });
  }
  // Deterministic line order: by the first designator of each line.
  return lines.sort((a, b) => naturalCompare(a.designators[0]!, b.designators[0]!));
}

function buildWarnings(
  supplier: Supplier,
  included: BomRow[],
  excluded: ExportResult['excluded'],
  opts: ExportOptions,
): string[] {
  const { includeUnverified } = opts;
  const warnings: string[] = [];
  for (const { row, reason } of excluded) {
    const hint =
      reason === 'no MPN'
        ? 'add an MPN in BOM.md — unorderable without one'
        : 'verify against the datasheet or re-run with --include-unverified';
    warnings.push(`EXCLUDED (${reason}): ${row.refdes} (${row.value || 'no value'}) — ${hint}`);
  }
  if (includeUnverified) {
    for (const row of included) {
      if (row.unverified) {
        warnings.push(`INCLUDED but UNVERIFIED (--include-unverified): ${row.refdes} (${row.mpn}) — confirm before ordering`);
      }
    }
  }
  if (supplier === 'jlcpcb') {
    // The JLCPCB assembly format has no quantity column — quantity is set from
    // the board count entered at upload — so --boards/--spares never reach this
    // file. Say so when the user supplied a non-default value, or they may order
    // the wrong count expecting the flags to have taken effect.
    if (opts.boards !== DEFAULT_BOARDS || opts.spares !== DEFAULT_SPARES) {
      warnings.push(
        'NOTE: --boards/--spares are ignored for jlcpcb — quantity is set from the board count you enter at JLCPCB upload',
      );
    }
    const blank = included.filter((r) => !r.lcsc).map((r) => r.refdes);
    if (blank.length) {
      warnings.push(
        `NOTE: no LCSC part # for ${blank.join(', ')} — JLCPCB accepts the upload but needs manual matching for these`,
      );
    }
  }
  return warnings;
}

function emitJlcpcb(lines: Line[]): string {
  // JLCPCB assembly-service BOM: one line per Comment+Footprint+LCSC, designators
  // grouped. Quantity is derived by JLCPCB from the designator count × the board
  // count entered at upload, so there is no quantity column here (design/proposal).
  const header = 'Comment,Designator,Footprint,LCSC Part #';
  const body = lines.map((l) =>
    csvRow([l.head.value, l.designators.join(','), l.head.footprint, l.head.lcsc]),
  );
  return [header, ...body].join('\n') + '\n';
}

function emitCart(lines: Line[], opts: ExportOptions, mpnHeader: string): string {
  // DigiKey / Mouser cart upload: one line per MPN with a computed order
  // quantity and the designators as the customer reference.
  const header = `${mpnHeader},Manufacturer,Quantity,Customer Reference`;
  const body = lines.map((l) => {
    const qty = orderQuantity(l.designators.length, opts.boards, opts.spares, isPassiveFootprint(l.head.footprint));
    return csvRow([l.head.mpn, l.head.manufacturer, String(qty), l.designators.join(',')]);
  });
  return [header, ...body].join('\n') + '\n';
}

/**
 * Build the supplier CSV plus its warnings from parsed BOM rows. Pure: no I/O,
 * so the emitters are golden-file testable in isolation (design D5).
 */
export function buildExport(rows: BomRow[], supplier: Supplier, opts: ExportOptions): ExportResult {
  const { included, excluded } = partition(rows, opts.includeUnverified);
  const lines =
    supplier === 'jlcpcb'
      ? groupBy(included, (r) => `${r.value} ${r.footprint} ${r.lcsc}`)
      : groupBy(included, (r) => r.mpn);

  let csv: string;
  if (supplier === 'jlcpcb') csv = emitJlcpcb(lines);
  else if (supplier === 'digikey') csv = emitCart(lines, opts, 'Manufacturer Part Number');
  else csv = emitCart(lines, opts, 'Mfr. Part Number');

  return { csv, included, excluded, warnings: buildWarnings(supplier, included, excluded, opts) };
}
