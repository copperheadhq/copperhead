import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { PinNet } from '../kicad/sexp.js';

/**
 * Machine-readable constraint registry (SPEC §2.6). Built simultaneously with
 * the docs: every stated/assumed/discovered constraint lands in both in the
 * same tool turn. `affects` drives propagation.
 */
export interface Constraint {
  min?: number;
  max?: number;
  forbidden?: string[];
  refs?: string[];
  value?: string | number;
  source: string;
  affects: string[];
  /**
   * Subset of `affects` whose target artifact (schematic/board/BOM) did not
   * exist when the constraint was recorded. No revisit obligation is open for
   * these; they re-open at the start of the first run where the artifact
   * exists (reopenDeferredAffects), then the marker is removed.
   */
  deferred?: string[];
}

export type ConstraintRegistry = Record<string, Constraint>;

export function constraintsPath(repoRoot: string): string {
  return path.join(repoRoot, '.copperhead', 'constraints.json');
}

export async function loadConstraints(repoRoot: string): Promise<ConstraintRegistry> {
  const p = constraintsPath(repoRoot);
  if (!existsSync(p)) return {};
  return JSON.parse(await readFile(p, 'utf8')) as ConstraintRegistry;
}

export async function saveConstraints(repoRoot: string, registry: ConstraintRegistry): Promise<void> {
  const p = constraintsPath(repoRoot);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

export async function saveConstraint(
  repoRoot: string,
  key: string,
  constraint: Constraint,
): Promise<ConstraintRegistry> {
  const registry = await loadConstraints(repoRoot);
  registry[key] = constraint;
  await saveConstraints(repoRoot, registry);
  return registry;
}

/** The build artifact an `affects` item names, when it clearly names one. */
export type AffectsTarget = 'schematic' | 'board' | 'bom';

/**
 * Items that name a not-yet-built artifact are deferrable; items that name a
 * specific refdes, net, or doc fact return null and open a revisit obligation
 * immediately. Misclassification is cheap in both directions: an unmatched
 * artifact item just costs one ceremonial resolve_affected call (the old
 * behavior for everything), and a deferred item still re-opens later.
 */
export function classifyAffectsTarget(item: string): AffectsTarget | null {
  if (/\b(bom|part[-\s]?selection|mpn)\b/i.test(item)) return 'bom';
  if (/\b(schematic|pinout|pin[-\s]?assign\w*|strapping|netlist)\b/i.test(item)) return 'schematic';
  if (
    /\b(layout|stackup|rout(?:e|es|ing)?|vias?|pours?|keepouts?|zones?|copper|traces?|board|pcb|mounting|thermal|silkscreen|assembly|current[-\s]?carrying)\b/i.test(
      item,
    )
  )
    return 'board';
  return null;
}

interface ArtifactConfig {
  schematic: string | null;
  board: string | null;
  docs: string;
}

export function affectsTargetExists(target: AffectsTarget, repoRoot: string, config: ArtifactConfig): boolean {
  switch (target) {
    case 'schematic':
      return !!config.schematic;
    case 'board':
      return !!config.board;
    case 'bom':
      return existsSync(path.join(repoRoot, config.docs, 'BOM.md'));
  }
}

export interface ReopenedAffects {
  key: string;
  item: string;
}

/**
 * Run-start hook: re-open the revisit obligations that were deferred while
 * their target artifact did not exist. Each re-opened item is removed from the
 * registry's `deferred` marker in the same pass, so it re-opens exactly once —
 * from then on it lives in the run's ledger like any other obligation.
 */
export async function reopenDeferredAffects(
  repoRoot: string,
  config: ArtifactConfig,
  openObligation: (key: string, item: string) => void,
): Promise<ReopenedAffects[]> {
  const registry = await loadConstraints(repoRoot);
  const reopened: ReopenedAffects[] = [];
  for (const [key, c] of Object.entries(registry)) {
    if (!c.deferred?.length) continue;
    const stillDeferred: string[] = [];
    for (const item of c.deferred) {
      const target = classifyAffectsTarget(item);
      if (target && !affectsTargetExists(target, repoRoot, config)) {
        stillDeferred.push(item);
        continue;
      }
      openObligation(key, item);
      reopened.push({ key, item });
    }
    if (stillDeferred.length) c.deferred = stillDeferred;
    else delete c.deferred;
  }
  if (reopened.length) await saveConstraints(repoRoot, registry);
  return reopened;
}

export interface ConstraintViolation {
  key: string;
  description: string;
  source: string;
}

export type PinNetEntry = Omit<PinNet, 'pinNumber'> & { pinNumber?: string };

function normalizeRef(ref: string, knownRefs: ReadonlySet<string>): string {
  if (knownRefs.has(ref)) return ref;
  const m = /^([A-Za-z]+\d+)[A-Za-z]+$/.exec(ref);
  if (m && knownRefs.has(m[1]!)) return m[1]!;
  return ref;
}

function extractScopedRefs(
  c: Constraint,
  knownRefs: ReadonlySet<string>,
): { refs: Set<string> | null; explicit: boolean } {
  if (c.refs?.length) {
    const explicit = new Set(c.refs.map((r) => normalizeRef(r.trim(), knownRefs)).filter(Boolean));
    if (explicit.size > 0) return { refs: explicit, explicit: true };
  }
  const fromAffects = new Set<string>();
  for (const raw of c.affects ?? []) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.includes(':')) continue;
    for (const rawToken of trimmed.split(/\s+/)) {
      const cleaned = rawToken.replace(/^[(),;.[\]{}'"`]+|[(),;.[\]{}'"`]+$/g, '');
      if (!cleaned) continue;
      const token = normalizeRef(cleaned, knownRefs);
      if (knownRefs.has(token) && !/^(?:GPIO|IO)\d+/i.test(token)) {
        fromAffects.add(token);
      }
    }
  }
  return { refs: fromAffects.size > 0 ? fromAffects : null, explicit: false };
}

interface ParsedForbiddenSpec {
  refs: Set<string> | null;
  pinSpec: string;
  isRefScoped: boolean;
}

function parseForbiddenSpec(
  raw: string,
  defaultScope: { refs: Set<string> | null; explicit: boolean },
  knownRefs: ReadonlySet<string>,
): ParsedForbiddenSpec {
  const trimmed = raw.trim();
  const prefixed = /^([A-Za-z]+\d+[A-Za-z]*)\s*:\s*(.+)$/.exec(trimmed);
  if (prefixed) {
    return {
      refs: new Set([normalizeRef(prefixed[1]!, knownRefs)]),
      pinSpec: prefixed[2]!.trim(),
      isRefScoped: true,
    };
  }
  return { refs: defaultScope.refs, pinSpec: trimmed, isRefScoped: defaultScope.explicit };
}

function canonicalIoName(name: string): string {
  return name.trim().replace(/^GPIO(?=\d)/i, 'IO').toUpperCase();
}

function matchesPinName(pn: PinNetEntry, pinSpec: string): boolean {
  if (!pinSpec) return false;
  if (pn.pinName === pinSpec) return true;
  const targetCanon = canonicalIoName(pinSpec);
  if (canonicalIoName(pn.pinName) === targetCanon) return true;
  if (pn.pinName.includes('/')) {
    for (const seg of pn.pinName.split('/')) {
      const s = seg.trim();
      if (s && (s === pinSpec || canonicalIoName(s) === targetCanon)) return true;
    }
  }
  return false;
}

function matchesPinNumber(pn: PinNetEntry, pinSpec: string, isRefScoped: boolean): boolean {
  return (
    Boolean(pinSpec) &&
    isRefScoped &&
    pn.pinNumber !== undefined &&
    pn.pinNumber !== '' &&
    pn.pinNumber === pinSpec
  );
}

function matchesSpec(
  pn: PinNetEntry,
  spec: ParsedForbiddenSpec,
  allPins: readonly PinNetEntry[],
): boolean {
  if (spec.refs && !spec.refs.has(pn.ref)) return false;
  if (matchesPinName(pn, spec.pinSpec)) return true;
  if (!matchesPinNumber(pn, spec.pinSpec, spec.isRefScoped)) return false;
  const partHasNameMatch = allPins.some(
    (other) => other.ref === pn.ref && matchesPinName(other, spec.pinSpec),
  );
  return !partHasNameMatch;
}

/**
 * Mechanical validation where possible (SPEC §2.6): forbidden pins against the
 * pinout, numeric budget keys surfaced for the doc-level checks. Geometry
 * checks are out of scope for Phase 1.
 */
export function checkForbiddenPins(
  registry: ConstraintRegistry,
  pinNets: PinNetEntry[],
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const knownRefs = new Set(pinNets.map((p) => p.ref));
  for (const [key, c] of Object.entries(registry)) {
    if (!c.forbidden?.length) continue;
    const defaultScope = extractScopedRefs(c, knownRefs);
    const specs = c.forbidden.map((entry) => parseForbiddenSpec(entry, defaultScope, knownRefs));
    for (const pn of pinNets) {
      if (!pn.net) continue;
      const matchedSpec = specs.find((spec) => matchesSpec(pn, spec, pinNets));
      if (matchedSpec) {
        const pinLabel =
          pn.pinName === matchedSpec.pinSpec ? pn.pinName : `${pn.pinName} (${matchedSpec.pinSpec})`;
        violations.push({
          key,
          description: `${pn.ref} pin ${pinLabel} is connected to net ${pn.net} but is forbidden by ${key}`,
          source: c.source,
        });
      }
    }
  }
  return violations;
}

/**
 * Constraint keys whose `forbidden` list contains entries that did not match
 * any pin on the in-scope part(s), so `check` and `sync` can report
 * `constraint <key>: not mechanically checked` instead of counting them as a
 * silent pass (#395).
 */
export function uncheckedForbiddenConstraints(
  registry: ConstraintRegistry,
  pinNets: PinNetEntry[],
): string[] {
  const unchecked: string[] = [];
  const knownRefs = new Set(pinNets.map((p) => p.ref));
  for (const [key, c] of Object.entries(registry)) {
    if (!c.forbidden?.length) continue;
    const defaultScope = extractScopedRefs(c, knownRefs);
    let anyUnmatched = false;
    for (const raw of c.forbidden) {
      const spec = parseForbiddenSpec(raw, defaultScope, knownRefs);
      const matched = pinNets.some((pn) => matchesSpec(pn, spec, pinNets));
      if (!matched) {
        anyUnmatched = true;
        break;
      }
    }
    if (anyUnmatched) {
      unchecked.push(key);
    }
  }
  return unchecked;
}
