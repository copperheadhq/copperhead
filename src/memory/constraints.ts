import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { configPath, loadConfig } from '../config.js';
import { resolveInRepo } from '../util/paths.js';

/**
 * Effective constraint registry (SPEC §2.6): project constraints plus local
 * pack rules. Project entries are dual-written with docs; `affects` drives
 * propagation.
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

export interface ConstraintPackRule {
  min?: number;
  max?: number;
  forbidden?: string[];
  value?: string | number;
  affects: string[];
}

export interface ConstraintPack {
  id: string;
  version: string;
  name: string;
  description: string;
  constraints: Record<string, ConstraintPackRule>;
}

export interface ConstraintPackInstallResult {
  id: string;
  version: string;
  name: string;
  ruleCount: number;
  path: string;
  updated: boolean;
  alreadyInstalled: boolean;
}

const packSource = (id: string, version: string): string => `constraint pack ${id}@${version}`;
const PACK_ID = /^[a-z0-9][a-z0-9-]*$/;
const PACK_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PACK_FIELDS = new Set(['min', 'max', 'forbidden', 'value', 'affects']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = record(value);
  if (object) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function parseConstraintPack(raw: unknown): ConstraintPack {
  const pack = record(raw);
  if (!pack) throw new Error('constraint pack must be a JSON object');
  const unknownFields = Object.keys(pack).filter(
    (key) => !['id', 'version', 'name', 'description', 'constraints'].includes(key),
  );
  if (unknownFields.length) throw new Error(`constraint pack has unknown field(s): ${unknownFields.join(', ')}`);
  if (typeof pack.id !== 'string' || !PACK_ID.test(pack.id)) {
    throw new Error('constraint pack id must be lowercase letters, numbers, and hyphens, starting with a letter or number');
  }
  if (typeof pack.version !== 'string' || !PACK_VERSION.test(pack.version)) {
    throw new Error('constraint pack version must be a numeric semantic version such as "1.0.0"');
  }
  if (typeof pack.name !== 'string' || !pack.name.trim()) throw new Error('constraint pack name must be non-empty');
  if (typeof pack.description !== 'string' || !pack.description.trim()) {
    throw new Error('constraint pack description must be non-empty');
  }

  const rawConstraints = record(pack.constraints);
  if (!rawConstraints || !Object.keys(rawConstraints).length) {
    throw new Error('constraint pack must contain at least one constraint');
  }
  const constraints: Record<string, ConstraintPackRule> = {};
  for (const [key, rawRule] of Object.entries(rawConstraints)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error(`constraint pack has invalid constraint key "${key}"`);
    }
    const rule = record(rawRule);
    if (!rule) throw new Error(`constraint "${key}" must be an object`);
    const unknownRuleFields = Object.keys(rule).filter((field) => !PACK_FIELDS.has(field));
    if (unknownRuleFields.length) {
      throw new Error(`constraint "${key}" has unknown field(s): ${unknownRuleFields.join(', ')}`);
    }
    if (rule.min !== undefined && (typeof rule.min !== 'number' || !Number.isFinite(rule.min))) {
      throw new Error(`constraint "${key}".min must be a finite number`);
    }
    if (rule.max !== undefined && (typeof rule.max !== 'number' || !Number.isFinite(rule.max))) {
      throw new Error(`constraint "${key}".max must be a finite number`);
    }
    if (typeof rule.min === 'number' && typeof rule.max === 'number' && rule.min > rule.max) {
      throw new Error(`constraint "${key}" has min greater than max`);
    }
    if (
      rule.value !== undefined &&
      !(typeof rule.value === 'string' || (typeof rule.value === 'number' && Number.isFinite(rule.value)))
    ) {
      throw new Error(`constraint "${key}".value must be a string or finite number`);
    }
    if (
      rule.forbidden !== undefined &&
      (!Array.isArray(rule.forbidden) ||
        rule.forbidden.length === 0 ||
        rule.forbidden.some((item) => typeof item !== 'string' || !item.trim()))
    ) {
      throw new Error(`constraint "${key}".forbidden must be a non-empty array of strings`);
    }
    if (
      rule.affects !== undefined &&
      (!Array.isArray(rule.affects) || rule.affects.some((item) => typeof item !== 'string' || !item.trim()))
    ) {
      throw new Error(`constraint "${key}".affects must be an array of non-empty strings`);
    }
    if (rule.min === undefined && rule.max === undefined && rule.value === undefined && rule.forbidden === undefined) {
      throw new Error(`constraint "${key}" must define min, max, value, or forbidden`);
    }
    constraints[key] = {
      ...(typeof rule.min === 'number' ? { min: rule.min } : {}),
      ...(typeof rule.max === 'number' ? { max: rule.max } : {}),
      ...(typeof rule.value === 'string' || typeof rule.value === 'number' ? { value: rule.value } : {}),
      ...(Array.isArray(rule.forbidden) ? { forbidden: rule.forbidden as string[] } : {}),
      affects: Array.isArray(rule.affects) ? (rule.affects as string[]) : [],
    };
  }

  return {
    id: pack.id,
    version: pack.version,
    name: pack.name.trim(),
    description: pack.description.trim(),
    constraints,
  };
}

export function constraintsPath(repoRoot: string): string {
  return path.join(repoRoot, '.copperhead', 'constraints.json');
}

export async function loadLocalConstraints(repoRoot: string): Promise<ConstraintRegistry> {
  const p = constraintsPath(repoRoot);
  if (!existsSync(p)) return {};
  return JSON.parse(await readFile(p, 'utf8')) as ConstraintRegistry;
}

export async function loadConstraints(repoRoot: string): Promise<ConstraintRegistry> {
  const registry = await loadLocalConstraints(repoRoot);
  const config = await loadConfig(repoRoot);
  const installedIds = new Set<string>();
  for (const packPath of config.constraintPacks ?? []) {
    const abs = resolveInRepo(repoRoot, packPath);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(abs, 'utf8'));
    } catch (error) {
      throw new Error(`cannot load constraint pack ${packPath}: ${(error as Error).message}`);
    }
    const pack = parseConstraintPack(raw);
    const expectedPath = path.posix.join('.copperhead', 'packs', `${pack.id}@${pack.version}.json`);
    if (path.posix.normalize(packPath.replace(/\\/g, '/')) !== expectedPath) {
      throw new Error(`constraint pack ${pack.id}@${pack.version} must be stored at ${expectedPath}`);
    }
    if (installedIds.has(pack.id)) {
      throw new Error(`constraint pack "${pack.id}" is listed more than once in .copperhead/config.json`);
    }
    installedIds.add(pack.id);
    for (const [key, rule] of Object.entries(pack.constraints)) {
      if (Object.hasOwn(registry, key)) {
        throw new Error(`constraint pack "${pack.id}@${pack.version}" conflicts with existing constraint "${key}"`);
      }
      registry[key] = { ...rule, source: packSource(pack.id, pack.version) };
    }
  }
  return registry;
}

/** Persist project constraints only; pack rules remain in their JSON files. */
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
  const local = await loadLocalConstraints(repoRoot);
  const effective = await loadConstraints(repoRoot);
  if (!Object.hasOwn(local, key) && Object.hasOwn(effective, key)) {
    throw new Error(`constraint "${key}" comes from a constraint pack; update the pack version instead of editing it`);
  }
  local[key] = constraint;
  await saveConstraints(repoRoot, local);
  return loadConstraints(repoRoot);
}

