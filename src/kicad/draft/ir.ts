```typescript
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SymbolSource, SymbolResolutionError, powerNetToken, type ResolvedSymbol } from './symsource.js';
import { parseBomTable, normalizeValue, normalizeFootprint, bomFootprintRows } from '../../memory/bom-table.js';
import { readFootprintPads, exposedPads, isMechanicalPad, formatPadMismatch, type FootprintResolver } from '../footprints.js';

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
  /** What validation noticed but did not refuse: reported in the draft's notes. */
  warnings: string[];
}

/** `## Heading` names from a markdown file, in order. */
async function headingsOf(file: string): Promise<string[] | null> {
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  const names = [...text.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) => m[1]!.trim()).filter(Boolean);
  return names.length ? names : null;
}

/**
 * Strips section numbers from headings or group names.
 * Supports formats like "1.", "1)", "1.1.", etc.
 */
function stripSectionNumber(s: string): string {
  return s.replace(/^\d+(?:\.\d+)*[.)]?\s+/, '').trim().toLowerCase();
}

/**
 * Checks if a group matches a heading, considering stripped section numbers.
 */
function groupMatchesHeading(heading: string, group: string): boolean {
  return (
    heading.toLowerCase() === group.toLowerCase() ||
    stripSectionNumber(heading) === stripSectionNumber(group)
  );
}

/**
 * BOM.md rows as { ref, value }, or null when the file/table is absent.
 */
async function bomRowsOf(file: string): Promise<{ ref: string; value: string; footprint: string }[] | null> {
  if (!existsSync(file)) return null;
  const md = await readFile(file, 'utf8');
  const fps = new Map(bomFootprintRows(md).map((r) => [r.refdes, r.footprint]));
  const seen = new Set<string>();
  const rows: { ref: string; value: string; footprint: string }[] = [];
  for (const r of parseBomTable(md)) {
    if (seen.has(r.refdes)) continue;
    seen.add(r.refdes);
    rows.push({ ref: r.refdes, value: r.value ?? '', footprint: fps.get(r.refdes) ?? '' });
  }
  return rows.length ? rows : null;
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
  footprints?: FootprintResolver,
): Promise<{ ok: boolean; findings: IrFinding[]; validated: ValidatedIntent | null }> {
  const findings: IrFinding[] = [];
  const warnings: string[] = [];
  const add = (detail: string): void => {
    findings.push({ detail });
  };

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
      symbols.set(p.ref, sym);
    } catch (e) {
      if (e instanceof SymbolResolutionError) add(`${p.ref}: ${e.message}`);
      else throw e;
    }
  }

  const docGroups = docsDir ? await headingsOf(path.join(docsDir, 'SUBSYSTEMS.md')) : null;
  for (const p of partByRef.values()) {
    const sym = symbols.get(p.ref);
    if (sym?.isPower) continue;
    if (!p.group) {
      add(`${p.ref} has no group assignment; available groups: ${docGroups?.join(', ') ?? '(SUBSYSTEMS.md absent)'}`);
    } else if (
      docGroups &&
      !docGroups.some((g) => groupMatchesHeading(g, p.group))
    ) {
      add(`${p.ref} names group "${p.group}", which is not a SUBSYSTEMS.md heading; available: ${docGroups.join(', ')}`);
    }
  }

  if (findings.length) return { ok: false, findings, validated: null };
  return { ok: true, findings: [], validated: { intent, symbols, docGroups, warnings } };
}

export function formatIrFindings(findings: IrFinding[]): string {
  return [
    `intent validation: ${findings.length} finding(s) to reconcile:`,
    ...findings.map((f, i) => `  ${i + 1}. ${f.detail}`),
  ].join('\n');
}
```