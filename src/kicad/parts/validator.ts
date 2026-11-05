/**
 * Semantic validator for parts.intent.json (Issue #459).
 *
 * Validates manifest structure, passive expansions, symbol library resolution,
 * footprint resolution, pin-to-pad coverage, and subsystem coverage.
 * Pure interface: accepts injected resolvers so unit tests run hermetically.
 */

import {
  parsePartsManifest,
  expandAndNormalizeParts,
  type ExpandedPart,
  type SubstitutionEntry,
  type ManifestFinding,
} from './manifest.js';
import {
  readFootprintPads,
  exposedPads,
  isMechanicalPad,
  formatPadMismatch,
  type FootprintResolver,
} from '../footprints.js';
import {
  resolveLibrarySymbol,
  symbolSearchDirs,
  type LibPin,
} from '../symlib.js';

export interface ValidationFinding extends ManifestFinding {}

export interface ValidationResult {
  ok: boolean;
  findings: ValidationFinding[];
  warnings: string[];
  expandedParts: ExpandedPart[];
  substitutions: SubstitutionEntry[];
}

export interface ValidatorOptions {
  subsystemsHeadings?: string[] | null;
  footprints?: FootprintResolver;
  symbolDirs?: string[];
  /** Allow skipping slow library filesystem lookups in unit tests */
  skipLibraryResolution?: boolean;
  /** Allow skipping subsystem coverage in isolated unit tests */
  skipSubsystemsCoverage?: boolean;
}

/**
 * Validate a raw JSON string or object as a PartsManifest.
 * Pure and deterministic: does not write to the filesystem.
 */
