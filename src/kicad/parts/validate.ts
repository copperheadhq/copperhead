/**
 * The parts-manifest validator (design D2): one function behind `draft_bom`,
 * the stage-3 completion predicate, the finish-time stage gate and the
 * contract-gap message, so none of them can disagree. Pure over injected
 * resolvers (symbols, footprints, the SUBSYSTEMS.md text) so it runs against
 * fixture libraries in tests and makes no network call anywhere.
 *
 * Every rule the stage-3 prompt used to state is a finding here that names
 * the refdes and the fix. A library the user has to install is not a finding
 * (the model cannot act on it): it is returned as `stops`, the same split the
 * pre-schematic footprint stop makes (#314).
 */

import { SymbolResolutionError, type ResolvedSymbol } from '../draft/symsource.js';
import { looksLikeDescription, unitPlacementFinding } from '../draft/ir.js';
import type { FootprintResolver, MissingFootprint } from '../footprints.js';
import { checkPinsAgainstPads } from './pads.js';
import { isPassivePrefix, knownPackages, passiveDefault } from './passives.js';
import { refPrefix, type ManifestFinding, type PartsManifest } from './manifest.js';
import { resolveParts, type ResolvedPart as BaseResolvedPart } from './resolve.js';

export { resolveParts } from './resolve.js';

export interface SymbolResolverLike {
  resolve(libId: string): Promise<ResolvedSymbol>;
}

export interface ValidateOptions {
  symbols: SymbolResolverLike;
  footprints: FootprintResolver;
  /** SUBSYSTEMS.md text, or null when the doc is absent (groups then go unchecked). */
  subsystemsMd?: string | null;
  /** Findings reported per call; the rest become an "…and N more" count. */
  maxFindings?: number;
}

/** A manifest entry with its derived ids filled in, plus the resolved symbol when `libId` resolved. */
export interface ResolvedPart extends BaseResolvedPart {
  symbol?: ResolvedSymbol;
}

export interface ManifestValidation {
  /** No findings. `stops` may still be non-empty: that is the user's problem, not the model's. */
  ok: boolean;
  findings: ManifestFinding[];
  /** Findings beyond `maxFindings`, not listed. */
  omitted: number;
  /** Noted, never refused. */
  warnings: string[];
  /** Footprints whose library is not installed anywhere: the AC-15.32 stop. */
  stops: MissingFootprint[];
  parts: ResolvedPart[];
  /** SUBSYSTEMS.md headings (in order) with no part, or null when the doc is absent. */
  emptyGroups: string[] | null;
}

/** `## Heading` names from a markdown document, in order. */
export function subsystemHeadings(md: string | null | undefined): string[] | null {
  if (!md) return null;
  const names = [...md.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) => m[1]!.trim()).filter(Boolean);
  return names.length ? names : null;
}

/**
 * A miss the model can fix in the manifest: a mistyped or invented name, a
 * non-id cell, or a library nickname whose footprint is installed under
 * another library by that exact name. A library that is simply not installed
 * is the user's to install.
 */
export const modelFixableMiss = (m: MissingFootprint): boolean => m.why !== 'no-library' || (m.near.length > 0 && !m.fuzzy);

