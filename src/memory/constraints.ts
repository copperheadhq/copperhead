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
export function checkForbiddenPins(
  registry: ConstraintRegistry,
  pinNets: { ref: string; pinName: string; net: string | null }[],
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  for (const [key, c] of Object.entries(registry)) {
    if (!c.forbidden?.length) continue;
    for (const pn of pinNets) {
      if (pn.net && c.forbidden.includes(pn.pinName)) {
        violations.push({
          key,
          description: `${pn.ref} pin ${pn.pinName} is connected to net ${pn.net} but is forbidden by ${key}`,
          source: c.source,
        });
      }
    }
  }
  return violations;
}

/**
 * Evidence citation attached to a general engineering constraint (#232).
 * Validated deterministically against locally cached/committed files with
 * zero network calls.
 */
export interface ConstraintEvidence {
  /** Repo-relative path to the cached datasheet, app note, or spec document. */
  path: string;
  /** Optional expected SHA-256 hex digest of the cached evidence file. */
  sha256?: string;
  /** Optional section or page locator (for diagnostics). */
  section?: string;
  /** Verbatim quote from the cached evidence supporting the constraint bound. */
  quote: string;
  /** Optional explicit numeric literals cited from the quote. */
  numbers?: (string | number)[];
}

export interface EvidenceBackedConstraint extends Constraint {
  evidence?: ConstraintEvidence;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function isWithinRepo(repoRoot: string, candidatePath: string): boolean {
  const rootResolved = path.resolve(repoRoot);
  const resolved = path.resolve(rootResolved, candidatePath);
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
}

/**
 * Deterministic, offline verification of general constraint evidence (#232).
 * Checks that every constraint carrying `evidence` (or a `source` citing a
 * local file with an attached `evidence` block) resolves inside `repoRoot`,
 * matches its optional `sha256` digest, contains the verbatim `quote`
 * (whitespace-normalized), and mentions the constraint's numeric bounds.
 */
export async function verifyConstraintEvidence(
  repoRoot: string,
  registry: ConstraintRegistry,
): Promise<ConstraintViolation[]> {
  const { createHash } = await import('node:crypto');
  const violations: ConstraintViolation[] = [];

  for (const [key, rawConstraint] of Object.entries(registry)) {
    const c = rawConstraint as EvidenceBackedConstraint;
    const ev = c.evidence;
    if (!ev) continue;

    if (!ev.path || !isWithinRepo(repoRoot, ev.path)) {
      violations.push({
        key,
        description: `evidence path "${ev.path}" escapes the repository root or is empty`,
        source: c.source,
      });
      continue;
    }

    const fullPath = path.resolve(repoRoot, ev.path);
    if (!existsSync(fullPath)) {
      violations.push({
        key,
        description: `cached evidence file "${ev.path}" does not exist on disk`,
        source: c.source,
      });
      continue;
    }

    const buf = await readFile(fullPath);
    if (ev.sha256) {
      const actualHash = createHash('sha256').update(buf).digest('hex');
      if (actualHash.toLowerCase() !== ev.sha256.toLowerCase()) {
        violations.push({
          key,
          description: `evidence file "${ev.path}" sha256 mismatch (expected ${ev.sha256}, got ${actualHash})`,
          source: c.source,
        });
        continue;
      }
    }

    const text = buf.toString('utf8');
    const normDoc = normalizeWs(text);
    const normQuote = normalizeWs(ev.quote ?? '');
    if (!normQuote || !normDoc.includes(normQuote)) {
      violations.push({
        key,
        description: `cited quote not found verbatim in "${ev.path}"${ev.section ? ` (${ev.section})` : ''}`,
        source: c.source,
      });
      continue;
    }

    const requiredNumbers: string[] = [];
    if (ev.numbers?.length) {
      for (const n of ev.numbers) requiredNumbers.push(String(n));
    } else {
      if (typeof c.min === 'number') requiredNumbers.push(String(c.min));
      if (typeof c.max === 'number') requiredNumbers.push(String(c.max));
      if (typeof c.value === 'number') requiredNumbers.push(String(c.value));
    }

    for (const numStr of requiredNumbers) {
      const escaped = numStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const numRe = new RegExp(`(?<![0-9.])${escaped}(?![0-9.])`);
      if (!numRe.test(normQuote)) {
        violations.push({
          key,
          description: `constraint bound "${numStr}" is not present in the cited quote from "${ev.path}"`,
          source: c.source,
        });
      }
    }
  }

  return violations;
}
