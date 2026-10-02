// RegistryStore: the registry file with atomic writes, and the registry-memory operations
// (ground-intake-extraction D6): store admitted readings under their part and document, and
// record a person's corrections as human readings.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FieldSpec } from "../core/fields";
import type { ConditionSet, DocumentRef, Qualifier } from "../core/knowledge/types";
import { isAdmitted, type AdmittedReading, type ExtractionRecord, type PartRef, type Registry } from "../core/model";
import { confirmReading, correctReading, parseRegistry, RegistryError, storeReadings } from "../core/registry";

export class RegistryStore {
  constructor(private readonly path: string) {}

  /** Fail closed: a missing or malformed registry is an error, never a default. */
  load(): Registry {
    if (!existsSync(this.path)) throw new RegistryError(`registry not found at ${this.path}`);
    return parseRegistry(readFileSync(this.path, "utf8"));
  }

  save(registry: Registry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2));
    renameSync(tmp, this.path);
  }

  /** The registry with a part's admitted readings added, not yet saved. */
  withReadings(registry: Registry, part: PartRef, document: DocumentRef, records: ExtractionRecord[], specs: FieldSpec[]): Registry {
    const admitted = records
      .filter((r): r is ExtractionRecord & { reading: AdmittedReading } => isAdmitted(r) && r.duplicateOf === undefined)
      .map((r) => ({ key: r.extraction.field, reading: r.reading }));
    return storeReadings(registry, part, document, admitted, specs);
  }

  /** True when the part already holds a reading of every key (reuse without extraction). */
  hasReadings(partId: string, keys: string[]): boolean {
    const entry = this.load().parts[partId];
    return entry !== undefined && keys.every((k) => entry.parameters.some((p) => p.key === k && p.readings.length > 0));
  }

  correct(
    partId: string,
    key: string,
    qualifier: Qualifier,
    corrected: { value: string; unit: string },
    audit: { reviewer: string; reason: string; timestampISO: string },
    evidenceId?: string,
  ): Registry {
    const next = correctReading(this.load(), partId, key, qualifier, corrected, audit, evidenceId);
    this.save(next);
    return next;
  }

  confirm(
    part: PartRef,
    document: DocumentRef,
    key: string,
    draft: { evidence: AdmittedReading["evidence"]; qualifier: Qualifier; conditions: ConditionSet },
    corrected: { value: string; unit: string },
    audit: { reviewer: string; reason: string; timestampISO: string },
    specs: FieldSpec[],
  ): Registry {
    const next = confirmReading(this.load(), part, document, key, draft, corrected, audit, specs);
    this.save(next);
    return next;
  }
}
