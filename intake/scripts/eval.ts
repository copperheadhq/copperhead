// The extraction benchmark (ground-intake-extraction D12; extraction-evaluation spec).
//
//   npm run eval -- --corpus <dir> [--release-set <name>] [--pdfs <dir>] [--live] [--out report.json]
//
// Offline by default: extractions come from the fixture cache and a document without one is
// reported as not evaluated. With --live, the extractor runs for any document not yet extracted
// and its output joins the cache under the complete keys.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildIngestDeps } from "../adapters/ingest";
import { loadCorpus } from "../eval/corpus";
import { intakeIngester } from "../eval/intake";
import { runEvaluationWith } from "../eval/run";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const corpusDir = flag("--corpus");
  if (!corpusDir) throw new Error("usage: npm run eval -- --corpus <dir> [--release-set <name>] [--pdfs <dir>] [--live] [--out report.json]");
  const corpus = loadCorpus(resolve(corpusDir));
  const releaseSet = flag("--release-set") ?? Object.keys(corpus.releaseSets)[0]!;
  const live = args.includes("--live");
  const deps = buildIngestDeps(join(process.cwd(), "fixtures"), { mode: live ? "live" : "cached" });
  const providerId = live ? deps.extractor!.modelId : "intake (cached extractions)";
  const report = await runEvaluationWith(
    corpus,
    intakeIngester({
      pdfDir: resolve(flag("--pdfs") ?? join(corpusDir, "pdfs")),
      deps,
      now: () => "2026-10-02T00:00:00.000Z",
      onProgress: (id, m) => console.error(`  ${id}: ${m}`),
    }),
    providerId,
    { releaseSet, now: () => "2026-10-02T00:00:00.000Z" },
  );
  const out = flag("--out");
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2));
  }
  const m = report.metrics;
  console.log(`corpus ${report.datasetVersion}, release set ${report.releaseSet}: ${report.documents.length} evaluated, ${report.notEvaluated?.length ?? 0} not evaluated`);
  console.log(`admitted ${m.admittedReadings}: ${m.correctReadings} correct, ${m.wrongReadings} wrong; recall ${m.fieldRecall.toFixed(3)}`);
  for (const g of report.gates) console.log(`  ${g.passed ? "pass" : "FAIL"}  ${g.gate.padEnd(30)} ${g.actual} (${g.required})`);
  console.log(report.golden ? "corpus audit passed" : `corpus audit failed: ${report.auditViolations.join("; ")}`);
  console.log(report.calibrationRecord ? "calibration record written" : "no calibration record: this run measures, it does not certify");
  for (const n of report.notEvaluated ?? []) console.log(`  not evaluated: ${n.documentId}: ${n.reason}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
