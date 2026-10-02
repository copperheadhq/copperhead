// One-off fixture migration (ground-intake-extraction D9, D11).
//
// 1. Sarvam outputs cached under `<sha>.digitise` were all made with the provider "sarvam-vision",
//    language en-IN and output format md (adapters/sarvam.ts at 807d456), so their inputs are
//    known and they move to the complete OCR key.
// 2. Snippet-based extractions cannot be re-keyed: the prompt that produced them is not the
//    current one, and they cite text rather than units. They are deleted; the demo datasheets
//    are extracted again live. The one exception is GT-6's live capture of the 2N3055, which
//    is translated into a pointer at the OCR line holding its snippet and kept as a labelled
//    test fixture (fixtures/gt6/), never as a cache entry: it was not produced by the current
//    prompt, so the cache must not serve it as if it had been.

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DigitisedPage } from "../core/digitised";
import type { IntakeExtraction } from "../core/extraction";
import { normalizeText } from "../core/extraction";
import { ocrLines } from "../core/text/ocr";
import { mintUnits } from "../core/text/units";
import { JsonCache, ocrCacheKey } from "../adapters/cache";
import { ocrReaderVersion } from "../adapters/source-text";

const dir = join(process.cwd(), "fixtures", "cache");
const cache = new JsonCache(dir);
const GT6_SHA = "29e8559778fd6e1f1d308c82b254717065a77ecd58f161a11cb0b6dc4cc8428c";

for (const file of readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.digitise\.json$/.test(f))) {
  const sha = file.slice(0, 64);
  const pages = JSON.parse(readFileSync(join(dir, file), "utf8")) as DigitisedPage[];
  cache.write(ocrCacheKey(sha, "sarvam-vision", "en-IN", "md"), pages);
  rmSync(join(dir, file));
  console.log(`re-keyed OCR for ${sha.slice(0, 8)}`);
}

// Translate GT-6's capture before deleting it.
const oldGt6 = join(dir, `${GT6_SHA}-d4bd1e0e419a3203.extract.json`);
const captured = JSON.parse(readFileSync(oldGt6, "utf8")) as { field: string; value: number | string; unit?: string; snippet: string; confidence: number; footnoteQualified?: boolean }[];
const ocr = cache.read<DigitisedPage[]>(ocrCacheKey(GT6_SHA, "sarvam-vision", "en-IN", "md"))!;
const units = mintUnits(
  { documentId: "2n3055-scanned.pdf", sha256: GT6_SHA, authority: "MANUFACTURER" },
  ocr.map((p) => ({ page: p.page, textSource: "ocr" as const, reader: ocrReaderVersion("sarvam-vision"), lines: ocrLines(p) })),
);
const FIELD: Record<string, string> = { "absolute maximum input voltage (V)": "abs_max_vin_V" };
const translated: IntakeExtraction[] = captured.map((c) => {
  const cells = c.snippet.match(/<td[^>]*>[\s\S]*?<\/td>/g)!.map((td) => td.replace(/<[^>]+>/g, "").trim()).filter((t) => t !== "");
  const target = normalizeText(cells.join(" | "));
  const unit = units.find((u) => normalizeText(u.text).includes(target));
  if (!unit) throw new Error(`no OCR line holds the GT-6 snippet "${target}"`);
  return {
    field: FIELD[c.field] ?? c.field,
    evidenceId: unit.evidenceId,
    value: String(c.value),
    ...(c.unit !== undefined ? { unit: c.unit } : {}),
    qualifier: "ABS_MAX",
    confidence: c.confidence,
    ...(c.footnoteQualified !== undefined ? { footnoteQualified: c.footnoteQualified } : {}),
  };
});
writeFileSync(
  join(process.cwd(), "fixtures", "gt6", "2n3055.extractions.json"),
  JSON.stringify(
    {
      provenance:
        "Translated from the live claude-opus-5 capture of 2026-07-26 (fixtures/cache/29e85597...-d4bd1e0e419a3203.extract.json at 807d456): each snippet became the id of the OCR line holding it; value, unit and confidence are as captured; the qualifier ABS_MAX is the field's own.",
      model: "claude-opus-5",
      extractions: translated,
    },
    null,
    2,
  ),
);
console.log(`translated GT-6: ${translated.map((t) => `${t.field} -> ${t.evidenceId}`).join(", ")}`);

for (const file of readdirSync(dir).filter((f) => /\.extract(\.|-)|\.text\./.test(f))) {
  rmSync(join(dir, file));
  console.log(`deleted ${file}`);
}
