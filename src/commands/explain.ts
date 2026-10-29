/**
 * `copperhead explain <query>`: deterministic lookup of a refdes, net, or pin
 * against the schematic and design docs. LLM-free and network-free.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { listNets, listSymbols, pinNets, type PinNet, type SchematicSymbol } from '../kicad/sexp.js';
import { parseBomTable, parsePinoutRows, type BomRow } from '../memory/bom-table.js';
import { copper, dim, err, warn } from '../agent/theme.js';
import { shortPath } from '../util/paths.js';

export type ExplainKind = 'part' | 'net' | 'pin';

export interface ExplainPinRow {
  number: string;
  name: string;
  net: string | null;
}

export interface ExplainMention {
  file: string;
  excerpt: string;
}

export interface ExplainPartHit {
  kind: 'part';
  query: string;
  ref: string;
  value: string;
  footprint: string;
  libId: string;
  sheet: string;
  pins: ExplainPinRow[];
  bom: BomRow | null;
  pinout: Array<{ pin: string; net: string }>;
  mentions: ExplainMention[];
}

export interface ExplainNetHit {
  kind: 'net';
  query: string;
  name: string;
  pins: Array<{ ref: string; number: string; name: string }>;
  pinout: Array<{ ref: string; pin: string }>;
  mentions: ExplainMention[];
}

export interface ExplainPinHit {
  kind: 'pin';
  query: string;
  ref: string;
  number: string;
  name: string;
  net: string | null;
  part: { value: string; footprint: string; libId: string; sheet: string } | null;
  /** Other pin numbers on the same part that share this pin's name and net. */
  sharedWith?: string[];
  mentions: ExplainMention[];
}

export type ExplainHit = ExplainPartHit | ExplainNetHit | ExplainPinHit;

export interface ExplainSuccess {
  ok: true;
  hit: ExplainHit;
}

export interface ExplainFailure {
  ok: false;
  error: string;
  suggestions: string[];
}

export type ExplainResult = ExplainSuccess | ExplainFailure;

const PIN_QUERY = /^([A-Za-z]{1,6}\d{1,4}[A-Za-z]?)\.(.+)$/;

