/**
 * The stage-4 entry pin dossier: every BOM part resolved against the installed
 * KiCad libraries, rendered as a prompt block, so the schematic agent starts
 * with the pin facts it would otherwise spend turns reconstructing.
 *
 * The BOM is frozen when stage 4 starts, which makes this computable before the
 * first agent turn — the same insight `symbolAvailabilityFacts` applies at
 * recovery time, moved to entry. Like that block, coverage is stated rather
 * than implied: parts past the size cap are named as NOT INCLUDED, parts a
 * probe error skipped are named as UNRESOLVED, and parts whose only name is
 * too short to search are named as NOT SEARCHED — never silently dropped,
 * because absence from the dossier must never read as absence from the
 * libraries.
 *
 * Advisory only. It changes prompt content, not gates: a missing BOM, an
 * unreadable library, or any error degrades to an empty string and the stage
 * runs exactly as it did before this block existed. The one sanctioned
 * consumer of the *structured* resolution besides the renderer is the opt-in
 * stage-4 parts checkpoint (src/commands/parts-gate.ts), which fires only on a
 * successful resolution's genuine absence set — never on a degraded one.
 */

import { parseBomTable } from '../memory/bom-table.js';
import {
  resolveLibrarySymbol,
  searchInstalledSymbols,
  listInstalledLibraries,
  comparePinNumbers,
  type LibPin,
} from './symlib.js';

/** R/C/L refdes (with optional multi-part suffix like R12A) draw from their
 * canonical `Device:*` symbols; a two-pin table per resistor is noise. */
const PASSIVE_REFDES = /^[RCL]\d+[A-Za-z]?$/i;

/** `1=PE2/bidirectional 2(passive) …` — name omitted when the library leaves
 * the pin unnamed (`~` or empty), since `1=~/passive` reads as line noise. */
function pinTable(pins: LibPin[]): string {
  return [...pins]
    .sort((a, b) => comparePinNumbers(a.number, b.number))
    .map((p) => {
      const name = p.name === '~' ? '' : p.name;
      return name ? `${p.number}=${name}/${p.type}` : `${p.number}(${p.type})`;
    })
    .join(' ');
}

/** Render `prefix + as many names as fit + suffix` within `budget` chars; the
 * tail that does not fit becomes "…and N more". The budget is a hard bound:
 * when even the minimal form exceeds it, the string is truncated outright, so
 * the trailer can never blow the size cap it exists to disclose. */
function boundedList(prefix: string, names: string[], suffix: string, budget: number): string {
  let line = '';
  let shown = 0;
  for (let i = 0; i < names.length; i++) {
    const sep = shown === 0 ? '' : '; ';
    const tail = `…and ${names.length - i} more`;
    const candidate = `${line}${sep}${names[i]}`;
    // Reserve room for the worst-case continuation marker after this name.
    if (prefix.length + candidate.length + tail.length + 2 + suffix.length > budget) break;
    line = candidate;
    shown++;
  }
  const rest = names.length - shown;
  const full =
    rest === 0
      ? `${prefix}${line}${suffix}`
      : `${prefix}${line ? `${line}; ` : ''}…and ${rest} more${suffix}`;
  if (full.length <= budget) return full;
  return full.slice(0, Math.max(1, budget - 1)) + '…';
}

export interface DossierOptions {
  /** candidate lib_ids fetched per part */
  searchCap?: number;
  /** bound on the complete rendered block, disclosure lines included */
  maxChars?: number;
}

/** One BOM part's classification against the installed libraries. */
export interface BomPartRecord {
  /** resolved = an installed symbol matched; absent = both the MPN search and
   * the Value fallback found nothing; unreadable = a hit whose pins failed to
   * re-resolve (library race or parse quirk) — NOT an absence claim. */
  status: 'resolved' | 'absent' | 'unreadable';
  /** every refdes that uses this part */
  refs: string[];
  /** the primary query (MPN when present, else Value) */
  query: string;
  /** the Value fallback query, when distinct from the MPN */
  fallback?: string;
  /** top-ranked installed lib_id (resolved only) */
  libId?: string;
  /** unit count of the top match (resolved only) */
  units?: number;
  /** further candidate lib_ids beyond the top match */
  alternatives?: string[];
  /** the exact dossier body line this record renders as */
  line: string;
}

