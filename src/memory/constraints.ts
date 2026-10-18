import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

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

/**
 * Mechanical validation where possible (SPEC §2.6): forbidden pins against the
 * pinout, numeric budget keys surfaced for the doc-level checks. Geometry
 * checks are out of scope for Phase 1.
 */
export interface PinNetEntry {
  ref: string;
  pinName: string;
  pinNumber?: string;
  net: string | null;
}

const REFDES_TOKEN_RE =
  /^(?:U|IC|MCU|R|C|L|D|Q|J|P|SW|S|K|Y|X|F|FB|TP|BT|LED|RN|RV|T|BZ|LS|MK|VR|Z|FL|A|H|M|TH|W)\d+[A-Za-z]*$/;

function extractScopedRefs(c: Constraint, knownRefs: ReadonlySet<string>): Set<string> | null {
  if (c.refs?.length) {
    const explicit = new Set(c.refs.map((r) => r.trim()).filter(Boolean));
    if (explicit.size > 0) return explicit;
  }
  const fromAffects = new Set<string>();
  for (const raw of c.affects ?? []) {
    if (classifyAffectsTarget(raw) !== null) continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.includes(':')) continue;
    const head = trimmed.split(/\s+/)[0] ?? '';
    if (REFDES_TOKEN_RE.test(head) || (knownRefs.has(head) && !/^(?:GPIO|IO)\d+/i.test(head))) {
      fromAffects.add(head);
    }
  }
  return fromAffects.size > 0 ? fromAffects : null;
}

function parseForbiddenSpec(
  raw: string,
  defaultRefs: Set<string> | null,
): { refs: Set<string> | null; pinSpec: string } {
  const trimmed = raw.trim();
  const prefixed = /^([A-Za-z]+\d+[A-Za-z]*)\s*[:.]\s*(.+)$/.exec(trimmed);
  if (prefixed) {
    return { refs: new Set([prefixed[1]!]), pinSpec: prefixed[2]!.trim() };
  }
  return { refs: defaultRefs, pinSpec: trimmed };
}

function canonicalIoName(name: string): string {
  return name.trim().replace(/^GPIO(?=\d)/i, 'IO').toUpperCase();
}

function matchesPin(pn: PinNetEntry, pinSpec: string): boolean {
  if (!pinSpec) return false;
  if (pn.pinNumber !== undefined && pn.pinNumber !== '' && pn.pinNumber === pinSpec) {
    return true;
  }
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

export function checkForbiddenPins(
  registry: ConstraintRegistry,
  pinNets: PinNetEntry[],
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const knownRefs = new Set(pinNets.map((p) => p.ref));
  for (const [key, c] of Object.entries(registry)) {
    if (!c.forbidden?.length) continue;
    const defaultRefs = extractScopedRefs(c, knownRefs);
    const specs = c.forbidden.map((entry) => parseForbiddenSpec(entry, defaultRefs));
    for (const pn of pinNets) {
      if (!pn.net) continue;
      const matchedSpec = specs.find(
        ({ refs, pinSpec }) => (!refs || refs.has(pn.ref)) && matchesPin(pn, pinSpec),
      );
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
 * Constraint keys whose `forbidden` list matched no pin on any in-scope part
 * (or contains free-text entries that do not match any pin), so `check` and
 * `sync` can report `constraint <key>: not mechanically checked` instead of
 * counting them as a silent pass (#395).
 */
export function uncheckedForbiddenConstraints(
  registry: ConstraintRegistry,
  pinNets: PinNetEntry[],
): string[] {
  const unchecked: string[] = [];
  const knownRefs = new Set(pinNets.map((p) => p.ref));
  for (const [key, c] of Object.entries(registry)) {
    if (!c.forbidden?.length) continue;
    const defaultRefs = extractScopedRefs(c, knownRefs);
    let anyPinMatched = false;
    let hasUnmatchedFreeText = false;
    for (const raw of c.forbidden) {
      const { refs, pinSpec } = parseForbiddenSpec(raw, defaultRefs);
      const matched = pinNets.some((pn) => (!refs || refs.has(pn.ref)) && matchesPin(pn, pinSpec));
      if (matched) {
        anyPinMatched = true;
      } else if (/\s/.test(pinSpec)) {
        hasUnmatchedFreeText = true;
      }
    }
    if (!anyPinMatched || hasUnmatchedFreeText) {
      unchecked.push(key);
    }
  }
  return unchecked;
}
