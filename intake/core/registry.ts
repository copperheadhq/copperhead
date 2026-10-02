// The registry (ground-intake-extraction D6): parameters per part and per document, the board's
// constraints, corrections as human readings, and the snapshot the verdict engine reads. Fails
// closed: a malformed registry is a typed error, never a default. Pure: the store reads and
// writes the file.

import { parseMeasurement, siValue, toDecimalString, UnitError } from "./knowledge/decimal";
import { computeLadder } from "./knowledge/ladder";
import type { ConditionSet, Constraint, Decimal, DocumentRef, Parameter, Qualifier, Reading } from "./knowledge/types";
import { conditionGroupKey } from "./knowledge/validators/candidate";
import { appendCorrection } from "./knowledge/validators/versioning";
import type { FactSnapshot, FactSnapshotEntry } from "./knowledge/verdict/types";
import { canonicalJson, sha256Hex } from "./canonical";
import type { FieldSpec } from "./fields";
import { QUALIFIERS } from "./extraction";
import type { AdmittedReading, PartEntry, PartRef, Registry } from "./model";

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

const KINDS = ["budget_sum", "max", "min", "equality"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDecimal(raw: unknown, where: string): Decimal {
  if (!isRecord(raw) || typeof raw.value_decimal !== "string" || typeof raw.unit !== "string") {
    throw new RegistryError(`${where} must be a decimal { value_decimal, unit, si_value_decimal }`);
  }
  let parsed: Decimal;
  try {
    parsed = parseMeasurement(raw.value_decimal, raw.unit);
  } catch (err) {
    throw new RegistryError(`${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw.si_value_decimal !== undefined && raw.si_value_decimal !== parsed.si_value_decimal) {
    throw new RegistryError(`${where}: si_value_decimal ${String(raw.si_value_decimal)} does not match ${raw.value_decimal} ${raw.unit}`);
  }
  return parsed;
}

function parseConstraint(raw: unknown, index: number): Constraint {
  if (!isRecord(raw)) throw new RegistryError(`constraints[${index}] is not an object`);
  const { id, description, kind, limit, affects, source, policy, conditions, stressFrom } = raw;
  if (typeof id !== "string" || id === "") throw new RegistryError(`constraints[${index}].id must be a non-empty string`);
  if (typeof description !== "string") throw new RegistryError(`constraint "${id}": description must be a string`);
  if (typeof kind !== "string" || !KINDS.includes(kind)) throw new RegistryError(`constraint "${id}": kind must be one of ${KINDS.join(", ")}`);
  if (!Array.isArray(affects) || affects.length === 0 || affects.some((a) => typeof a !== "string"))
    throw new RegistryError(`constraint "${id}": affects must be a non-empty string array`);
  if (typeof source !== "string") throw new RegistryError(`constraint "${id}": source must be a string`);
  if (!isRecord(policy) || (policy.bound !== "WORST_CASE" && policy.bound !== "TYPICAL_OK") || policy.missingCondition !== "HOLD")
    throw new RegistryError(`constraint "${id}": policy must be { bound: WORST_CASE | TYPICAL_OK, missingCondition: HOLD }`);
  if (conditions !== undefined && !isRecord(conditions)) throw new RegistryError(`constraint "${id}": conditions must be an object`);
  if (stressFrom !== undefined && (!isRecord(stressFrom) || typeof stressFrom.key !== "string" || kind !== "max"))
    throw new RegistryError(`constraint "${id}": stressFrom must be { key } on a max constraint`);
  const out: Constraint = {
    id,
    description,
    kind: kind as Constraint["kind"],
    limit: parseDecimal(limit, `constraint "${id}".limit`),
    affects: affects as string[],
    source,
    policy: { bound: policy.bound, missingCondition: "HOLD" },
  };
  if (conditions !== undefined) out.conditions = conditions as ConditionSet;
  if (stressFrom !== undefined) out.stressFrom = { key: (stressFrom as { key: string }).key };
  return out;
}

function parsePart(id: string, raw: unknown): PartEntry {
  if (!isRecord(raw) || !isRecord(raw.part) || !Array.isArray(raw.documents) || !Array.isArray(raw.parameters))
    throw new RegistryError(`part "${id}" must have part, documents and parameters`);
  const part = raw.part as Record<string, unknown>;
  if (part.id !== id || typeof part.manufacturer !== "string" || typeof part.mpn !== "string")
    throw new RegistryError(`part "${id}": part must be { id: "${id}", manufacturer, mpn }`);
  for (const [i, d] of (raw.documents as unknown[]).entries()) {
    if (!isRecord(d) || typeof d.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(d.sha256) || typeof d.documentId !== "string")
      throw new RegistryError(`part "${id}": documents[${i}] must have a documentId and a 64-hex sha256`);
  }
  const documents = raw.documents as DocumentRef[];
  for (const [i, p] of (raw.parameters as unknown[]).entries()) {
    if (!isRecord(p) || typeof p.key !== "string" || !Array.isArray(p.readings))
      throw new RegistryError(`part "${id}": parameters[${i}] must have a key and readings`);
    for (const [j, r] of (p.readings as unknown[]).entries()) {
      const where = `part "${id}" parameter "${p.key}" reading ${j}`;
      if (!isRecord(r) || !isRecord(r.evidence) || typeof r.qualifier !== "string" || !QUALIFIERS.includes(r.qualifier as Qualifier))
        throw new RegistryError(`${where} must have a qualifier and evidence`);
      parseDecimal(r.measurement, `${where} measurement`);
      const evidence = r.evidence as Record<string, unknown>;
      if (typeof evidence.text !== "string" || !isRecord(evidence.bbox) || !isRecord(evidence.document))
        throw new RegistryError(`${where}: evidence must carry text, a bounding box and its document`);
      const sha = (evidence.document as Record<string, unknown>).sha256;
      if (!documents.some((d) => d.sha256 === sha))
        throw new RegistryError(`${where}: its document ${String(sha)} is not among the part's documents`);
    }
  }
  return { part: part as unknown as PartRef, documents, parameters: raw.parameters as Parameter[] };
}

/** Parse and validate registry JSON text. Throws RegistryError on any malformation. */
export function parseRegistry(text: string): Registry {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new RegistryError(`registry is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw)) throw new RegistryError("registry root must be an object");
  if (raw.version !== 2) throw new RegistryError("registry version must be 2");
  if (!isRecord(raw.parts)) throw new RegistryError("registry.parts must be an object keyed by part id");
  if (!Array.isArray(raw.constraints)) throw new RegistryError("registry.constraints must be an array");
  const parts: Registry["parts"] = {};
  for (const [id, entry] of Object.entries(raw.parts)) parts[id] = parsePart(id, entry);
  const constraints = raw.constraints.map(parseConstraint);
  const ids = new Set<string>();
  for (const c of constraints) {
    if (ids.has(c.id)) throw new RegistryError(`duplicate constraint id "${c.id}"`);
    ids.add(c.id);
  }
  return { version: 2, parts, constraints };
}

function readingKey(r: Reading): string {
  return canonicalJson({ q: r.qualifier, c: conditionGroupKey(r.conditions), v: r.measurement.si_value_decimal, e: r.evidence.evidenceId, d: r.evidence.document.sha256, m: r.method.kind, by: r.contributor });
}

function withCanonical(parameter: Parameter): Parameter {
  const { canonical } = computeLadder(parameter.readings);
  return {
    ...parameter,
    canonical: canonical.map((c) => ({ qualifier: c.qualifier, conditions: c.conditions, value: c.value, status: c.status })),
  };
}

/**
 * Store admitted readings under their part and document. A reading already stored (same
 * qualifier, conditions, value, unit and contributor) is not stored twice. Returns a new
 * registry; the input is untouched.
 */
export function storeReadings(
  registry: Registry,
  part: PartRef,
  document: DocumentRef,
  readings: { key: string; reading: AdmittedReading }[],
  specs: FieldSpec[],
): Registry {
  const entry: PartEntry = registry.parts[part.id]
    ? structuredClone(registry.parts[part.id]!)
    : { part, documents: [], parameters: [] };
  if (!entry.documents.some((d) => d.sha256 === document.sha256)) entry.documents.push(document);
  for (const { key, reading } of readings) {
    if (reading.evidence.document.sha256 !== document.sha256) {
      throw new RegistryError(`reading of ${reading.evidence.evidenceId} is from another document than ${document.sha256}`);
    }
    if (!specs.some((s) => s.key === key)) throw new RegistryError(`"${key}" is not a requested field`);
    let parameter = entry.parameters.find((p) => p.key === key);
    if (!parameter) {
      parameter = { key, dimension: specs.find((s) => s.key === key)?.dimension ?? "unknown", readings: [], canonical: [] };
      entry.parameters.push(parameter);
    }
    if (!parameter.readings.some((r) => readingKey(r) === readingKey(reading))) parameter.readings.push(reading);
  }
  entry.parameters = entry.parameters.map(withCanonical);
  return { ...registry, parts: { ...registry.parts, [part.id]: entry } };
}

/**
 * Append a person's correction of a parameter's reading with this qualifier (the latest one).
 * The extracted reading is kept; the ladder makes the corrected value canonical and verified.
 */
export function correctReading(
  registry: Registry,
  partId: string,
  key: string,
  qualifier: Qualifier,
  corrected: { value: string; unit: string },
  audit: { reviewer: string; reason: string; timestampISO: string },
  evidenceId?: string,
): Registry {
  const entry = registry.parts[partId];
  if (!entry) throw new RegistryError(`no part "${partId}" to correct`);
  const index = entry.parameters.findIndex((p) => p.key === key);
  const parameter = entry.parameters[index];
  if (!parameter) throw new RegistryError(`part "${partId}" has no parameter "${key}" to correct`);
  // The latest reading with this qualifier, of the cited line when one is named.
  const readingIndex = parameter.readings
    .map((r) => r.qualifier === qualifier && (evidenceId === undefined || r.evidence.evidenceId === evidenceId))
    .lastIndexOf(true);
  if (readingIndex < 0) {
    throw new RegistryError(`parameter "${key}" of "${partId}" has no ${qualifier} reading${evidenceId ? ` of ${evidenceId}` : ""} to correct`);
  }
  let measurement: Decimal;
  try {
    measurement = parseMeasurement(corrected.value, corrected.unit);
  } catch (err) {
    throw new RegistryError(err instanceof UnitError || err instanceof Error ? err.message : String(err));
  }
  const original = parameter.readings[readingIndex]!;
  const { parameter: next } = appendCorrection(parameter, readingIndex, { measurement, qualifier, conditions: original.conditions }, audit);
  const parameters = [...entry.parameters];
  parameters[index] = withCanonical(next);
  return { ...registry, parts: { ...registry.parts, [partId]: { ...entry, parameters } } };
}

/** The engine's view of one part: one entry per canonical value, never another part's. */
export function snapshotFor(registry: Registry, partId: string): FactSnapshot {
  const entry = registry.parts[partId];
  if (!entry) return { facts: [] };
  const facts: FactSnapshotEntry[] = [];
  for (const parameter of entry.parameters) {
    for (const c of computeLadder(parameter.readings).canonical) {
      const winner =
        [...c.readings].filter((r) => r.measurement.si_value_decimal === c.value.si_value_decimal)
          .sort((a, b) => (a.addedAtISO < b.addedAtISO ? -1 : a.addedAtISO > b.addedAtISO ? 1 : 0))
          .at(-1) ?? c.readings[0]!;
      const fact: FactSnapshotEntry = {
        part: partId,
        key: parameter.key,
        qualifier: c.qualifier,
        value: c.value,
        conditions: c.conditions,
        status: c.status,
        sha256: sha256Hex(canonicalJson({ part: partId, key: parameter.key, readings: c.readings })),
        readingRef: winner.evidence.evidenceId,
        reading: winner,
      };
      if (c.frozen) fact.frozen = true;
      facts.push(fact);
    }
  }
  facts.sort((a, b) => (a.key + a.qualifier + a.sha256 < b.key + b.qualifier + b.sha256 ? -1 : 1));
  return { facts };
}

/** A measurement re-expressed exactly, for display. */
export function siOf(decimal: Decimal): string {
  return toDecimalString(siValue(decimal));
}

/**
 * Record a person's value for an extraction that never became an admitted reading (one held
 * for review): a human reading citing the same evidence unit, so the provenance stays. The
 * ladder makes it canonical and verified.
 */
export function confirmReading(
  registry: Registry,
  part: PartRef,
  document: DocumentRef,
  key: string,
  draft: { evidence: AdmittedReading["evidence"]; qualifier: Qualifier; conditions: ConditionSet },
  corrected: { value: string; unit: string },
  audit: { reviewer: string; reason: string; timestampISO: string },
  specs: FieldSpec[],
): Registry {
  let measurement: Decimal;
  try {
    measurement = parseMeasurement(corrected.value, corrected.unit);
  } catch (err) {
    throw new RegistryError(err instanceof Error ? err.message : String(err));
  }
  const reading: AdmittedReading = {
    measurement,
    qualifier: draft.qualifier,
    conditions: draft.conditions,
    confidence: 1,
    evidence: draft.evidence,
    contributor: audit.reviewer,
    method: { kind: "human" },
    validators: [`correction@1.0.0:new;reviewer=${audit.reviewer};reason=${audit.reason}`],
    addedAtISO: audit.timestampISO,
  };
  return storeReadings(registry, part, document, [{ key, reading }], specs);
}
