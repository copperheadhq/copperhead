// Fetch an evaluation corpus's datasheets (ground-intake-extraction D12). PDFs are never
// committed: each corpus document names its manufacturer URL and sha256, and this script
// downloads it to <corpus>/pdfs/<sha256>.pdf, refusing any file whose hash differs.
//
//   npx tsx scripts/fetch-corpus.ts eval/corpus-boardrepo

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCorpus } from "../eval/corpus";

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] ?? "eval/corpus-boardrepo");
  const corpus = loadCorpus(dir);
  const pdfs = join(dir, "pdfs");
  mkdirSync(pdfs, { recursive: true });
  let failed = 0;
  for (const doc of corpus.documents) {
    if (doc.content.kind !== "reference") continue;
    const target = join(pdfs, `${doc.content.sha256}.pdf`);
    if (existsSync(target) && createHash("sha256").update(readFileSync(target)).digest("hex") === doc.content.sha256) {
      console.log(`have     ${doc.documentId}`);
      continue;
    }
    if (!doc.content.url) {
      console.log(`no URL   ${doc.documentId}`);
      failed++;
      continue;
    }
    try {
      const res = await fetch(doc.content.url, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) copperhead-intake-eval" } });
      const bytes = Buffer.from(await res.arrayBuffer());
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== doc.content.sha256) {
        console.log(`MISMATCH ${doc.documentId}: got ${sha}; the manufacturer may have revised the document`);
        failed++;
        continue;
      }
      writeFileSync(target, bytes);
      console.log(`fetched  ${doc.documentId}`);
    } catch (err) {
      console.log(`FAILED   ${doc.documentId}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
