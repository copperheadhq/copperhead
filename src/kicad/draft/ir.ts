import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SymbolSource, SymbolResolutionError, powerNetToken, type ResolvedSymbol } from './symsource.js';
import { parseBomTable, normalizeValue } from '../../memory/bom-table.js';

/**
 * The netlist-intent IR (`schematic.intent.json`): the compact declarative
 * input the model authors instead of geometry (design D5/D6). No coordinates,
 * ever — the engine computes every position. Re-drafting the same IR fully
 * regenerates the sheet.
 */

export const INTENT_VERSION = 1;
export const INTENT_FILENAME = 'schematic.intent.json';

export interface IntentPart {
  ref: string;
  libId: string;
  value: string;
  footprint?: string;
  /** Subsystem group (from SUBSYSTEMS.md); required for every non-power part. */
  group: string;
}

export interface IntentNet {
  name: string;
  /** Endpoints as `"REF.PIN"` (pin number). */
  pins: string[];
  /** Optional class override; wins over pin-type inference (engine spec). */
  kind?: 'power' | 'ground' | 'signal';
}

export interface SchematicIntent {
  version: number;
  parts: IntentPart[];
  nets: IntentNet[];
  /** Pins deliberately unconnected; emitted as `(no_connect …)` markers. */
  noConnect?: string[];
  hints?: {
    /** Left-to-right group order override; otherwise SUBSYSTEMS.md order. */
    groupOrder?: string[];
    /** Pin the paper size instead of deriving it from content. */
    paper?: string;
    /** Title-block date. Part of the IR (not the wall clock) so identical IR
     * emits identical bytes on any day (design D4). */
    date?: string;
  };
}

export interface IrFinding {
  detail: string;
}

export interface ValidatedIntent {
  intent: SchematicIntent;
  symbols: Map<string, ResolvedSymbol>;
  /** SUBSYSTEMS.md heading names in declaration order, or null when absent. */
  docGroups: string[] | null;
}

/** `## Heading` names from a markdown file, in order. */
async function headingsOf(file: string): Promise<string[] | null> {
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  const names = [...text.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) => m[1]!.trim()).filter(Boolean);
  return names.length ? names : null;
}

/**
 * BOM.md rows as { ref, value }, or null when the file/table is absent.
 *
 * Goes through the shared canonical reader (`parseBomTable`) rather than
 * scanning every pipe-line in the file: the old inline scan read a supporting
 * table's rows (a quiescent-current roll-up, a cost summary) as parts.
 * `parseBomTable` reads only the Refdes-headed canonical table(s) and resolves
 * Value by header *name*, the same discipline `checkDrift` and `export bom`
 * already use.
 *
 * One row per refdes: a cell naming several parts (`R1, R2`, `C5-C8`) is read
 * verbatim and simply matches nothing, because the BOM contract is one row per
 * part — the row's single Rationale cell is where that part's purpose lives.
 */
async function bomRowsOf(file: string): Promise<{ ref: string; value: string }[] | null> {
  if (!existsSync(file)) return null;
  const rows = parseBomTable(await readFile(file, 'utf8')).map((r) => ({ ref: r.refdes, value: r.value ?? '' }));
  return rows.length ? rows : null;
}

