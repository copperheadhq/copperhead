/**
 * Pure Parts Manifest data model and passive expansion definitions (Issue #459).
 *
 * Declarative manifest authored by the agent in stage 3 (parts.intent.json).
 * Completely pure: zero filesystem I/O, zero network, zero side effects.
 */

import { looksLikeDescription } from '../draft/ir.js';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = 'parts.intent.json';

export interface PartEntry {
  ref: string;
  value: string;
  package?: string;
  libId?: string;
  footprint?: string;
  mpn?: string;
  group?: string;
  rationale?: string;
  offBoard?: boolean;
  verified?: boolean;
}

export interface SubstitutionEntry {
  ref: string;
  wanted: string;
  chosen: string;
  reason: string;
}

export interface PartsManifest {
  version: number;
  parts: PartEntry[];
  substitutions?: SubstitutionEntry[];
}

export interface ExpandedPart {
  ref: string;
  value: string;
  package?: string;
  libId: string;
  footprint: string;
  mpn: string;
  group: string;
  rationale: string;
  offBoard: boolean;
  verified: boolean;
}

export interface ManifestFinding {
  ref?: string;
  field?: string;
  detail: string;
}

export interface PassiveMapping {
  libId: string;
  footprint: string;
}

export const PASSIVE_PREFIXES = new Set(['R', 'C', 'L', 'D', 'LED', 'CP']);

