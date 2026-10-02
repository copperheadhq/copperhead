// Run cortex's extraction-provider conformance suite against the intake's live extractor.
//
//   npx tsx scripts/conformance.ts [--out report.json]

import { writeFileSync } from "node:fs";
import { buildIngestDeps } from "../adapters/ingest";
import { runConformanceSuite } from "../core/knowledge/conformance";
import { asExtractionProvider } from "../eval/conformance";

async function main(): Promise<void> {
  const deps = buildIngestDeps("fixtures", { mode: "live", onProgress: (m) => console.error(`  ${m}`) });
  const report = await runConformanceSuite(asExtractionProvider(deps.extractor!));
  const i = process.argv.indexOf("--out");
  if (i >= 0) writeFileSync(process.argv[i + 1]!, JSON.stringify(report, null, 2));
  console.log(`${report.providerId}: ${report.passed ? "PASSED" : "FAILED"}`);
  for (const f of report.failures) console.log(`  ${f.fixture} ${f.check}: ${f.detail}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