/**
 * Is this BOM Value cell a component *value*, or a description?
 *
 * The Value cell is drawn on the sheet as the symbol's Value field, so its
 * length is a layout input, not just documentation. A cell like
 * `1S Li-Po cell, 500 mAh, bare leads` renders as 34 characters beside a
 * battery symbol and collides with its neighbours — an error-severity
 * legibility finding that `create`'s stage-4 contract refuses to pass.
 *
 * That is unrecoverable without this check. The IR is the agent's only lever
 * on the drawn sheet (`edit_file` is refused on a drafted schematic), and the
 * BOM cross-check below pins the IR value to this cell — so shortening the
 * value in the IR fails validation, and leaving it fails legibility. The run
 * that found this burned all three stage-4 attempts and 2h49m discovering the
 * loop, twice, because the legibility findings never named BOM.md as the thing
 * to change (see the deadlock issue).
 *
 * Heuristic, deliberately loose — it fires only on cells that are clearly
 * prose, so a legitimately long value (`STM32F103C8T6`,
 * `JST_PH_S2B-PH-K_1x02_P2.00mm`) is left alone:
 *  - a comma-separated clause list where a later clause contains a space
 *    (`4.7uF, X5R, 10V, 0603` is a value; `P-MOSFET, divider gate` is prose), or
 *  - a cell too long to draw (> MAX_DRAWN_VALUE chars) that contains a space.
 *    A single unbroken token over the cap (`JST_PH_S2B-PH-K_1x02_P2.00mm`,
 *    28 chars) is a real part identifier with no prose to move into Rationale,
 *    so length alone never refuses it — a wide Value field costs legibility
 *    score, but a hard refusal with no escape hatch would wedge the pipeline.
 */
const MAX_DRAWN_VALUE = 24;

