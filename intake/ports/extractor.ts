// The fact-extractor port (ground-intake-extraction D3): read the evidence units of the selected
// pages against the field requests and point at the unit holding each value. Implementations:
// LlmExtractor (API) and ClaudeCodeExtractor (saved login).
//
// The extractor is untrusted by construction: it returns unit ids and values as printed, never
// text or coordinates, and every extraction is validated before anything can use it.

import type { IntakeExtraction } from "../core/extraction";
import type { FieldSpec } from "../core/fields";
import type { IntakeUnit } from "../core/text/types";

export interface FactExtractor {
  /** Model identifier recorded in cache keys and manifests. */
  readonly modelId: string;
  extract(units: IntakeUnit[], specs: FieldSpec[]): Promise<IntakeExtraction[]>;
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}