export async function installConstraintPack(
  repoRoot: string,
  sourcePath: string,
): Promise<ConstraintPackInstallResult> {
  const source = path.resolve(sourcePath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(source, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read constraint pack ${sourcePath}: ${(error as Error).message}`);
  }
  const pack = parseConstraintPack(raw);
  const config = await loadConfig(repoRoot);
  const local = await loadLocalConstraints(repoRoot);
  const otherPacks: ConstraintPack[] = [];
  const otherPackPaths: string[] = [];
  let updated = false;
  let alreadyInstalled = false;
  for (const existingPath of config.constraintPacks ?? []) {
    const abs = resolveInRepo(repoRoot, existingPath);
    let existingRaw: unknown;
    try {
      existingRaw = JSON.parse(await readFile(abs, 'utf8'));
    } catch (error) {
      throw new Error(`cannot load existing constraint pack ${existingPath}: ${(error as Error).message}`);
    }
    const existing = parseConstraintPack(existingRaw);
    if (existing.id === pack.id) {
      if (existing.version === pack.version && canonicalJson(existing) !== canonicalJson(pack)) {
        throw new Error(`constraint pack ${pack.id}@${pack.version} is already installed; pack versions are immutable`);
      }
      alreadyInstalled = existing.version === pack.version;
      updated = !alreadyInstalled;
    } else {
      otherPacks.push(existing);
      otherPackPaths.push(existingPath);
    }
  }

  const conflicts = new Set<string>();
  for (const key of Object.keys(pack.constraints)) {
    if (Object.hasOwn(local, key)) conflicts.add(key);
    for (const other of otherPacks) {
      if (Object.hasOwn(other.constraints, key)) conflicts.add(key);
    }
  }
  if (conflicts.size) {
    throw new Error(
      `constraint pack ${pack.id}@${pack.version} conflicts with existing constraint(s): ${[...conflicts].join(', ')}`,
    );
  }

  const packRelPath = path.posix.join('.copperhead', 'packs', `${pack.id}@${pack.version}.json`);
  const packAbsPath = resolveInRepo(repoRoot, packRelPath);
  if (existsSync(packAbsPath)) {
    let installed: unknown;
    try {
      installed = JSON.parse(await readFile(packAbsPath, 'utf8'));
    } catch (error) {
      throw new Error(`cannot replace invalid installed pack ${packRelPath}: ${(error as Error).message}`);
    }
    if (canonicalJson(parseConstraintPack(installed)) !== canonicalJson(pack)) {
      throw new Error(`constraint pack ${pack.id}@${pack.version} is already present with different contents`);
    }
  }

  const rawConfig = existsSync(configPath(repoRoot))
    ? (JSON.parse(await readFile(configPath(repoRoot), 'utf8')) as Record<string, unknown>)
    : {};
  const nextPacks = otherPackPaths;
  if (!nextPacks.includes(packRelPath)) nextPacks.push(packRelPath);

  await mkdir(path.dirname(packAbsPath), { recursive: true });
  await writeFile(packAbsPath, JSON.stringify(pack, null, 2) + '\n', 'utf8');
  await mkdir(path.dirname(configPath(repoRoot)), { recursive: true });
  await writeFile(
    configPath(repoRoot),
    JSON.stringify({ ...rawConfig, constraintPacks: nextPacks }, null, 2) + '\n',
    'utf8',
  );

  return {
    id: pack.id,
    version: pack.version,
    name: pack.name,
    ruleCount: Object.keys(pack.constraints).length,
    path: packRelPath,
    updated,
    alreadyInstalled,
  };
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
  const registry = await loadLocalConstraints(repoRoot);
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