export function looksLikeDescription(value: string): boolean {
  const v = value.replace(/`/g, '').trim();
  if (!v) return false;
  if (v.length > MAX_DRAWN_VALUE && v.includes(' ')) return true;
  const clauses = v.split(',').map((c) => c.trim());
  return clauses.length > 1 && clauses.slice(1).some((c) => c.includes(' ') && /[a-z]{3}/i.test(c));
}

export function parseIntent(json: string): { intent: SchematicIntent | null; findings: IrFinding[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { intent: null, findings: [{ detail: `intent is not valid JSON: ${(e as Error).message}` }] };
  }
  if (raw === null || typeof raw !== 'object') {
    return { intent: null, findings: [{ detail: 'intent must be a JSON object' }] };
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== INTENT_VERSION) {
    return {
      intent: null,
      findings: [{ detail: `unsupported intent version ${JSON.stringify(o.version)}; this engine supports version ${INTENT_VERSION}` }],
    };
  }
  if (!Array.isArray(o.parts) || !Array.isArray(o.nets)) {
    return { intent: null, findings: [{ detail: 'intent needs "parts" and "nets" arrays' }] };
  }
  return { intent: raw as SchematicIntent, findings: [] };
}

/**
 * Validate the IR before any placement (design D6): structural checks, lib
 * resolution, pin existence, group membership against SUBSYSTEMS.md, no-connect
 * consistency, and the BOM.md cross-check. A failed validation means nothing is
 * written; findings come back numbered in the verify_symbols shape.
 */
export async function validateIntent(
  intent: SchematicIntent,
  symsource: SymbolSource,
  docsDir: string | null,
): Promise<{ ok: boolean; findings: IrFinding[]; validated: ValidatedIntent | null }> {
  const findings: IrFinding[] = [];
  const add = (detail: string): void => {
    findings.push({ detail });
  };

  // parts: shape, duplicates, lib resolution. Field TYPES are checked here so a
  // type-confused-but-valid JSON part ("group": 5) comes back as a numbered
  // finding the model can act on, not a TypeError surfaced as an opaque tool
  // error — the repair contract matters most exactly when the input is wrong.
  const symbols = new Map<string, ResolvedSymbol>();
  const partByRef = new Map<string, IntentPart>();
  for (const p of intent.parts) {
    if (typeof (p as unknown as { ref?: unknown })?.ref !== 'string' || !p.ref || typeof p.libId !== 'string' || !p.libId || typeof p.value !== 'string') {
      add(`part ${JSON.stringify(p?.ref ?? '(missing ref)')} needs string ref, libId, and value fields`);
      continue;
    }
    if (p.group !== undefined && typeof p.group !== 'string') {
      add(`${p.ref}: "group" must be a string (a SUBSYSTEMS.md heading), got ${JSON.stringify(p.group)}`);
      continue;
    }
    if (p.footprint !== undefined && typeof p.footprint !== 'string') {
      add(`${p.ref}: "footprint" must be a string, got ${JSON.stringify(p.footprint)}`);
      continue;
    }
    if (partByRef.has(p.ref)) {
      add(`duplicate refdes ${p.ref}`);
      continue;
    }
    partByRef.set(p.ref, p);
    try {
      const sym = await symsource.resolve(p.libId);
      // A multi-unit symbol's units share symbol-space pin coordinates, so
      // placing it as one instance overlays unrelated pins on one point and
      // silently merges their nets (an LM358 drafted this way fused its two
      // outputs). Refused until the engine can place units individually.
      if (sym.multiUnit) {
        add(
          `${p.ref}: "${p.libId}" is a multi-unit symbol (an opamp or gate pack), which the drafting engine ` +
            `cannot place yet; use a single-unit part instead`,
        );
        continue;
      }
      symbols.set(p.ref, sym);
      // A power-port part passes every structural check and is then silently
      // dropped: the engine synthesizes its own per-pin power symbols from each
      // net's class and filters `isPower` parts out of every placement path, so
      // the part is never placed, never given an endpoint, never added to
      // `lib_symbols`, and never mentioned in the report (#212). The draft still
      // returns ok, and the engine vendors the symbol on the way past, so the
      // project accumulates a cached symbol for a part that was never drawn.
      //
      // Refused rather than noted: a model that writes `power:GND`, sees
      // `ok: true`, and finds nothing in `notes` has no way to learn its mental
      // model is wrong, so it keeps doing it. A finding is the channel that
      // teaches. Recorded in `symbols` first so the group and BOM cross-checks
      // below take their `isPower` skips and this stays ONE finding rather than
      // three unrelated-looking ones.
      if (sym.isPower) {
        add(
          `${p.ref}: "${p.libId}" is a power-port symbol, which the drafting engine supplies itself. ` +
            `Remove ${p.ref} from "parts" (and from every net's "pins"): the engine draws a power symbol at ` +
            `each pin of a power-class net automatically, rails up and grounds down, and synthesizes a ` +
            `PWR_FLAG for any such net with no driving pin. Name the rail in "nets" instead, and set that ` +
            `net's "kind" to "power" or "ground" if the inferred class is wrong.`,
        );
      }
    } catch (e) {
      if (e instanceof SymbolResolutionError) add(`${p.ref}: ${e.message}`);
      else throw e;
    }
  }

  // groups: exactly one per non-power part, validated against SUBSYSTEMS.md when present
  const docGroups = docsDir ? await headingsOf(path.join(docsDir, 'SUBSYSTEMS.md')) : null;
  for (const p of partByRef.values()) {
    const sym = symbols.get(p.ref);
    if (sym?.isPower) continue;
    if (!p.group) {
      add(`${p.ref} has no group assignment; available groups: ${docGroups?.join(', ') ?? '(SUBSYSTEMS.md absent)'}`);
    } else if (docGroups && !docGroups.some((g) => g.toLowerCase() === p.group.toLowerCase())) {
      add(`${p.ref} names group "${p.group}", which is not a SUBSYSTEMS.md heading; available: ${docGroups.join(', ')}`);
    }
  }

  // nets: endpoints exist, at least two of them
  const pinKey = (ref: string, pin: string): string => `${ref}.${pin}`;
  const usedPins = new Set<string>();
  const netNames = new Set<string>();
  for (const net of intent.nets) {
    if (typeof (net as unknown as { name?: unknown })?.name !== 'string' || !net.name || !Array.isArray(net.pins)) {
      add(`net ${JSON.stringify(net?.name ?? '(unnamed)')} needs a string name and a pins array`);
      continue;
    }
    // The name is drawn as label text and embedded verbatim in the generated
    // power-symbol source; a quote, backslash, or control character would emit
    // a structurally corrupt schematic, so it dies here as a finding instead.
    if ([...net.name].some((c) => c === '"' || c === '\\' || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      add(`net name ${JSON.stringify(net.name)} contains characters that cannot be drawn (quotes, backslashes, or control characters); rename the net`);
      continue;
    }
    if (net.kind !== undefined && net.kind !== 'power' && net.kind !== 'ground' && net.kind !== 'signal') {
      add(`net ${net.name}: "kind" must be "power", "ground", or "signal", got ${JSON.stringify(net.kind)}`);
    }
    if (netNames.has(net.name)) add(`duplicate net name ${net.name}`);
    netNames.add(net.name);
    if (net.pins.length < 2) add(`net ${net.name} has ${net.pins.length} endpoint(s); a net needs at least two`);
    for (const ep of net.pins) {
      if (typeof ep !== 'string') {
        add(`net ${net.name}: endpoint ${JSON.stringify(ep)} must be a "REF.PIN" string`);
        continue;
      }
      const m = /^([^.]+)\.(.+)$/.exec(ep);
      if (!m) {
        add(`net ${net.name}: endpoint "${ep}" is not of the form REF.PIN`);
        continue;
      }
      const [, ref, pin] = m;
      const sym = symbols.get(ref!);
      if (!partByRef.has(ref!)) {
        add(`net ${net.name}: endpoint "${ep}" references unknown part ${ref}`);
        continue;
      }
      if (sym && !sym.pins.some((p) => p.number === pin)) {
        add(`net ${net.name}: ${ref} has no pin ${pin}; its pins are [${sym.pins.map((p) => p.number).join(', ')}]`);
      }
      if (usedPins.has(pinKey(ref!, pin!))) add(`pin ${ep} appears in more than one net`);
      usedPins.add(pinKey(ref!, pin!));
    }
  }

  // Two power-class nets whose names sanitize to one symbol token would share
  // one generated `copperhead_power:` lib_id and one embedded pin name, so
  // KiCad's netlist can quietly merge the rails (last write wins in the
  // lib_symbols map). Refused here as a finding, before any placement.
  const isPowerClass = (net: IntentNet): boolean => {
    if (net.kind === 'power' || net.kind === 'ground') return true;
    if (net.kind === 'signal') return false;
    return net.pins.some((ep) => {
      const m = typeof ep === 'string' ? /^([^.]+)\.(.+)$/.exec(ep) : null;
      if (!m) return false;
      const pin = symbols.get(m[1]!)?.pins.find((pn) => pn.number === m[2]);
      return pin !== undefined && (pin.etype === 'power_in' || pin.etype === 'power_out');
    });
  };
  const byToken = new Map<string, Set<string>>();
  for (const net of intent.nets) {
    if (typeof (net as unknown as { name?: unknown })?.name !== 'string' || !Array.isArray(net.pins)) continue;
    if (!isPowerClass(net)) continue;
    const token = powerNetToken(net.name);
    const names = byToken.get(token) ?? new Set<string>();
    names.add(net.name);
    byToken.set(token, names);
  }
  for (const [token, names] of byToken) {
    if (names.size > 1) {
      add(
        `power nets ${[...names].sort().join(' and ')} both sanitize to the symbol token "${token}", ` +
          `which would give them one shared power symbol and merge the rails; rename one so the tokens differ`,
      );
    }
  }

  // no-connects: an array of REF.PIN strings; each pin exists and is not in any net
  const noConnect = intent.noConnect ?? [];
  if (!Array.isArray(noConnect) || noConnect.some((e) => typeof e !== 'string')) {
    add(`"noConnect" must be an array of "REF.PIN" strings, got ${JSON.stringify(intent.noConnect)}`);
  } else {
    for (const ep of noConnect) {
      const m = /^([^.]+)\.(.+)$/.exec(ep);
      if (!m) {
        add(`noConnect entry "${ep}" is not of the form REF.PIN`);
        continue;
      }
      const [, ref, pin] = m;
      const sym = symbols.get(ref!);
      if (!partByRef.has(ref!)) add(`noConnect "${ep}" references unknown part ${ref}`);
      else if (sym && !sym.pins.some((p) => p.number === pin)) add(`noConnect "${ep}": ${ref} has no pin ${pin}`);
      if (usedPins.has(`${ref}.${pin}`)) add(`pin ${ep} is declared no-connect but appears in a net`);
    }
  }

  // hints: every field the engine or emitter dereferences is type-checked here,
  // so "hints": {"groupOrder": "Power"} steers back as a finding instead of a
  // TypeError inside the placement pass
  const hints = intent.hints;
  if (hints !== undefined) {
    if (hints === null || typeof hints !== 'object' || Array.isArray(hints)) {
      add(`"hints" must be an object, got ${JSON.stringify(hints)}`);
    } else {
      if (hints.groupOrder !== undefined && (!Array.isArray(hints.groupOrder) || hints.groupOrder.some((g) => typeof g !== 'string'))) {
        add(`"hints.groupOrder" must be an array of group-name strings, got ${JSON.stringify(hints.groupOrder)}`);
      }
      if (hints.paper !== undefined && typeof hints.paper !== 'string') {
        add(`"hints.paper" must be a string (a standard sheet name like "A3"), got ${JSON.stringify(hints.paper)}`);
      }
      if (hints.date !== undefined && typeof hints.date !== 'string') {
        add(`"hints.date" must be a string, got ${JSON.stringify(hints.date)}`);
      }
    }
  }

  // BOM cross-check: a transcription slip dies here, not at the drift gate (D6)
  const bomRows = docsDir ? await bomRowsOf(path.join(docsDir, 'BOM.md')) : null;
  if (bomRows) {
    const bomByRef = new Map(bomRows.map((r) => [r.ref, r.value]));
    for (const p of partByRef.values()) {
      if (symbols.get(p.ref)?.isPower) continue;
      const bomValue = bomByRef.get(p.ref);
      if (bomValue === undefined) {
        add(`${p.ref} is not a BOM.md row; add it to the BOM or drop it from the intent`);
        continue;
      }
      // Drawability first, and independently of whether the two agree. Whether
      // the cell can be drawn is a property of BOM.md alone, and the agent's
      // first instinct on an unreadable sheet is to shorten the value in the
      // intent — which makes the two differ. Reporting this only on a match
      // answers that instinct with "differs from BOM.md's …" and never names the
      // real problem, which is the loop this check exists to break: the fix is in
      // the doc, not the intent.
      if (looksLikeDescription(bomValue)) {
        add(
          `${p.ref}: BOM.md's Value is a description, not a component value ("${bomValue}"). ` +
            `It is drawn on the sheet as ${p.ref}'s Value field, where it collides with neighbouring symbols ` +
            `and fails the legibility gate — and you cannot shorten it in the intent alone, because this ` +
            `cross-check requires the two to agree. Fix docs/BOM.md: put the component value in the Value column ` +
            `(e.g. "500mAh Li-Po", "4.7uF", "1M") and move the prose to the Rationale column, then update the intent to match.`,
        );
        continue; // the value mismatch below would be noise next to this
      }
      // Compared through the shared value key, not raw bytes: `1 MΩ` vs `1 Mohm`
      // and `4.7uF` vs `4.7 µF` are encoding differences with no electrical
      // meaning. `checkDrift` has always folded them (normalizeValue); this gate
      // running stricter than the gate downstream of it meant an IR that would
      // pass drift could still be refused here, with no way to satisfy both.
      if (normalizeValue(bomValue) !== normalizeValue(p.value)) {
        add(`${p.ref} value "${p.value}" differs from BOM.md's "${bomValue}"`);
      }
    }
  }

  if (findings.length) return { ok: false, findings, validated: null };
  return { ok: true, findings: [], validated: { intent, symbols, docGroups } };
}

export function formatIrFindings(findings: IrFinding[]): string {
  return [
    `intent validation: ${findings.length} finding(s) to reconcile:`,
    ...findings.map((f, i) => `  ${i + 1}. ${f.detail}`),
  ].join('\n');
}