export const PASSIVE_TABLE: Record<string, Record<string, PassiveMapping>> = {
  R: {
    '0402': { libId: 'Device:R', footprint: 'Resistor_SMD:R_0402_1005Metric' },
    '0603': { libId: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric' },
    '0805': { libId: 'Device:R', footprint: 'Resistor_SMD:R_0805_2012Metric' },
    '1206': { libId: 'Device:R', footprint: 'Resistor_SMD:R_1206_3216Metric' },
    '1210': { libId: 'Device:R', footprint: 'Resistor_SMD:R_1210_3225Metric' },
  },
  C: {
    '0402': { libId: 'Device:C', footprint: 'Capacitor_SMD:C_0402_1005Metric' },
    '0603': { libId: 'Device:C', footprint: 'Capacitor_SMD:C_0603_1608Metric' },
    '0805': { libId: 'Device:C', footprint: 'Capacitor_SMD:C_0805_2012Metric' },
    '1206': { libId: 'Device:C', footprint: 'Capacitor_SMD:C_1206_3216Metric' },
    '1210': { libId: 'Device:C', footprint: 'Capacitor_SMD:C_1210_3225Metric' },
  },
  CP: {
    '0603': { libId: 'Device:C_Polarized', footprint: 'Capacitor_SMD:C_0603_1608Metric' },
    '0805': { libId: 'Device:C_Polarized', footprint: 'Capacitor_SMD:C_0805_2012Metric' },
    '1206': { libId: 'Device:C_Polarized', footprint: 'Capacitor_SMD:C_1206_3216Metric' },
    '1210': { libId: 'Device:C_Polarized', footprint: 'Capacitor_SMD:C_1210_3225Metric' },
  },
  L: {
    '0402': { libId: 'Device:L', footprint: 'Inductor_SMD:L_0402_1005Metric' },
    '0603': { libId: 'Device:L', footprint: 'Inductor_SMD:L_0603_1608Metric' },
    '0805': { libId: 'Device:L', footprint: 'Inductor_SMD:L_0805_2012Metric' },
    '1206': { libId: 'Device:L', footprint: 'Inductor_SMD:L_1206_3216Metric' },
  },
  D: {
    'SOD-123': { libId: 'Device:D', footprint: 'Diode_SMD:D_SOD-123' },
    'SOD-323': { libId: 'Device:D', footprint: 'Diode_SMD:D_SOD-323' },
    'SOD-523': { libId: 'Device:D', footprint: 'Diode_SMD:D_SOD-523' },
    '0603': { libId: 'Device:D', footprint: 'Diode_SMD:D_0603_1608Metric' },
  },
  LED: {
    '0603': { libId: 'Device:LED', footprint: 'LED_SMD:LED_0603_1608Metric' },
    '0805': { libId: 'Device:LED', footprint: 'LED_SMD:LED_0805_2012Metric' },
    '1206': { libId: 'Device:LED', footprint: 'LED_SMD:LED_1206_3216Metric' },
  },
};

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function getRefPrefix(ref: string): string {
  const match = /^[A-Za-z]+/.exec(ref);
  return match ? match[0].toUpperCase() : '';
}

const refCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export function compareRefdes(a: string, b: string): number {
  return refCollator.compare(a, b);
}

/**
 * Pure parser for parts.intent.json.
 * Validates JSON structure, version, and field types without performing I/O.
 */
export function parsePartsManifest(rawInput: unknown): {
  manifest: PartsManifest | null;
  findings: ManifestFinding[];
} {
  const findings: ManifestFinding[] = [];
  const add = (detail: string, ref?: string, field?: string): void => {
    findings.push({ ref, field, detail });
  };

  let parsed: unknown;
  if (typeof rawInput === 'string') {
    if (rawInput.length > 5_000_000) {
      add('manifest input exceeds maximum size limit (5MB)');
      return { manifest: null, findings };
    }
    try {
      parsed = JSON.parse(rawInput);
    } catch (e) {
      add(`manifest is not valid JSON: ${(e as Error).message}`);
      return { manifest: null, findings };
    }
  } else if (rawInput !== null && typeof rawInput === 'object') {
    parsed = rawInput;
  } else {
    add('manifest must be a JSON object');
    return { manifest: null, findings };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    add('manifest must be a JSON object');
    return { manifest: null, findings };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.version !== MANIFEST_VERSION) {
    add(
      `unsupported manifest version ${JSON.stringify(obj.version)}; expected version ${MANIFEST_VERSION}`,
      undefined,
      'version',
    );
  }

  if (!Array.isArray(obj.parts)) {
    add('manifest must contain a "parts" array', undefined, 'parts');
    return { manifest: null, findings };
  }

  if (obj.parts.length === 0) {
    add('manifest "parts" array cannot be empty', undefined, 'parts');
  }

  return {
    manifest: findings.length === 0 ? (parsed as PartsManifest) : null,
    findings,
  };
}

/**
 * Pure expansion and normalization of parts.
 * Checks refdes uniqueness, passive package expansion, off-board syntax, and prose heuristics.
 */
export function expandAndNormalizeParts(parts: PartEntry[]): {
  expanded: ExpandedPart[];
  findings: ManifestFinding[];
} {
  const findings: ManifestFinding[] = [];
  const expanded: ExpandedPart[] = [];
  const add = (detail: string, ref?: string, field?: string): void => {
    findings.push({ ref, field, detail });
  };

  const seenRefs = new Map<string, string>(); // upper -> original

  for (let idx = 0; idx < parts.length; idx++) {
    const rawPart = parts[idx] as unknown as Record<string, unknown>;
    if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
      add(`part at index ${idx} must be an object`);
      continue;
    }

    const ref = rawPart.ref;
    if (typeof ref !== 'string' || !ref.trim()) {
      add(`part at index ${idx} is missing a string "ref" field`, undefined, 'ref');
      continue;
    }

    const cleanRef = ref.trim();
    if (FORBIDDEN_OBJECT_KEYS.has(cleanRef)) {
      add(`refdes "${cleanRef}" uses a reserved property name`, cleanRef, 'ref');
      continue;
    }

    // Grouped refdes check (e.g. R1-R4, C1,C2, SW1..SW4)
    if (/[-,\s\.\/]/.test(cleanRef) || cleanRef.includes('..')) {
      add(
        `grouped or compound refdes "${cleanRef}" is not permitted; each part must have its own row`,
        cleanRef,
        'ref',
      );
      continue;
    }

    // Refdes identifier syntax
    if (!/^[A-Za-z]+[0-9]+[A-Za-z]?$/.test(cleanRef)) {
      add(
        `refdes "${cleanRef}" has an invalid identifier format (expected e.g. R1, C12, U3, SW2A)`,
        cleanRef,
        'ref',
      );
      continue;
    }

    // Uniqueness and case-collision check
    const upperRef = cleanRef.toUpperCase();
    if (seenRefs.has(upperRef)) {
      const prior = seenRefs.get(upperRef);
      add(
        prior === cleanRef
          ? `duplicate refdes "${cleanRef}"`
          : `duplicate refdes "${cleanRef}" collides case-insensitively with "${prior}"`,
        cleanRef,
        'ref',
      );
      continue;
    }
    seenRefs.set(upperRef, cleanRef);

    // Value check
    const value = rawPart.value;
    if (typeof value !== 'string' || !value.trim()) {
      add(`${cleanRef}: missing required string "value" field`, cleanRef, 'value');
      continue;
    }
    const cleanValue = value.trim();
    if (looksLikeDescription(cleanValue)) {
      add(
        `${cleanRef}: value "${cleanValue}" looks like a prose description rather than a component value; put prose in rationale`,
        cleanRef,
        'value',
      );
    }

    // Off-board check
    const offBoard = rawPart.offBoard === true;
    if (rawPart.offBoard !== undefined && typeof rawPart.offBoard !== 'boolean') {
      add(`${cleanRef}: "offBoard" must be a boolean`, cleanRef, 'offBoard');
    }

    const rationale = typeof rawPart.rationale === 'string' ? rawPart.rationale.trim() : '';
    if (offBoard && !rationale) {
      add(
        `${cleanRef}: off-board parts must provide a "rationale" explaining their physical connection (e.g. "bare leads to J1", "chassis mount")`,
        cleanRef,
        'rationale',
      );
    }

    // Commercial verification authority rule:
    // A model cannot manufacture verified: true. Verification of commercial MPNs
    // is established only by human review. The model writing verified: true is rejected.
    if (rawPart.verified === true) {
      add(
        `${cleanRef}: model cannot assert 'verified: true'; commercial part verification requires independent human review`,
        cleanRef,
        'verified',
      );
    }

    const group = typeof rawPart.group === 'string' ? rawPart.group.trim() : '';
    const pkg = typeof rawPart.package === 'string' ? rawPart.package.trim() : undefined;
    const prefix = getRefPrefix(cleanRef);
    let resolvedLibId = typeof rawPart.libId === 'string' ? rawPart.libId.trim() : '';
    let resolvedFootprint = typeof rawPart.footprint === 'string' ? rawPart.footprint.trim() : '';
    let resolvedMpn = typeof rawPart.mpn === 'string' ? rawPart.mpn.trim() : '';

    if (offBoard) {
      // Off-board components cannot declare a PCB package or PCB footprint
      if (pkg) {
        add(`${cleanRef}: off-board part cannot specify a PCB "package"`, cleanRef, 'package');
      }
      if (resolvedFootprint && resolvedFootprint !== '(off-board)' && resolvedFootprint !== 'none') {
        add(`${cleanRef}: off-board part cannot specify a PCB "footprint"`, cleanRef, 'footprint');
      }
      resolvedFootprint = '(off-board)';
      if (!resolvedLibId) resolvedLibId = '(off-board)';
    } else if (pkg) {
      // Passive package expansion
      if (!PASSIVE_PREFIXES.has(prefix)) {
        add(
          `${cleanRef}: part prefix "${prefix}" is not a recognized passive prefix (${[...PASSIVE_PREFIXES].join(', ')}); specify explicit libId and footprint instead of "package"`,
          cleanRef,
          'package',
        );
      } else {
        const table = PASSIVE_TABLE[prefix];
        const mapping = table ? table[pkg] : undefined;
        if (!mapping) {
          const supported = table ? Object.keys(table).join(', ') : 'none';
          add(
            `${cleanRef}: unsupported passive package "${pkg}" for prefix "${prefix}"; supported packages: ${supported}`,
            cleanRef,
            'package',
          );
        } else {
          if (resolvedLibId && resolvedLibId !== mapping.libId) {
            add(
              `${cleanRef}: explicit libId "${resolvedLibId}" conflicts with package "${pkg}" expansion "${mapping.libId}"`,
              cleanRef,
              'libId',
            );
          } else {
            resolvedLibId = mapping.libId;
          }
          if (resolvedFootprint && resolvedFootprint !== mapping.footprint) {
            add(
              `${cleanRef}: explicit footprint "${resolvedFootprint}" conflicts with package "${pkg}" expansion "${mapping.footprint}"`,
              cleanRef,
              'footprint',
            );
          } else {
            resolvedFootprint = mapping.footprint;
          }
        }
      }
    } else {
      // Active non-offboard part: requires libId, footprint, and mpn
      if (!resolvedLibId) {
        add(`${cleanRef}: active part requires "libId" (or standard passive "package")`, cleanRef, 'libId');
      }
      if (!resolvedFootprint) {
        add(`${cleanRef}: active part requires "footprint" (or standard passive "package")`, cleanRef, 'footprint');
      }
      if (!resolvedMpn && !PASSIVE_PREFIXES.has(prefix)) {
        add(`${cleanRef}: non-passive active component requires an "mpn"`, cleanRef, 'mpn');
      }
    }

    expanded.push({
      ref: cleanRef,
      value: cleanValue,
      package: pkg,
      libId: resolvedLibId,
      footprint: resolvedFootprint,
      mpn: resolvedMpn,
      group,
      rationale,
      offBoard,
      verified: false, // Model-introduced MPNs always start unverified
    });
  }

  return { expanded, findings };
}
