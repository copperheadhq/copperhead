// The intake's data model (ground-intake-extraction D5): cortex's readings, parameters and
// verdicts, plus the intake's parts, registry, change descriptors and extraction records.
// Pure: no I/O, no SDK, no framework.

import type {
  Constraint,
  DocumentRef,
  Parameter,
  Reading,
  ReasonCode,
  Verdict,
  VerificationManifest,
} from "./knowledge/types";
import type { ValidatorResult } from "./knowledge/validators/pipeline";
import type { IntakeExtraction } from "./extraction";
import type { Box, IntakeUnit, TextSource } from "./text/types";

export type {
  ConditionSet,
  Constraint,
  Decimal,
  DocumentRef,
  Parameter,
  Qualifier,
  Reading,
  ReasonCode,
  Verdict,
} from "./knowledge/types";

/** Confidence below this routes an otherwise admitted extraction to review; it never admits. */
export const CONFIDENCE_THRESHOLD = 0.75;

// --- Parts ---

export interface PartRef {
  /** "manufacturer:mpn". */
  id: string;
  manufacturer: string;
  mpn: string;
}

export function partRef(manufacturer: string, mpn: string): PartRef {
  return { id: `${manufacturer}:${mpn}`, manufacturer, mpn };
}

// --- Readings ---

/** A reading the intake made: its evidence is an intake unit. */
export interface IntakeReading extends Reading {
  evidence: IntakeUnit;
}

/** An admitted reading: its evidence has text and a bounding box. Only validation builds one. */
export interface AdmittedReading extends IntakeReading {
  evidence: IntakeUnit & { bbox: Box };
}

export type Outcome = "ADMITTED" | "REVIEW_REQUIRED" | "REJECTED";

/** One extraction's fate: its outcome, every validator's result, and its reading when it has one. */
export interface ExtractionRecord {
  extraction: IntakeExtraction;
  outcome: Outcome;
  reasonCodes: ReasonCode[];
  results: ValidatorResult[];
  /** The unit it cited, when that unit exists. */
  unit?: IntakeUnit;
  /** Present for ADMITTED, and for REVIEW_REQUIRED when the value parsed. */
  reading?: IntakeReading;
  /** Set when an identical admitted reading of the same unit was kept instead of this one. */
  duplicateOf?: number;
}

export function isAdmitted(record: ExtractionRecord): record is ExtractionRecord & { reading: AdmittedReading } {
  return record.outcome === "ADMITTED" && record.reading !== undefined && record.reading.evidence.bbox !== undefined;
}

// --- Registry ---

export interface PartEntry {
  part: PartRef;
  documents: DocumentRef[];
  parameters: Parameter[];
}

export interface Registry {
  version: 2;
  /** Keyed by part id. A reading belongs to exactly one part and one document. */
  parts: Record<string, PartEntry>;
  constraints: Constraint[];
}

// --- Change descriptors ---

export type ChangeKind = "add_component" | "connect_rail" | "swap_part";

export interface Contribution {
  factKey: string;
  /**
   * A value the change applies, such as a pull-up's draw or a rail's voltage. Without a value,
   * the contribution names a parameter of the evaluated part.
   */
  value?: number;
  unit?: string;
}

export interface ChangeDescriptor {
  kind: ChangeKind;
  /** Human-readable label, e.g. "add 100k pull-up on GPIO12". */
  label: string;
  contributions: Contribution[];
}

// --- Manifest ---

export interface PageSource {
  page: number;
  textSource: TextSource;
  reader: string;
}

export interface IntakeManifest {
  /** Injected by the caller; core never reads the clock. */
  timestampISO: string;
  decisionRunId: string;
  part: string;
  change: string;
  checksRun: string[];
  document?: { documentId: string; sha256: string; revision?: string };
  pages: PageSource[];
  extraction: { extractorModel: string; promptHash: string; schemaVersion: string; ocrModel?: string };
  validators: string[];
  factVersions: VerificationManifest["factVersions"];
  verdict: Verdict;
  /** The exact inputs needed to reproduce the verdict. */
  inputs: {
    descriptor: ChangeDescriptor;
    constraints: Constraint[];
    snapshot: import("./knowledge/verdict/types").FactSnapshot;
    ruleVersion: string;
  };
}