/** Why a resolution produced nothing: distinct reasons, because "could not
 * check" must never be conflated with "checked and absent" (I15). */
export type BomResolutionEmptyReason =
  | 'no-search-dirs'
  | 'no-readable-library'
  | 'no-searchable-rows'
  | 'error';

export type BomResolution =
  | {
      status: 'ok';
      parts: BomPartRecord[];
      /** parts whose probe threw — never checked, says nothing about availability */
      errored: string[];
      /** parts whose only name was too short to search — never checked */
      notSearched: string[];
      /** parts past the size cap — never checked (scans stop once the body is full) */
      overflow: string[];
    }
  | { status: 'empty'; reason: BomResolutionEmptyReason };

/**
 * Classify every BOM part against the installed libraries and return the
 * structured result the renderer (and the opt-in parts checkpoint) consume.
 * Never throws: any failure degrades to `{status: 'empty', reason}`.
 */
export async function resolveBomSymbols(
  bomMd: string,
  dirs: string[],
  opts: DossierOptions = {},
): Promise<BomResolution> {
  const searchCap = opts.searchCap ?? 3;
  const maxChars = opts.maxChars ?? 24_000;
  try {
    if (!dirs.length) return { status: 'empty', reason: 'no-search-dirs' };
    // No readable library at all must yield no dossier, not a page of
    // NO-INSTALLED-SYMBOL lines: a false absence claim in a machine-verified
    // block is the exact failure mode this file exists to prevent (I15).
    if (!(await listInstalledLibraries(dirs)).size) return { status: 'empty', reason: 'no-readable-library' };
    // Group refdes by primary query so a part used five times renders once.
    // The MPN is the stronger name when present; the stage-3 scaffold's
    // UNVERIFIED flag word is not part of it. The Value is kept as a fallback
    // query, searched only when the MPN finds nothing — a bogus MPN over a
    // resolvable Value must not read as NO INSTALLED SYMBOL.
    const byQuery = new Map<string, { refs: string[]; fallback?: string }>();
    const unsearchable: string[] = [];
    for (const row of parseBomTable(bomMd)) {
      if (PASSIVE_REFDES.test(row.refdes)) continue;
      const mpn = (row.mpn ?? '').replace(/^UNVERIFIED[:\s]*/i, '').trim();
      const value = (row.value ?? '').trim();
      const query = mpn || value;
      if (query.length < 3) {
        // Disclosed, not dropped: a crystal named "8M" was never searched, and
        // silence here would read as "checked" under a machine-verified label.
        unsearchable.push(`${row.refdes} (${query || 'no name'})`);
        continue;
      }
      const entry = byQuery.get(query) ?? { refs: [] };
      entry.refs.push(row.refdes);
      if (mpn && value.length >= 3 && value !== mpn) entry.fallback = value;
      byQuery.set(query, entry);
    }
    if (!byQuery.size && !unsearchable.length) return { status: 'empty', reason: 'no-searchable-rows' };

    const parts: BomPartRecord[] = [];
    const overflow: string[] = [];
    const errored: string[] = [];
    // Reserve room for the disclosure trailers up front, so the complete
    // rendered block — disclosures included — stays within maxChars.
    const TRAILER_BUDGET = Math.min(1200, Math.floor(maxChars / 4));
    const bodyBudget = maxChars - TRAILER_BUDGET;
    let spent = 0;
    // Once a line fails to fit, later parts skip their library scans entirely:
    // the cap bounds the work, not just the rendered output. (Lines have a
    // floor of ~60 chars, so a later part fitting where this one did not is
    // rare enough not to pay a full scan hoping for it.)
    let bodyFull = false;
    for (const [query, { refs, fallback }] of byQuery) {
      const who = `${refs.join(', ')} (${query})`;
      if (bodyFull) {
        overflow.push(who);
        continue;
      }
      let record: BomPartRecord;
      try {
        let hits = await searchInstalledSymbols(query, dirs, searchCap);
        let matchedBy = '';
        if (!hits.length && fallback) {
          hits = await searchInstalledSymbols(fallback, dirs, searchCap);
          if (hits.length) matchedBy = ` (matched by Value "${fallback}")`;
        }
        const base = { refs, query, ...(fallback !== undefined ? { fallback } : {}) };
        const top = hits[0];
        if (!top) {
          record = {
            ...base,
            status: 'absent',
            line: `- ${who}: NO INSTALLED SYMBOL matches — not capturable as named; substitute a part whose symbol exists (search_symbols to find one)`,
          };
        } else {
          const r = await resolveLibrarySymbol(top, dirs);
          if (r.status !== 'ok') {
            // A hit that fails to re-resolve is a library race or parse quirk;
            // report the candidates without claiming pins we could not read.
            record = {
              ...base,
              status: 'unreadable',
              alternatives: hits,
              line: `- ${who}: candidates ${hits.join(', ')} — pins unreadable here; confirm with symbol_pins`,
            };
          } else {
            const multi = r.units >= 2 ? ` — MULTI-UNIT (${r.units} units): the drafting engine refuses this symbol; choose a single-unit variant` : '';
            const also = hits.length > 1 ? `\n  also installed: ${hits.slice(1).join(', ')}` : '';
            record = {
              ...base,
              status: 'resolved',
              libId: top,
              units: r.units,
              ...(hits.length > 1 ? { alternatives: hits.slice(1) } : {}),
              line: `- ${who}: ${top}${matchedBy} — ${r.pins.length} pin(s): ${pinTable(r.pins)}${multi}${also}`,
            };
          }
        }
      } catch {
        errored.push(who); // one failed probe must not sink the block
        continue;
      }
      if (spent + record.line.length > bodyBudget) {
        overflow.push(who);
        bodyFull = true;
        continue;
      }
      spent += record.line.length;
      parts.push(record);
    }
    return { status: 'ok', parts, errored, notSearched: unsearchable, overflow };
  } catch {
    return { status: 'empty', reason: 'error' };
  }
}

