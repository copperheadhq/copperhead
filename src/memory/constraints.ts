import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
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
  evidence?: ConstraintEvidence;
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
  /** Optional expected SHA-256 hex digest of the cached evidence file (or verified via .copperhead/datasheets/index.json). */
  sha256?: string;
  /** Optionalexpected SHA-256 hex digest of the extracted `.pdf.txt` sidecar when `path` is a PDF. */
  sidecarSha256?: string;
  /** Optional section or page locator (for diagnostics). */
  section?: string;
  /** Verbatim quote from the cached evidence that mentions the constraint bound. */
  quote: string;
  /** Optional explicit numeric literals cited from the quote. */
  numbers?: (string | number)[];
}

export type EvidenceBackedConstraint = Constraint;

export interface VerifyEvidenceOptions {
  /** Repo-relative directories allowed for evidence reads (defaults to ['.copperhead/datasheets', 'docs/datasheets']). */
  allowedDirs?: string[];
}

const DEFAULT_EVIDENCE_DIRS = ['.copperhead/datasheets', 'docs/datasheets'];

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function resolveCanonicalOrLexical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isWithinAllowedEvidenceDirs(
  repoRoot: string,
  candidatePath: string,
  allowedDirs: string[],
): boolean {
  const canonicalRoot = resolveCanonicalOrLexical(repoRoot);
  const lexicalTarget = path.resolve(canonicalRoot, candidatePath);
  let canonicalTarget = lexicalTarget;
  if (existsSync(lexicalTarget)) {
    try {
      canonicalTarget = realpathSync(lexicalTarget);
    } catch {
      return false;
    }
  }
  for (const relDir of allowedDirs) {
    const allowedAbs = resolveCanonicalOrLexical(path.resolve(canonicalRoot, relDir));
    if (canonicalTarget === allowedAbs || canonicalTarget.startsWith(allowedAbs + path.sep)) {
      return true;
    }
  }
  return false;
}

function extractNumericTokens(text: string): number[] {
  const normalized = text
    .replace(/\u2212/g, '-')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    // Treat hyphen directly after a digit (e.g. "1.8-3.6 V" or "1.8 - 3.6 V") as a range separator, not a negative sign
    .replace(/(\d)\s*-\s*(?=\d)/g, '$1 .. ');
  const matches = normalized.match(/(?<![\d.])-?\d+(?:\.\d+)?/g) ?? [];
  return matches.map((m) => Number(m)).filter((n) => Number.isFinite(n));
}

async function loadDatasheetIndexHashes(repoRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const idxPath = path.join(repoRoot, '.copperhead', 'datasheets', 'index.json');
  if (!existsSync(idxPath)) return map;
  try {
    const raw = JSON.parse(await readFile(idxPath, 'utf8')) as unknown;
    const entries = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown[] }).entries)
        ? (raw as { entries: unknown[] }).entries
        : raw && typeof raw === 'object'
          ? Object.entries(raw as Record<string, unknown>).map(([p, v]) => ({ path: p, ...(v as object) }))
          : [];
    for (const item of entries) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const p = typeof rec.path === 'string' ? rec.path.split(path.sep).join('/') : '';
      const sha = typeof rec.sha256 === 'string' ? rec.sha256 : '';
      if (p && sha) map.set(p, sha);
    }
  } catch {
    // Ignore unreadable index.json here; individual sha256 checks still run.
  }
  return map;
}

/**
 * Deterministic, offline verification of general constraint evidence (#232).
 * Checks that every constraint carrying `evidence` resolves inside the allowed
 * evidence cache directories under `repoRoot` (following symlinks via realpath),
 * refers to a regular file, matches its `sha256` digest (and/or `.copperhead/datasheets/index.json`),
 * requires an extracted `.pdf.txt` sidecar when `path` is a PDF, contains the
 * verbatim `quote`, and mentions the constraint's numeric bounds.
 */
