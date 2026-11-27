/**
 * Manifest validation (RFC 11 §9.4, AC-17.3): a plugin whose manifest is
 * incomplete or names an unknown schema version is rejected at discovery,
 * with the field named. Structural checks live here; the JSON Schema in
 * schemas/pcb/ is the same contract for out-of-process wrappers.
 */
import { ENGINE_SCHEMA_VERSION, type EngineManifest } from './contracts.js';

const KINDS = new Set(['placer', 'router', 'checker']);
const DETERMINISM = new Set(['deterministic', 'seeded', 'nondeterministic']);
const MODES = new Set(['library', 'process', 'container', 'remote']);
const NETWORK = new Set(['none', 'optional', 'required']);
const SPDX = /^[A-Za-z0-9.+-]+(\s(OR|AND|WITH)\s[A-Za-z0-9.+-]+)*$/;
/** Copyleft families that may never run in-process (RFC 11 §17, ADR 0003). */
export const COPYLEFT = /^(GPL|AGPL|LGPL|CC-BY-SA|CERN-OHL-S|CERN-OHL-W)/i;

export interface ManifestProblem {
  field: string;
  problem: string;
}

export function validateManifest(m: unknown): ManifestProblem[] {
  const out: ManifestProblem[] = [];
  const o = (m ?? {}) as Record<string, unknown>;
  const need = (field: string, ok: boolean, problem: string) => {
    if (!ok) out.push({ field, problem });
  };
  need('id', typeof o.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(o.id as string), 'kebab-case id required');
  need('kind', KINDS.has(o.kind as string), 'placer | router | checker');
  need('version', typeof o.version === 'string' && (o.version as string).length > 0, 'engine version required');
  need('adapterVersion', typeof o.adapterVersion === 'string' && (o.adapterVersion as string).length > 0, 'adapter version required');
  need('license', typeof o.license === 'string' && SPDX.test(o.license as string), 'SPDX identifier required');
  need('inputSchemaVersions', Array.isArray(o.inputSchemaVersions) && (o.inputSchemaVersions as unknown[]).includes(ENGINE_SCHEMA_VERSION), `must include ${ENGINE_SCHEMA_VERSION}`);
  need('outputSchemaVersions', Array.isArray(o.outputSchemaVersions) && (o.outputSchemaVersions as unknown[]).includes(ENGINE_SCHEMA_VERSION), `must include ${ENGINE_SCHEMA_VERSION}`);
  need('determinism', DETERMINISM.has(o.determinism as string), 'deterministic | seeded | nondeterministic');
  need('executionMode', MODES.has(o.executionMode as string), 'library | process | container | remote');
  need('networkRequirement', NETWORK.has(o.networkRequirement as string), 'none | optional | required');
  need('harnessOnly', typeof o.harnessOnly === 'boolean', 'boolean required');
  need('requires', !!o.requires && typeof o.requires === 'object', 'object required');
  need('capabilities', !!o.capabilities && typeof o.capabilities === 'object', 'object required');
  need('supportedConstraints', Array.isArray(o.supportedConstraints), 'array required');
  if (typeof o.license === 'string' && COPYLEFT.test(o.license) && o.executionMode === 'library') {
    out.push({ field: 'executionMode', problem: `${o.license} engines must run out of process (RFC 11 §17)` });
  }
  if (o.kind === 'router' && o.capabilities && typeof o.capabilities === 'object') {
    for (const k of ['differentialPairs', 'lengthMatching', 'pushAndShove', 'partialRouting', 'preserveExistingRoutes', 'arbitraryAngles', 'blindBuriedVias', 'copperZones']) {
      need(`capabilities.${k}`, typeof (o.capabilities as Record<string, unknown>)[k] === 'boolean', 'boolean required');
    }
  }
  if (o.kind === 'placer' && o.capabilities && typeof o.capabilities === 'object') {
    for (const k of ['bottomSide', 'rotation', 'arbitraryOutline', 'fixedComponents', 'congestionAwareness', 'layoutReuse']) {
      need(`capabilities.${k}`, typeof (o.capabilities as Record<string, unknown>)[k] === 'boolean', 'boolean required');
    }
    need('capabilities.relativeConstraints', Array.isArray((o.capabilities as Record<string, unknown>).relativeConstraints), 'array required');
  }
  return out;
}

export function assertManifest(m: unknown): EngineManifest {
  const problems = validateManifest(m);
  if (problems.length) throw new Error(`invalid engine manifest: ${problems.map((p) => `${p.field}: ${p.problem}`).join('; ')}`);
  return m as EngineManifest;
}