/**
 * Assemble the rendered dossier block from a resolution: the per-part body
 * lines plus the disclosure trailers, bounded as a whole by `maxChars`.
 * Returns `''` when there is nothing to say — the caller injects nothing
 * rather than an empty heading.
 */
export function renderDossier(resolution: BomResolution, opts: DossierOptions = {}): string {
  const maxChars = opts.maxChars ?? 24_000;
  if (resolution.status !== 'ok') return '';
  const lines: string[] = resolution.parts.map((p) => p.line);
  const { errored, notSearched, overflow } = resolution;
  if (!lines.length && !overflow.length && !errored.length && !notSearched.length) return '';
  // Distinct disclosures: a probe error is not a size decision, an
  // unsearchable name is neither, and labeling any of them "size cap" would
  // misreport why coverage is missing. Each trailer shares the reserved
  // budget so the complete block stays within maxChars.
  const trailers: [string, string[], string][] = [];
  if (errored.length) {
    trailers.push([
      '- UNRESOLVED (probe error): ',
      errored,
      ' — the probe failed for these; an error says nothing about availability, call symbol_pins for each.',
    ]);
  }
  if (notSearched.length) {
    trailers.push([
      '- NOT SEARCHED (name shorter than 3 chars): ',
      notSearched,
      ' — too short to search reliably; nothing here says whether these resolve. Give them an MPN, or verify by hand.',
    ]);
  }
  if (overflow.length) {
    trailers.push([
      `- NOT INCLUDED (size cap ${maxChars} chars): `,
      overflow,
      ' — call symbol_pins for each; nothing above says whether these resolve.',
    ]);
  }
  // Allocate from what is actually left of maxChars (body lines plus the
  // newlines join() will add), splitting the remainder across the trailers
  // still to render — a fixed per-trailer share of the reserve could exceed
  // the whole-block bound when the shares themselves cannot fit.
  let used = lines.reduce((a, l) => a + l.length + 1, 0);
  for (let i = 0; i < trailers.length; i++) {
    const [prefix, names, suffix] = trailers[i]!;
    const budget = Math.floor((maxChars - used) / (trailers.length - i));
    const rendered = boundedList(prefix, names, suffix, budget);
    lines.push(rendered);
    used += rendered.length + 1;
  }
  return lines.join('\n');
}

/**
 * Render the dossier block from BOM markdown. Returns `''` when there is
 * nothing to say (no rows survive the passive filter, no search dirs, or any
 * error) — the caller injects nothing rather than an empty heading.
 */
export async function bomSymbolDossier(
  bomMd: string,
  dirs: string[],
  opts: DossierOptions = {},
): Promise<string> {
  try {
    return renderDossier(await resolveBomSymbols(bomMd, dirs, opts), opts);
  } catch {
    return '';
  }
}
