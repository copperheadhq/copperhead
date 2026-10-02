// Per-reading detail of an evaluation corpus, for review and for the showcase: every extraction
// with its outcome, reason codes, cited line and box, and, for admitted readings, whether it
// matches a label. Offline: extractions come from the fixture cache.
//
//   npx tsx scripts/eval-details.ts --corpus eval/corpus-boardrepo --out eval/results/boardrepo-details.json

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIngestDeps, ingest } from "../adapters/ingest";
import { isAdmitted } from "../core/model";
import { loadCorpus } from "../eval/corpus";
import { scoreReading } from "../eval/metrics";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
  const dir = resolve(flag("--corpus") ?? "eval/corpus-boardrepo");
  const corpus = loadCorpus(dir);
  const deps = buildIngestDeps(join(process.cwd(), "fixtures"), { mode: "cached" });
  const out = [];
  for (const doc of corpus.documents) {
    if (doc.content.kind !== "reference") continue;
    const path = join(dir, "pdfs", `${doc.content.sha256}.pdf`);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") !== doc.content.sha256) continue;
    let result;
    try {
      result = await ingest({ fileName: `${doc.documentId}.pdf`, bytes }, deps, {
        ...(doc.pages ? { pages: doc.pages } : {}),
        specs: doc.fields.map((f) => ({ key: f.key, description: f.description, dimension: f.parameter.dimension, requiredConditions: f.parameter.requiredConditions })),
        revision: doc.revision,
      });
    } catch (err) {
      out.push({ documentId: doc.documentId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const labels = doc.labels.adjudicated.fields;
    out.push({
      documentId: doc.documentId,
      vendor: doc.vendor,
      mpn: doc.mpn,
      url: doc.content.url,
      boards: doc.content.note,
      pages: result.pages,
      extractorModel: result.extractorModel,
      units: result.units.length,
      labelled: Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, v === "ABSENT" ? 0 : Array.isArray(v) ? v.length : 1])),
      records: result.records.map((r) => {
        const score = isAdmitted(r) && r.duplicateOf === undefined && labels[r.extraction.field] !== undefined ? scoreReading(r.reading, labels[r.extraction.field]!) : undefined;
        return {
          field: r.extraction.field,
          qualifier: r.extraction.qualifier ?? null,
          value: r.extraction.value,
          unit: r.extraction.unit ?? null,
          conditions: r.extraction.conditions ?? null,
          confidence: r.extraction.confidence,
          outcome: r.outcome,
          duplicate: r.duplicateOf !== undefined,
          reasonCodes: r.reasonCodes,
          failed: r.results.filter((v) => v.status !== "PASS").map((v) => ({ validator: v.validator, status: v.status, detail: v.detail ?? "" })),
          evidenceId: r.extraction.evidenceId,
          line: r.unit?.text ?? null,
          page: r.unit?.page ?? null,
          bbox: r.unit?.bbox ?? null,
          correct: score === undefined ? null : score.valueCorrect,
          citationCorrect: score === undefined ? null : score.citationCorrect,
        };
      }),
    });
  }
  const target = flag("--out") ?? "eval/results/boardrepo-details.json";
  writeFileSync(target, JSON.stringify(out, null, 2));
  console.log(`${out.length} documents written to ${target}`);
}

void main();