export async function validatePartsManifest(manifest: PartsManifest, opts: ValidateOptions): Promise<ManifestValidation> {
  const findings: ManifestFinding[] = [];
  const warnings: string[] = [];
  const stops: MissingFootprint[] = [];
  const parts: ResolvedPart[] = [];
  const add = (ref: string | undefined, detail: string): void => {
    findings.push(ref ? { ref, detail } : { detail });
  };
  const groups = subsystemHeadings(opts.subsystemsMd);
  const groupKey = (g: string): string => g.toLowerCase();
  const usedGroups = new Set<string>();

  const derived = resolveParts(manifest);
  for (const [i, e] of manifest.parts.entries()) {
    const prefix = refPrefix(e.ref);
    const passive = isPassivePrefix(prefix);
    const offBoard = e.offBoard === true;
    const part: ResolvedPart = { ...derived[i]! };
    parts.push(part);

    // value: drawn on the sheet as the Value field, so prose there collides
    // with neighbours and fails legibility (same rule as the IR cross-check)
    if (!e.value) add(e.ref, `${e.ref}: "value" is empty; give the component value ("4.7uF", "STM32F103C8T6")`);
    else if (looksLikeDescription(e.value)) {
      add(e.ref, `${e.ref}: "value" reads as a description ("${e.value}"); keep the component value there and move the prose to "rationale"`);
    }

    // group: every entry names one SUBSYSTEMS.md heading
    if (!e.group) {
      add(e.ref, `${e.ref}: no "group"; name the SUBSYSTEMS.md heading this part belongs to${groups ? ` (available: ${groups.join(', ')})` : ''}`);
    } else if (groups && !groups.some((g) => groupKey(g) === groupKey(e.group!))) {
      add(e.ref, `${e.ref}: group "${e.group}" is not a SUBSYSTEMS.md heading; available: ${groups.join(', ')}`);
    } else if (e.group) usedGroups.add(groupKey(e.group));

    if (offBoard) {
      // no symbol, footprint or pad on the board to check
      if (e.noPart) add(e.ref, `${e.ref}: "offBoard" and "noPart" cannot both be true; off-board is a part you buy that is not on the board, no-part is a board feature you do not buy`);
      continue;
    }

    // ids: a passive's came from its package (resolveParts); an active part declares both
    if (passive && e.package && (!e.libId || !e.footprint) && !passiveDefault(prefix, e.package)) {
      add(e.ref, `${e.ref}: package "${e.package}" is not known for a ${prefix} part (known: ${knownPackages(prefix).join(', ')}); give "libId" and "footprint" explicitly instead`);
      continue;
    }
    if (!part.libId) {
      add(e.ref, passive
        ? `${e.ref}: give "package" (${knownPackages(prefix).slice(0, 6).join(', ')}, …) or an explicit "libId" and "footprint"`
        : `${e.ref}: no "libId"; give the exact installed lib_id (Lib:Name) of its symbol — search_symbols finds it by part name`);
    }
    if (!part.footprint) {
      add(e.ref, passive
        ? `${e.ref}: no "footprint"; give "package" or an explicit installed footprint id`
        : `${e.ref}: no "footprint"; give the exact installed footprint id (Lib:Name), or set "offBoard": true for a part with no place on the board`);
    }
    if (e.noPart && e.mpn) {
      add(e.ref, `${e.ref}: "noPart" is true but "mpn" is ${JSON.stringify(e.mpn)}; a board feature has no part number — drop "mpn", or drop "noPart" if this is a part you buy`);
    } else if (!passive && !e.mpn && !e.noPart) {
      add(e.ref, `${e.ref}: no "mpn"; every active part needs a manufacturer part number (it is rendered UNVERIFIED until "verified": true). A board feature with nothing to buy (a mounting hole, a fiducial, a pad test point) sets "noPart": true instead`);
    }

    // symbol: exists, drawable
    if (part.libId) {
      try {
        const sym = await opts.symbols.resolve(part.libId);
        const unit = unitPlacementFinding(part.libId, sym);
        if (unit) add(e.ref, `${e.ref}: ${unit}`);
        else part.symbol = sym;
      } catch (err) {
        if (err instanceof SymbolResolutionError) add(e.ref, `${e.ref}: ${err.message}`);
        else throw err;
      }
    }

    // footprint: resolves as the board will; an uninstalled library is the user's stop
    let footprintOk = false;
    if (part.footprint) {
      const r = await opts.footprints.resolve(part.footprint);
      if (r.ok) footprintOk = true;
      else {
        const miss: MissingFootprint = { ref: e.ref, footprint: part.footprint, why: r.why, near: r.near, ...(r.fuzzy ? { fuzzy: true } : {}) };
        if (modelFixableMiss(miss)) {
          const lib = part.footprint.includes(':') ? part.footprint.slice(0, part.footprint.indexOf(':')) : '';
          const why = r.why === 'bad-id' ? 'is not a Lib:Name footprint id' : r.why === 'no-library' ? `names a library "${lib}" that is not installed` : `is not in library "${lib}"`;
          add(e.ref, `${e.ref}: footprint "${part.footprint}" ${why}${r.near.length ? `; ${r.fuzzy ? 'closest installed' : 'installed'}: ${r.near.join(', ')}` : ''}`);
        } else stops.push(miss);
      }
    }

    // pins against pads, only once both halves resolved
    if (part.symbol && footprintOk && part.footprint) {
      const pads = await checkPinsAgainstPads(
        { ref: e.ref, footprint: part.footprint, symbolPins: new Set(part.symbol.pins.map((p) => p.number)), where: 'change "libId" or "footprint" in parts.intent.json' },
        opts.footprints,
      );
      if (pads.finding) add(e.ref, pads.finding);
      if (pads.warning) warnings.push(pads.warning);
    }
  }

  // substitutions: point at a real entry, and the entry carries the chosen part
  const byRef = new Map(parts.map((p) => [p.ref, p]));
  for (const s of manifest.substitutions ?? []) {
    const p = byRef.get(s.ref);
    if (!p) {
      add(s.ref, `substitution for ${s.ref}: no part entry has that refdes`);
      continue;
    }
    const carries = [p.value, p.mpn, p.libId].filter((v): v is string => !!v).map((v) => v.toLowerCase());
    const chosen = s.chosen.toLowerCase();
    if (!carries.some((v) => v === chosen || v.includes(chosen) || chosen.includes(v))) {
      add(s.ref, `substitution for ${s.ref}: "chosen" is ${JSON.stringify(s.chosen)} but the entry carries value ${JSON.stringify(p.value)}${p.mpn ? `, mpn ${JSON.stringify(p.mpn)}` : ''}; they must agree`);
    }
  }

  // coverage the other way: a heading with no part is reported, not refused
  // (an "Overview" heading is legitimately empty; a large manifest written per
  // subsystem is legitimately incomplete between calls)
  const emptyGroups = groups ? groups.filter((g) => !usedGroups.has(groupKey(g))) : null;
  if (emptyGroups?.length) warnings.push(`SUBSYSTEMS.md heading(s) with no part yet: ${emptyGroups.join(', ')}`);

  const cap = opts.maxFindings ?? 40;
  const omitted = Math.max(0, findings.length - cap);
  return { ok: findings.length === 0, findings: findings.slice(0, cap), omitted, warnings, stops, parts, emptyGroups };
}

/** One line per finding, grouped as given, with the overflow count. */
export function formatManifestFindings(v: Pick<ManifestValidation, 'findings' | 'omitted' | 'stops' | 'warnings'>): string {
  const lines: string[] = [];
  if (v.findings.length) {
    lines.push(`${v.findings.length + v.omitted} finding(s):`);
    for (const f of v.findings) lines.push(`  - ${f.detail}`);
    if (v.omitted) lines.push(`  …and ${v.omitted} more; fix these and run draft_bom again`);
  }
  if (v.stops.length) {
    lines.push(`${v.stops.length} footprint(s) need a library the user must install (not fixable from the manifest):`);
    for (const m of v.stops) lines.push(`  - ${m.ref}: ${m.footprint}${m.near.length ? ` (closest installed: ${m.near.join(', ')})` : ''}`);
  }
  if (v.warnings.length) {
    lines.push('notes:');
    for (const w of v.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}
