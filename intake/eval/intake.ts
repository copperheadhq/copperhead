// The intake's ingester for the benchmark (ground-intake-extraction D12): each corpus PDF runs
// through the production path (text layer first, evidence units, the extractor or its cached
// output, validation), and only admitted readings are scored.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ingest, type IngestDeps } from "../adapters/ingest";
import type { FieldSpec } from "../core/fields";
import { isAdmitted } from "../core/model";
import type { CorpusDocument } from "./corpus";
import type { AdmittedReading, DocumentIngester, DocumentResult } from "./run";

export interface IntakeIngesterOptions {
  /** Directory holding each referenced PDF as <sha256>.pdf. */
  pdfDir: string;
  deps: IngestDeps;
  now: () => string;
  onProgress?: (documentId: string, message: string) => void;
}

function specsOf(doc: CorpusDocument): FieldSpec[] {
  return doc.fields.map((f) => ({
    key: f.key,
    description: f.description,
    dimension: f.parameter.dimension,
    requiredConditions: f.parameter.requiredConditions,
  }));
}

export function intakeIngester(opts: IntakeIngesterOptions): DocumentIngester {
  return async (doc) => {
    if (doc.content.kind !== "reference") return { notEvaluated: "the intake reads PDFs; this document is inline text" };
    const path = join(opts.pdfDir, `${doc.content.sha256}.pdf`);
    if (!existsSync(path)) return { notEvaluated: `no PDF at ${path}; fetch the corpus first` };
    const bytes = readFileSync(path);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== doc.content.sha256) return { notEvaluated: `PDF hash ${sha} does not match the corpus's ${doc.content.sha256}` };
    const startedAt = Date.now();
    let result;
    try {
      result = await ingest({ fileName: `${doc.documentId}.pdf`, bytes }, opts.deps, {
        ...(doc.pages ? { pages: doc.pages } : {}),
        specs: specsOf(doc),
        revision: doc.revision,
        now: opts.now,
        onProgress: (m) => opts.onProgress?.(doc.documentId, m),
      });
    } catch (err) {
      return { notEvaluated: err instanceof Error ? err.message : String(err) };
    }
    const counts: DocumentResult = {
      documentId: doc.documentId,
      admitted: 0,
      correct: 0,
      wrong: 0,
      routedToReview: 0,
      rejected: 0,
      missed: 0,
      reasonCounts: {},
    };
    const admitted: AdmittedReading[] = [];
    for (const record of result.records) {
      for (const r of record.results) {
        if (r.status !== "PASS") counts.reasonCounts![`${r.validator}:${r.status}`] = (counts.reasonCounts![`${r.validator}:${r.status}`] ?? 0) + 1;
      }
      if (isAdmitted(record) && record.duplicateOf === undefined) {
        counts.admitted++;
        admitted.push({
          document: doc,
          fieldKey: record.extraction.field,
          parameterKey: record.extraction.field,
          reading: record.reading,
          confidence: record.extraction.confidence,
        });
      } else if (record.outcome === "REVIEW_REQUIRED") counts.routedToReview++;
      else if (record.outcome === "REJECTED") counts.rejected++;
    }
    return { admitted, result: counts, elapsedMs: Date.now() - startedAt };
  };
}
