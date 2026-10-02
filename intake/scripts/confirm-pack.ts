// Confirm a part pack (add-part-pack-export):
//
//   npx tsx scripts/confirm-pack.ts <pack.yaml> <datasheet.pdf> --by "<person>" [--out <file>]
//
// Re-reads the datasheet's text (the text layer, or the intake's cached OCR for scanned pages) and
// checks that every quote in the pack (facts, typical circuit, layout guidance and the pin table's
// quote) is on its page. Only then does it write `confirmedBy`. A quote a person typed or edited is
// held to the same check as one the extractor proposed.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { buildIngestDeps } from "../adapters/ingest";
import { pdfjsVersion } from "../adapters/pdf-text";
import { readSourceText, textReaderVersion } from "../adapters/source-text";
import { sha256, textCacheKey } from "../adapters/cache";
import { type QuotedEntry, verifyQuotes } from "../core/pack";
import type { SourcePage } from "../core/text/types";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [packPath, pdf] = args;
  const by = flag("--by")?.trim();
  if (!packPath || !pdf || !by) throw new Error('usage: scripts/confirm-pack.ts <pack.yaml> <pdf> --by "<person>" [--out file]');
  const doc = parseDocument(readFileSync(packPath, "utf8"));
  if (doc.errors.length) throw new Error(`${packPath} is not valid YAML: ${doc.errors[0]?.message}`);
  const pack = doc.toJS() as Record<string, unknown>;
  const bytes = readFileSync(pdf);
  const sha = sha256(bytes);
  const stated = (pack.source as { sha256?: string } | undefined)?.sha256;
  if (stated && stated !== sha) throw new Error(`the pack cites a document with sha256 ${stated}; ${pdf} is ${sha}`);

  // The page text: the intake's cache when it holds this document, else the text layer.
  const deps = buildIngestDeps(join(process.cwd(), "fixtures"), { mode: "cached" });
  const cached = deps.cache.read<SourcePage[]>(textCacheKey(sha, undefined, false, textReaderVersion(await pdfjsVersion())));
  const pages = cached ?? (await readSourceText(new Uint8Array(bytes))).pages;
  const text = new Map(pages.map((p) => [p.page, p.lines.map((l) => l.text).join("\n")]));

  const entries: QuotedEntry[] = [];
  for (const key of ["facts", "circuit", "layout"] as const) {
    const list = pack[key];
    if (!Array.isArray(list)) continue;
    list.forEach((e: Record<string, unknown>, i) => entries.push({ where: `${key}[${i}]`, page: String(e.page ?? ""), quote: String(e.quote ?? "") }));
  }
  const pinsAt = pack.pinsAt as { page?: unknown; quote?: unknown } | undefined;
  if (pinsAt?.quote !== undefined) entries.push({ where: "pinsAt", page: String(pinsAt.page ?? ""), quote: String(pinsAt.quote) });
  const problems = verifyQuotes(entries, (p) => text.get(p));
  if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    throw new Error(`${problems.length} of ${entries.length} quote(s) are not on their pages; not confirmed`);
  }
  doc.set("confirmedBy", by);
  const out = flag("--out") ?? packPath;
  writeFileSync(out, doc.toString({ lineWidth: 0 }));
  console.error(`all ${entries.length} quote(s) found on their pages; confirmed by ${by} in ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
