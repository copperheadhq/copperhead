// Shared builders for the intake's tests.

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonCache } from "../../adapters/cache";
import type { IngestDeps } from "../../adapters/ingest";
import type { IntakeExtraction } from "../../core/extraction";
import type { FieldSpec } from "../../core/fields";
import type { DocumentRef } from "../../core/knowledge/types";
import type { IntakeUnit } from "../../core/text/types";
import type { DigitisationProvider } from "../../ports/digitisation";
import type { FactExtractor } from "../../ports/extractor";

export function docRef(bytes: Uint8Array, documentId = "test.pdf"): DocumentRef {
  return { documentId, sha256: createHash("sha256").update(bytes).digest("hex"), authority: "MANUFACTURER" };
}

/** A unit as the core would mint it, for validator tests. */
export function unit(overrides: Partial<IntakeUnit> & { text: string }): IntakeUnit {
  return {
    evidenceId: "ev-00000000-p1-l1",
    document: { documentId: "test.pdf", sha256: "0".repeat(64), authority: "MANUFACTURER" },
    page: 1,
    bbox: { x: 0.1, y: 0.2, width: 0.6, height: 0.02 },
    textSource: "pdf-text",
    layout: { cells: [{ text: overrides.text, index: 0 }] },
    footnoteRefs: [],
    neighbors: [],
    ...overrides,
  };
}

/** An extractor that returns canned extractions and counts its calls. */
export class CannedExtractor implements FactExtractor {
  calls = 0;
  constructor(
    readonly modelId: string,
    private readonly answer: (units: IntakeUnit[], specs: FieldSpec[]) => IntakeExtraction[],
  ) {}
  async extract(units: IntakeUnit[], specs: FieldSpec[]): Promise<IntakeExtraction[]> {
    this.calls++;
    return this.answer(units, specs);
  }
}

export const NO_OCR: DigitisationProvider = {
  modelId: "sarvam-vision",
  digitise: async () => {
    throw new Error("OCR must not be called");
  },
};

export function tempDeps(extractor?: FactExtractor, ocr: DigitisationProvider = NO_OCR): IngestDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "intake-test-"));
  return {
    dir,
    cache: new JsonCache(join(dir, "cache")),
    ocr,
    ...(extractor ? { extractor } : {}),
    extractorModel: extractor?.modelId ?? "claude-code",
  };
}

export function writeSeed(dir: string, seed: unknown): string {
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify(seed));
  return path;
}

/** The id of the first unit whose text starts with a prefix. */
export function idOf(units: IntakeUnit[], prefix: string): string {
  const u = units.find((x) => x.text.startsWith(prefix));
  if (!u) throw new Error(`no unit starts with "${prefix}"`);
  return u.evidenceId;
}