function eq(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

function wordRe(query: string): RegExp {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i');
}

async function loadDocs(
  docsDir: string,
): Promise<{ bom: BomRow[]; pinout: Array<{ ref: string; pin: string; net: string }>; mentionsOf: (query: string) => Promise<ExplainMention[]> }> {
  const bomPath = path.join(docsDir, 'BOM.md');
  const pinoutPath = path.join(docsDir, 'PINOUT.md');
  const bom = existsSync(bomPath) ? parseBomTable(await readFile(bomPath, 'utf8')) : [];
  const pinout = existsSync(pinoutPath) ? parsePinoutRows(await readFile(pinoutPath, 'utf8')) : [];

  const mentionsOf = async (query: string): Promise<ExplainMention[]> => {
    if (!existsSync(docsDir)) return [];
    const re = wordRe(query);
    const out: ExplainMention[] = [];
    let files: string[] = [];
    try {
      files = (await readdir(docsDir)).filter((f) => f.endsWith('.md')).sort();
    } catch {
      return [];
    }
    for (const file of files) {
      const text = await readFile(path.join(docsDir, file), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|---')) continue;
        if (!re.test(trimmed)) continue;
        out.push({ file, excerpt: trimmed.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim() });
        if (out.length >= 8) return out;
      }
    }
    return out;
  };

  return { bom, pinout, mentionsOf };
}

function suggestionsFor(query: string, refs: string[], nets: string[]): string[] {
  const q = query.toLowerCase();
  const pool = [...new Set([...refs, ...nets])];
  const scored = pool
    .map((name) => {
      const n = name.toLowerCase();
      let score = 0;
      if (n === q) score = 100;
      else if (n.startsWith(q)) score = 80 - Math.min(20, n.length - q.length);
      else if (n.includes(q)) score = 40;
      else if (q.startsWith(n) && n.length >= 2) score = 20;
      return { name, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return scored.slice(0, 5).map((s) => s.name);
}

function pinsOf(ref: string, pins: PinNet[]): ExplainPinRow[] {
  return pins
    .filter((p) => eq(p.ref, ref))
    .map((p) => ({ number: p.pinNumber, name: p.pinName, net: p.net }))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

function partHit(
  query: string,
  sym: SchematicSymbol,
  pins: PinNet[],
  bom: BomRow[],
  pinout: Array<{ ref: string; pin: string; net: string }>,
  mentions: ExplainMention[],
): ExplainPartHit {
  return {
    kind: 'part',
    query,
    ref: sym.ref,
    value: sym.value,
    footprint: sym.footprint,
    libId: sym.libId,
    sheet: sym.sheet,
    pins: pinsOf(sym.ref, pins),
    bom: bom.find((r) => eq(r.refdes, sym.ref)) ?? null,
    pinout: pinout.filter((r) => eq(r.ref, sym.ref)).map((r) => ({ pin: r.pin, net: r.net })),
    mentions,
  };
}

function netHit(
  query: string,
  name: string,
  pins: PinNet[],
  pinout: Array<{ ref: string; pin: string; net: string }>,
  mentions: ExplainMention[],
): ExplainNetHit {
  const attached = pins
    .filter((p) => p.net !== null && eq(p.net, name))
    .map((p) => ({ ref: p.ref, number: p.pinNumber, name: p.pinName }))
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }) || a.number.localeCompare(b.number, undefined, { numeric: true }));
  return {
    kind: 'net',
    query,
    name,
    pins: attached,
    pinout: pinout.filter((r) => eq(r.net, name)).map((r) => ({ ref: r.ref, pin: r.pin })),
    mentions,
  };
}

/**
 * Resolve `query` against the configured schematic. `query` is a refdes (`U1`),
 * a net (`GND`), a pin (`U1.GPIO14` or `R2.1`), or a unique pin name (`GPIO14`).
 */
export async function explainQuery(repoRoot: string, query: string): Promise<ExplainResult> {
  const q = query.trim();
  if (!q) {
    return { ok: false, error: 'explain needs a refdes, net, or pin (for example U1, GND, or U1.GPIO14)', suggestions: [] };
  }

  const config = await loadConfig(repoRoot);
  if (!config.schematic) {
    return { ok: false, error: 'no schematic configured (run copperhead init)', suggestions: [] };
  }
  const schPath = path.join(repoRoot, config.schematic);
  if (!existsSync(schPath)) {
    return { ok: false, error: `schematic missing: ${config.schematic}`, suggestions: [] };
  }

  const [symbols, nets, pins] = await Promise.all([listSymbols(schPath), listNets(schPath), pinNets(schPath)]);
  const docsDir = path.join(repoRoot, config.docs);
  const docs = await loadDocs(docsDir);
  const refs = symbols.map((s) => s.ref);
  const fail = (error: string): ExplainFailure => ({
    ok: false,
    error,
    suggestions: suggestionsFor(q, refs, nets),
  });

  const symOf = (ref: string): SchematicSymbol | null => symbols.find((s) => eq(s.ref, ref)) ?? null;
  const pinHitOf = async (pin: PinNet, sharedWith: string[] = [], mentionKey?: string): Promise<ExplainSuccess> => {
    const sym = symOf(pin.ref);
    return {
      ok: true,
      hit: {
        kind: 'pin',
        query: q,
        ref: pin.ref,
        number: pin.pinNumber,
        name: pin.pinName,
        net: pin.net,
        part: sym ? { value: sym.value, footprint: sym.footprint, libId: sym.libId, sheet: sym.sheet } : null,
        ...(sharedWith.length ? { sharedWith } : {}),
        mentions: await docs.mentionsOf(pin.net ?? mentionKey ?? `${pin.ref}.${pin.pinNumber}`),
      },
    };
  };

  // REF.PIN is tried first, but a miss falls through to the refdes, net, and
  // pin-name steps so dotted net names like VDD1.8 still resolve.
  let pinError: string | null = null;
  const pinMatch = PIN_QUERY.exec(q);
  if (pinMatch) {
    const ref = pinMatch[1]!;
    const pinTok = pinMatch[2]!;
    if (!symOf(ref)) {
      pinError = `no part ${ref}`;
    } else {
      const onRef = pins.filter((p) => eq(p.ref, ref));
      const byNumber = onRef.find((p) => eq(p.pinNumber, pinTok));
      if (byNumber) return pinHitOf(byNumber);
      const byName = onRef.filter((p) => p.pinName !== '~' && eq(p.pinName, pinTok));
      if (byName.length > 1) {
        const nets = new Set(byName.map((p) => p.net));
        if (nets.size > 1) {
          const numbers = byName.map((p) => p.pinNumber).join(', ');
          return fail(`${ref} pins ${numbers} are named ${pinTok}: use ${ref}.<number>`);
        }
        return pinHitOf(byName[0]!, byName.slice(1).map((p) => p.pinNumber));
      }
      if (byName.length === 1) return pinHitOf(byName[0]!);
      const known = pinsOf(ref, pins)
        .map((p) => (p.name && p.name !== '~' ? `${p.number}/${p.name}` : p.number))
        .join(', ');
      pinError = `no pin ${pinTok} on ${ref}${known ? ` (pins: ${known})` : ''}`;
    }
  }

  const byRef = symbols.find((s) => eq(s.ref, q));
  if (byRef) {
    return {
      ok: true,
      hit: partHit(q, byRef, pins, docs.bom, docs.pinout, await docs.mentionsOf(byRef.ref)),
    };
  }

  const byNet = nets.find((n) => eq(n, q)) ?? pins.map((p) => p.net).find((n): n is string => n !== null && eq(n, q));
  if (byNet) {
    return {
      ok: true,
      hit: netHit(q, byNet, pins, docs.pinout, await docs.mentionsOf(byNet)),
    };
  }

  const named = pins.filter((p) => p.pinName !== '~' && eq(p.pinName, q));
  const uniqueRefs = [...new Set(named.map((p) => p.ref))];
  if (uniqueRefs.length === 1) {
    if (named.length === 1) return pinHitOf(named[0]!, [], named[0]!.pinName);
    const ref = uniqueRefs[0]!;
    const numbers = named.map((p) => p.pinNumber).join(', ');
    return fail(`pin name ${q} is on ${ref} pins ${numbers}: use REF.PIN`);
  }
  if (uniqueRefs.length > 1) {
    return fail(`pin name ${q} is on ${uniqueRefs.join(', ')} — use REF.PIN`);
  }

  return fail(pinError ?? `nothing named ${q} in the schematic`);
}

function pinLine(p: ExplainPinRow): string {
  const name = p.name && p.name !== '~' ? p.name : '—';
  return `  ${p.number.padEnd(4)} ${name.padEnd(12)} ${p.net ?? dim('(unconnected)')}`;
}

/** Human-readable explanation. Color-safe: helpers no-op when color is off. */
export function formatExplain(result: ExplainResult): string {
  if (!result.ok) {
    const lines = ['', err(`  ${result.error}`)];
    if (result.suggestions.length) {
      lines.push(dim(`  did you mean: ${result.suggestions.join(', ')}`));
    }
    lines.push('');
    return lines.join('\n');
  }

  const hit = result.hit;
  const lines: string[] = [''];

  if (hit.kind === 'part') {
    lines.push(`  ${copper(hit.ref)}  ${hit.value || dim('(no value)')}`);
    lines.push(dim(`  lib        ${hit.libId || '—'}`));
    lines.push(dim(`  footprint  ${hit.footprint || '—'}`));
    lines.push(dim(`  sheet      ${hit.sheet || '/'}`));
    lines.push('');
    if (hit.pins.length) {
      lines.push(dim('  pin  name         net'));
      for (const p of hit.pins) lines.push(pinLine(p));
    } else {
      lines.push(dim('  no pins recorded'));
    }
    if (hit.bom) {
      lines.push('');
      lines.push(dim('  BOM'));
      lines.push(`    value ${hit.bom.value ?? '—'}  mpn ${hit.bom.mpn ?? '—'}${hit.bom.flags.length ? dim(` [${hit.bom.flags.join(',')}]`) : ''}`);
    }
  } else if (hit.kind === 'net') {
    lines.push(`  net ${copper(hit.name)}  ${dim(`${hit.pins.length} pin(s)`)}`);
    lines.push('');
    if (hit.pins.length) {
      for (const p of hit.pins) {
        const name = p.name && p.name !== '~' ? ` (${p.name})` : '';
        lines.push(`  ${copper(p.ref)}.${p.number}${name}`);
      }
    } else {
      lines.push(dim('  no pins attached (label-only net)'));
    }
  } else {
    const name = hit.name && hit.name !== '~' ? hit.name : '—';
    lines.push(`  ${copper(`${hit.ref}.${hit.number}`)}  ${name}`);
    lines.push(dim(`  net  ${hit.net ?? '(unconnected)'}`));
    if (hit.sharedWith?.length) {
      lines.push(dim(`  also ${hit.ref} pin(s) ${hit.sharedWith.join(', ')} (same name, same net)`));
    }
    if (hit.part) {
      lines.push(dim(`  part ${hit.part.value || hit.ref}  ${hit.part.footprint || hit.part.libId}`));
    }
  }

  if (hit.mentions.length) {
    lines.push('');
    lines.push(dim('  mentioned in'));
    for (const m of hit.mentions.slice(0, 5)) {
      const excerpt = m.excerpt.length > 88 ? `${m.excerpt.slice(0, 87)}…` : m.excerpt;
      lines.push(`    ${shortPath(m.file)}  ${dim(excerpt)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** Look up `query` and return formatted text plus the structured result. */
export async function runExplain(
  repoRoot: string,
  query: string,
): Promise<{ result: ExplainResult; text: string }> {
  const result = await explainQuery(repoRoot, query);
  return { result, text: formatExplain(result) };
}
