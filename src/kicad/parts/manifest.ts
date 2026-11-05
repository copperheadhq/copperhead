/**
 * The parts manifest (`docs/parts.intent.json`): the structured artifact the
 * part-selection stage authors instead of BOM.md (change
 * structured-part-selection, design D1). One entry per refdes. BOM.md is
 * rendered from it (`render.ts`), the stage gate is its validator
 * (`validate.ts`), and stage 4 reads its verified lib_ids and footprints.
 *
 * Shape parsing lives here, pure and synchronous: a manifest that is not even
 * the right shape comes back as findings the model can act on, never as a
 * TypeError from deeper code.
 */

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = 'parts.intent.json';

export interface PartEntry {
  ref: string;
  /** The component value as drawn on the sheet (`4.7uF`, `STM32F103C8T6`); never prose. */
  value: string;
  /** SUBSYSTEMS.md heading this part belongs to. */
  group?: string;
  /** Exact installed lib_id. Required for an active part; derived for a passive given `package`. */
  libId?: string;
  /** Exact installed footprint id (`Lib:Name`). Required unless off-board; derived for a passive given `package`. */
  footprint?: string;
  /** Passive package shorthand (`0603`, `SOD-123`, `3mm`): expanded by the passive table. */
  package?: string;
  mpn?: string;
  rationale?: string;
  /** False (the default) renders the MPN with the UNVERIFIED flag. */
  verified?: boolean;
  /** A BOM line with no place on the board (a battery with leads, a cable): exempt from symbol/footprint/pad checks. */
  offBoard?: boolean;
  /** A board feature with nothing to buy (a mounting hole, a fiducial, a pad test point): on the board, exempt from the MPN rule. */
  noPart?: boolean;
}

export interface Substitution {
  ref: string;
  /** The part the design asked for. */
  wanted: string;
  /** The part the entry now carries (its value, MPN or lib_id). */
  chosen: string;
  reason: string;
}

export interface PartsManifest {
  version: number;
  parts: PartEntry[];
  substitutions?: Substitution[];
}

export interface ManifestFinding {
  /** The refdes the finding concerns, when it concerns one. */
  ref?: string;
  detail: string;
}

/** `U1`, `R12`, `R12A`, `BT1`, `J3`: letters, digits, an optional letter suffix. */
const REFDES = /^[A-Za-z]+\d+[A-Za-z]?$/;
/** `C5-C8`, `SW3..SW16`, `R1, R2`, `R1/R2`: several parts in one cell. */
const GROUPED = /[-–,/]|\.\./;

const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';
const optBool = (v: unknown): v is boolean | undefined => v === undefined || typeof v === 'boolean';

/**
 * Parse manifest JSON into a typed manifest, or into shape findings. A
 * manifest with any shape finding is returned as null: a half-typed manifest
 * would only move the TypeError downstream.
 */
export function parseManifest(json: string): { manifest: PartsManifest | null; findings: ManifestFinding[] } {
  const findings: ManifestFinding[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { manifest: null, findings: [{ detail: `parts manifest is not valid JSON (${(e as Error).message})` }] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: null, findings: [{ detail: 'parts manifest must be a JSON object with "version" and "parts"' }] };
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== MANIFEST_VERSION) {
    findings.push({ detail: `unsupported manifest version ${JSON.stringify(o.version)}; this validator supports version ${MANIFEST_VERSION}` });
  }
  if (!Array.isArray(o.parts)) {
    findings.push({ detail: '"parts" must be an array of part entries' });
    return { manifest: null, findings };
  }
  const parts: PartEntry[] = [];
  const seen = new Set<string>();
  o.parts.forEach((p, i) => {
    const label = (p as { ref?: unknown })?.ref;
    const where = isStr(label) && label ? label : `parts[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      findings.push({ detail: `${where}: a part entry must be an object` });
      return;
    }
    const e = p as Record<string, unknown>;
    if (!isStr(e.ref) || !e.ref.trim()) {
      findings.push({ detail: `${where}: "ref" must be a non-empty string` });
      return;
    }
    const ref = e.ref.trim();
    if (GROUPED.test(ref) || /\s/.test(ref)) {
      findings.push({ ref, detail: `${ref}: one entry per refdes — a grouped refdes ("C5-C8", "R1, R2") cannot be matched by the schematic stage; split it into one entry each` });
      return;
    }
    if (!REFDES.test(ref)) {
      findings.push({ ref, detail: `${ref}: not a refdes (letters then digits, e.g. U1, R12, BT1)` });
      return;
    }
    if (seen.has(ref)) {
      findings.push({ ref, detail: `duplicate refdes ${ref}` });
      return;
    }
    if (!isStr(e.value)) {
      findings.push({ ref, detail: `${ref}: "value" must be a string` });
      return;
    }
    for (const k of ['group', 'libId', 'footprint', 'package', 'mpn', 'rationale'] as const) {
      if (!optStr(e[k])) {
        findings.push({ ref, detail: `${ref}: "${k}" must be a string, got ${JSON.stringify(e[k])}` });
        return;
      }
    }
    for (const k of ['verified', 'offBoard', 'noPart'] as const) {
      if (!optBool(e[k])) {
        findings.push({ ref, detail: `${ref}: "${k}" must be true or false, got ${JSON.stringify(e[k])}` });
        return;
      }
    }
    seen.add(ref);
    const entry: PartEntry = { ref, value: e.value.trim() };
    for (const k of ['group', 'libId', 'footprint', 'package', 'mpn', 'rationale'] as const) {
      const v = e[k];
      if (isStr(v) && v.trim()) entry[k] = v.trim();
    }
    if (e.verified !== undefined) entry.verified = e.verified as boolean;
    if (e.offBoard !== undefined) entry.offBoard = e.offBoard as boolean;
    if (e.noPart !== undefined) entry.noPart = e.noPart as boolean;
    parts.push(entry);
  });
  let substitutions: Substitution[] | undefined;
  if (o.substitutions !== undefined) {
    if (!Array.isArray(o.substitutions)) {
      findings.push({ detail: '"substitutions" must be an array of {ref, wanted, chosen, reason}' });
    } else {
      substitutions = [];
      o.substitutions.forEach((s, i) => {
        const e = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
        const ref = isStr(e.ref) ? e.ref.trim() : '';
        const where = ref || `substitutions[${i}]`;
        for (const k of ['ref', 'wanted', 'chosen', 'reason'] as const) {
          if (!isStr(e[k]) || !e[k].trim()) {
            findings.push({ ...(ref ? { ref } : {}), detail: `${where}: substitution needs a non-empty "${k}"${k === 'reason' ? ' (why the wanted part could not be used)' : ''}` });
            return;
          }
        }
        substitutions!.push({ ref, wanted: (e.wanted as string).trim(), chosen: (e.chosen as string).trim(), reason: (e.reason as string).trim() });
      });
    }
  }
  if (findings.length) return { manifest: null, findings };
  return { manifest: { version: MANIFEST_VERSION, parts, ...(substitutions ? { substitutions } : {}) }, findings };
}

/** Refdes prefix (`R12A` → `R`, `LED3` → `LED`). */
export function refPrefix(ref: string): string {
  return /^[A-Za-z]+/.exec(ref)?.[0]?.toUpperCase() ?? '';
}