export async function validatePartsManifest(
  rawInput: unknown,
  options: ValidatorOptions = {},
): Promise<ValidationResult> {
  const findings: ValidationFinding[] = [];
  const warnings: string[] = [];
  const substitutions: SubstitutionEntry[] = [];

  const add = (detail: string, ref?: string, field?: string): void => {
    findings.push({ ref, field, detail });
  };

  // 1. Pure parse
  const parseRes = parsePartsManifest(rawInput);
  findings.push(...parseRes.findings);
  if (!parseRes.manifest) {
    return { ok: false, findings, warnings, expandedParts: [], substitutions };
  }

  const manifest = parseRes.manifest;

  // 2. Pure normalize and expand parts
  const expandRes = expandAndNormalizeParts(manifest.parts);
  findings.push(...expandRes.findings);
  const expandedParts = expandRes.expanded;

  // 3. Subsystem headings coverage
  if (!options.skipSubsystemsCoverage) {
    if (!options.subsystemsHeadings || options.subsystemsHeadings.length === 0) {
      add('missing or empty subsystem definitions; manifest parts require valid SUBSYSTEMS.md headings', undefined, 'group');
    } else {
      const knownGroups = new Map(options.subsystemsHeadings.map((h) => [h.toLowerCase(), h]));
      const assignedGroups = new Set<string>();

      for (const p of expandedParts) {
        if (!p.group) {
          add(
            `${p.ref}: missing subsystem "group" assignment; available headings: ${options.subsystemsHeadings.join(', ')}`,
            p.ref,
            'group',
          );
        } else if (!knownGroups.has(p.group.toLowerCase())) {
          add(
            `${p.ref}: group "${p.group}" does not match any SUBSYSTEMS.md heading; available: ${options.subsystemsHeadings.join(', ')}`,
            p.ref,
            'group',
          );
        } else {
          assignedGroups.add(p.group.toLowerCase());
        }
      }

      for (const heading of options.subsystemsHeadings) {
        if (!assignedGroups.has(heading.toLowerCase())) {
          add(`subsystem heading "${heading}" has no parts assigned in the manifest`, undefined, 'group');
        }
      }
    }
  }

  // 4. Substitutions validation
  if (manifest.substitutions !== undefined) {
    if (!Array.isArray(manifest.substitutions)) {
      add('"substitutions" must be an array of substitution objects', undefined, 'substitutions');
    } else {
      const partRefs = new Set(expandedParts.map((p) => p.ref));
      const partsByRef = new Map(expandedParts.map((p) => [p.ref, p]));
      const seenSubRefs = new Set<string>();

      for (let sIdx = 0; sIdx < manifest.substitutions.length; sIdx++) {
        const sub = manifest.substitutions[sIdx] as unknown as Record<string, unknown>;
        if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
          add(`substitution at index ${sIdx} must be an object`, undefined, 'substitutions');
          continue;
        }
        const sRef = typeof sub.ref === 'string' ? sub.ref.trim() : '';
        const wanted = typeof sub.wanted === 'string' ? sub.wanted.trim() : '';
        const chosen = typeof sub.chosen === 'string' ? sub.chosen.trim() : '';
        const reason = typeof sub.reason === 'string' ? sub.reason.trim() : '';

        if (!sRef || !wanted || !chosen || !reason) {
          add(
            `substitution at index ${sIdx} requires non-empty "ref", "wanted", "chosen", and "reason" fields`,
            sRef || undefined,
            'substitutions',
          );
          continue;
        }
        if (!partRefs.has(sRef)) {
          add(`substitution names ref "${sRef}", which is not present in parts list`, sRef, 'substitutions');
          continue;
        }
        if (seenSubRefs.has(sRef)) {
          add(
            `duplicate substitution for refdes "${sRef}"; each refdes may have at most one substitution record`,
            sRef,
            'substitutions',
          );
          continue;
        }
        seenSubRefs.add(sRef);

        const targetPart = partsByRef.get(sRef);
        if (targetPart) {
          if (!targetPart.mpn) {
            add(
              `${sRef}: substitution specifies chosen MPN "${chosen}", but canonical part has no "mpn" declared; set canonical part "mpn" to "${chosen}" to represent the selected procurement identity`,
              sRef,
              'mpn',
            );
          } else if (targetPart.mpn !== chosen) {
            add(
              `${sRef}: canonical part mpn "${targetPart.mpn}" conflicts with substitution chosen MPN "${chosen}"`,
              sRef,
              'mpn',
            );
          }
        }

        substitutions.push({ ref: sRef, wanted, chosen, reason });
      }
    }
  }

  // 5. KiCad Library Existence & Pin/Pad checks
  if (!options.skipLibraryResolution) {
    const symbolDirs = options.symbolDirs ?? (await symbolSearchDirs());
    const footprints = options.footprints;

    // Per-call memoization to avoid redundant disk I/O within a single validation pass
    const symbolPinsCache = new Map<string, LibPin[] | null>();
    const footprintFileCache = new Map<string, string | null>();

    for (const p of expandedParts) {
      if (p.offBoard) continue; // Exempt off-board parts from symbol/footprint resolution

      // Symbol resolution
      let symPins: LibPin[] | null = null;
      if (!symbolDirs || symbolDirs.length === 0) {
        add(
          `${p.ref}: symbol "${p.libId}" cannot be verified: no symbol library directories available`,
          p.ref,
          'libId',
        );
      } else if (p.libId) {
        if (symbolPinsCache.has(p.libId)) {
          symPins = symbolPinsCache.get(p.libId)!;
        } else {
          const r = await resolveLibrarySymbol(p.libId, symbolDirs);
          if (r.status === 'ok') {
            symPins = r.pins;
            symbolPinsCache.set(p.libId, symPins);
          } else if (r.status === 'found-elsewhere') {
            symbolPinsCache.set(p.libId, null);
            add(
              `${p.ref}: symbol "${p.libId}" not found in declared library, but installed as: ${r.libIds.join(', ')}`,
              p.ref,
              'libId',
            );
          } else if (r.status === 'no-symbol') {
            symbolPinsCache.set(p.libId, null);
            const close = r.candidates.length ? ` (closest: ${r.candidates.slice(0, 3).join(', ')})` : '';
            add(`${p.ref}: symbol "${p.libId}" does not exist in installed library${close}`, p.ref, 'libId');
          } else {
            symbolPinsCache.set(p.libId, null);
            add(`${p.ref}: library for symbol "${p.libId}" is not installed on this machine`, p.ref, 'libId');
          }
        }
      }

      // Footprint resolution
      let footprintFile: string | null = null;
      if (!footprints) {
        add(
          `${p.ref}: footprint "${p.footprint}" cannot be verified: no footprint resolver available`,
          p.ref,
          'footprint',
        );
      } else if (p.footprint) {
        if (footprintFileCache.has(p.footprint)) {
          footprintFile = footprintFileCache.get(p.footprint)!;
        } else {
          const fRes = await footprints.resolve(p.footprint);
          if (fRes.ok) {
            footprintFile = fRes.file;
            footprintFileCache.set(p.footprint, footprintFile);
          } else {
            footprintFileCache.set(p.footprint, null);
            const near = fRes.near.length ? ` (closest: ${fRes.near.slice(0, 3).join(', ')})` : '';
            add(
              `${p.ref}: footprint "${p.footprint}" does not resolve to an installed footprint${near}`,
              p.ref,
              'footprint',
            );
          }
        }
      }

      // Pin/Pad coverage check
      if (symPins && footprintFile && p.footprint) {
        const byNum = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
        const { numbers: pads, heatsink } = await readFootprintPads(footprintFile);
        const pinNumbers = new Set(symPins.map((pin) => pin.number));
        const missingPads = [...pinNumbers].filter((n) => !pads.has(n)).sort(byNum);

        const exposed = exposedPads(p.footprint, pads, pinNumbers);
        const unpinned = [...pads]
          .filter((n) => !isMechanicalPad(n) && !heatsink.has(n) && !exposed.has(n) && !pinNumbers.has(n))
          .sort(byNum);

        const variant =
          unpinned.length && !missingPads.length ? await footprints!.variantCovering(p.footprint, pinNumbers) : null;
        const mismatch = formatPadMismatch({
          ref: p.ref,
          footprint: p.footprint,
          pins: missingPads,
          pads: [...pads].sort(byNum),
          ...(unpinned.length ? { unpinned } : {}),
        });

        if (missingPads.length || unpinned.length) {
          add(
            `${mismatch}; symbol pins and footprint pads diverge (${variant ? `try variant ${variant}` : 'verify datasheet footprint'})`,
            p.ref,
            'footprint',
          );
        }
      }
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    warnings,
    expandedParts,
    substitutions,
  };
}

export function formatValidationFindings(findings: ValidationFinding[]): string {
  if (findings.length === 0) return 'manifest validation: clean (0 findings)';
  return [
    `manifest validation: ${findings.length} finding(s) to reconcile:`,
    ...findings.map((f, i) => `  ${i + 1}. ${f.detail}`),
  ].join('\n');
}