export async function verifyConstraintEvidence(
  repoRoot: string,
  registry: ConstraintRegistry,
  opts?: VerifyEvidenceOptions,
): Promise<ConstraintViolation[]> {
  const { createHash } = await import('node:crypto');
  const allowedDirs = opts?.allowedDirs ?? DEFAULT_EVIDENCE_DIRS;
  const indexHashes = await loadDatasheetIndexHashes(repoRoot);
  const violations: ConstraintViolation[] = [];

  for (const [key, rawConstraint] of Object.entries(registry)) {
    if (!rawConstraint || typeof rawConstraint !== 'object') continue;
    const c = rawConstraint as Constraint;
    const ev = c.evidence as unknown as Record<string, unknown> | undefined;
    if (!ev) continue;

    if (
      typeof ev.path !== 'string' ||
      typeof ev.quote !== 'string' ||
      (ev.sha256 !== undefined && typeof ev.sha256 !== 'string') ||
      (ev.sidecarSha256 !== undefined && typeof ev.sidecarSha256 !== 'string')
    ) {
      violations.push({
        key,
        description: `malformed evidence entry (path, quote, and optional sha256 must be strings)`,
        source: c.source,
      });
      continue;
    }

    const evPath = ev.path.trim();
    if (!evPath || !isWithinAllowedEvidenceDirs(repoRoot, evPath, allowedDirs)) {
      violations.push({
        key,
        description: `evidence path "${ev.path}" escapes the allowed evidence cache (${allowedDirs.join(', ')}) or is empty`,
        source: c.source,
      });
      continue;
    }

    const fullPath = path.resolve(repoRoot, evPath);
    let isRegularFile = false;
    try {
      isRegularFile = statSync(fullPath).isFile();
    } catch {
      isRegularFile = false;
    }
    if (!isRegularFile) {
      violations.push({
        key,
        description: `cached evidence file "${evPath}" does not exist on disk or is not a regular file`,
        source: c.source,
      });
      continue;
    }

    let buf: Buffer;
    try {
      buf = await readFile(fullPath);
    } catch (err) {
      violations.push({
        key,
        description: `failed to read cached evidence file "${evPath}": ${(err as Error).message}`,
        source: c.source,
      });
      continue;
    }

    const normEvPath = evPath.split(path.sep).join('/');
    const expectedSha = ev.sha256 ?? indexHashes.get(normEvPath);
    if (expectedSha) {
      const actualHash = createHash('sha256').update(buf).digest('hex');
      if (actualHash.toLowerCase() !== expectedSha.toLowerCase()) {
        violations.push({
          key,
          description: `evidence file "${evPath}" sha256 mismatch (expected ${expectedSha}, got ${actualHash})`,
          source: c.source,
        });
        continue;
      }
    }

    let textSourceBuf = buf;
    if (evPath.toLowerCase().endsWith('.pdf')) {
      const sidecarRel = `${evPath}.txt`;
      const sidecarAbs = `${fullPath}.txt`;
      if (!existsSync(sidecarAbs) || !isWithinAllowedEvidenceDirs(repoRoot, sidecarRel, allowedDirs)) {
        violations.push({
          key,
          description: `PDF evidence has no extracted-text sidecar (${sidecarRel})`,
          source: c.source,
        });
        continue;
      }
      try {
        textSourceBuf = await readFile(sidecarAbs);
      } catch (err) {
        violations.push({
          key,
          description: `failed to read PDF extracted-text sidecar "${sidecarRel}": ${(err as Error).message}`,
          source: c.source,
        });
        continue;
      }
      if (ev.sidecarSha256) {
        const actualSidecarHash = createHash('sha256').update(textSourceBuf).digest('hex');
        if (actualSidecarHash.toLowerCase() !== ev.sidecarSha256.toLowerCase()) {
          violations.push({
            key,
            description: `PDF sidecar "${sidecarRel}" sha256 mismatch (expected ${ev.sidecarSha256}, got ${actualSidecarHash})`,
            source: c.source,
          });
          continue;
        }
      }
    }

    const text = textSourceBuf.toString('utf8');
    const normDoc = normalizeWs(text);
    const normQuote = normalizeWs(ev.quote);
    const sectionSuffix = typeof ev.section === 'string' && ev.section ? ` (${ev.section})` : '';
    if (!normQuote || !normDoc.includes(normQuote)) {
      violations.push({
        key,
        description: `cited quote not found verbatim in "${evPath}"${sectionSuffix}`,
        source: c.source,
      });
      continue;
    }

    const requiredNumbers: number[] = [];
    if (ev.numbers !== undefined) {
      if (!Array.isArray(ev.numbers) || ev.numbers.length === 0) {
        violations.push({
          key,
          description: `evidence.numbers for "${evPath}" must be a non-empty array of finite numbers`,
          source: c.source,
        });
        continue;
      }
      let badEntry = false;
      for (const n of ev.numbers) {
        const parsed = typeof n === 'string' && n.trim() === '' ? Number.NaN : Number(n);
        if (!Number.isFinite(parsed)) {
          badEntry = true;
          break;
        }
        requiredNumbers.push(parsed);
      }
      if (badEntry || requiredNumbers.length === 0) {
        violations.push({
          key,
          description: `evidence.numbers for "${evPath}" contains non-numeric entries`,
          source: c.source,
        });
        continue;
      }
    } else {
      if (typeof c.min === 'number') requiredNumbers.push(c.min);
      if (typeof c.max === 'number') requiredNumbers.push(c.max);
      if (typeof c.value === 'number') {
        requiredNumbers.push(c.value);
      } else if (typeof c.value === 'string') {
        const trimmed = c.value.trim();
        const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
        if (Number.isFinite(parsed)) {
          requiredNumbers.push(parsed);
        } else {
          violations.push({
            key,
            description: `constraint value "${c.value}" is not numeric and no evidence.numbers override was provided`,
            source: c.source,
          });
          continue;
        }
      }
    }

    const quoteNumbers = extractNumericTokens(normQuote);
    for (const boundNum of requiredNumbers) {
      if (!quoteNumbers.some((qn) => qn === boundNum)) {
        violations.push({
          key,
          description: `constraint bound "${boundNum}" is not present in the cited quote from "${evPath}"`,
          source: c.source,
        });
      }
    }
  }

  return violations;
}
