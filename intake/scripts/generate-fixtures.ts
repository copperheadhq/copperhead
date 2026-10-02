// Ingest a datasheet from the command line and record its text, OCR and extraction in the
// fixture cache (ground-intake-extraction D11). Live mode calls the extractor only for inputs
// never extracted, or with --new-pass; cached mode makes no network call.
//
//   npx tsx scripts/generate-fixtures.ts <pdf> [--pages 1,2] [--force-ocr] [--mode live|cached] [--new-pass] [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildIngestDeps, ingest, type IngestMode } from "../adapters/ingest";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && !/^\d/.test(a));
  if (!file) throw new Error("usage: generate-fixtures.ts <pdf> [--pages 1,2] [--force-ocr] [--mode live|cached] [--new-pass] [--json out.json]");
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const pages = flag("--pages")?.split(",").map(Number);
  const mode = (flag("--mode") ?? "live") as IngestMode;
  const fixtures = join(process.cwd(), "fixtures");
  const deps = buildIngestDeps(fixtures, { mode, onProgress: (m) => console.error(`  ${m}`) });
  const result = await ingest({ fileName: basename(file), bytes: readFileSync(file) }, deps, {
    ...(pages ? { pages } : {}),
    ...(args.includes("--force-ocr") ? { forceOcr: true } : {}),
    ...(args.includes("--new-pass") ? { newPass: true } : {}),
    onProgress: (m) => console.error(`  ${m}`),
  });
  for (const r of result.records) {
    const e = r.extraction;
    console.log(
      `${r.outcome.padEnd(15)} ${e.field.padEnd(24)} ${(e.qualifier ?? "-").padEnd(7)} ${`${e.value} ${e.unit ?? ""}`.padEnd(14)} ${e.evidenceId}  ${r.reasonCodes.join(",")}`,
    );
  }
  const out = flag("--json");
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
