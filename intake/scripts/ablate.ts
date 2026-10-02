// Validator ablation over an evaluation corpus, offline from the fixture cache (eval/ablation.ts).
//
//   npx tsx scripts/ablate.ts --corpus eval/corpus-boardrepo --out eval/results/boardrepo-ablation.json

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIngestDeps, ingest } from "../adapters/ingest";
import { ablate, INTAKE_VALIDATORS, soleStops, stoppedScores, type DocumentRecords } from "../eval/ablation";
import { loadCorpus } from "../eval/corpus";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
  const dir = resolve(flag("--corpus") ?? "eval/corpus-boardrepo");
  const corpus = loadCorpus(dir);
  const deps = buildIngestDeps(join(process.cwd(), "fixtures"), { mode: "cached" });
  const documents: DocumentRecords[] = [];
  for (const doc of corpus.documents) {
    if (doc.content.kind !== "reference") continue;
    const path = join(dir, "pdfs", `${doc.content.sha256}.pdf`);
    if (!existsSync(path)) throw new Error(`no PDF for ${doc.documentId}; fetch the corpus first`);
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") !== doc.content.sha256) throw new Error(`${doc.documentId}: PDF hash differs from the corpus`);
    const result = await ingest({ fileName: `${doc.documentId}.pdf`, bytes }, deps, {
      ...(doc.pages ? { pages: doc.pages } : {}),
      specs: doc.fields.map((f) => ({ key: f.key, description: f.description, dimension: f.parameter.dimension, requiredConditions: f.parameter.requiredConditions })),
      revision: doc.revision,
    });
    documents.push({ document: doc, records: result.records });
  }

  const fired = new Set(documents.flatMap((d) => d.records.flatMap((r) => r.results.filter((v) => v.status !== "PASS").map((v) => v.validator))));
  const all = new Set([...fired, ...INTAKE_VALIDATORS, "duplicates", "range-invariants"]);
  const intake = new Set<string>(INTAKE_VALIDATORS);
  const inherited = [...fired].filter((v) => !intake.has(v) && v !== "duplicates" && v !== "range-invariants");
  const configs: { name: string; ignore: string[] }[] = [
    { name: "parse only", ignore: [...all] },
    { name: "cortex validators", ignore: [...INTAKE_VALIDATORS] },
    { name: "cortex validators + confidence routing", ignore: INTAKE_VALIDATORS.filter((v) => v !== "confidence-routing") },
    { name: "all validators", ignore: [] },
    ...INTAKE_VALIDATORS.filter((v) => fired.has(v) || v === "confidence-routing").map((v) => ({ name: `all but ${v}`, ignore: [v] })),
    ...inherited.map((v) => ({ name: `all but ${v}`, ignore: [v] })),
  ];
  const out = {
    datasetVersion: corpus.datasetVersion,
    documents: documents.length,
    extractions: documents.reduce((a, d) => a + d.records.length, 0),
    groupChecksFired: [...fired].filter((v) => v === "duplicates" || v === "range-invariants"),
    configs: configs.map((c) => ({ ...c, metrics: ablate(documents, new Set(c.ignore)) })),
    stopped: stoppedScores(documents),
    soleStops: soleStops(documents),
  };
  const target = flag("--out") ?? "eval/results/boardrepo-ablation.json";
  writeFileSync(target, JSON.stringify(out, null, 2));
  for (const c of out.configs) {
    const m = c.metrics;
    console.log(`${c.name.padEnd(40)} admitted ${String(m.admitted).padStart(3)}  correct ${String(m.correct).padStart(3)}  wrong ${String(m.wrong).padStart(3)}  precision ${m.precision.toFixed(4)}  recall ${m.recall.toFixed(4)}`);
  }
  console.log("stopped, scored as if admitted:", out.stopped);
  console.log("stopped by one validator alone:", out.soleStops);
}

void main();
