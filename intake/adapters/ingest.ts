// Ingestion (ground-intake-extraction D2, D3, D9): source text (text layer first, OCR only where
// needed), evidence units, extraction (cache first; live only for inputs never extracted, or on
// an explicit new pass), then validation. Providers are built lazily, so a warm cache needs no
// keys, and cached mode never calls a provider.

import { join } from "node:path";
import type { DigitisedPage } from "../core/digitised";
import { EXTRACTION_SCHEMA_VERSION, type IntakeExtraction } from "../core/extraction";
import { DEFAULT_FIELD_SPECS, type FieldSpec } from "../core/fields";
import type { DocumentRef } from "../core/knowledge/types";
import type { ExtractionRecord, PageSource } from "../core/model";
import type { IntakeUnit, SourcePage } from "../core/text/types";
import { mintUnits } from "../core/text/units";
import { validateExtractions } from "../core/validate";
import { DigitisationProvider, DocumentInput } from "../ports/digitisation";
import { ExtractionError, FactExtractor } from "../ports/extractor";
import {
  extractionCacheKey,
  extractionInputsKey,
  fieldsDigest,
  JsonCache,
  ocrCacheKey,
  sameKey,
  sha256,
  textCacheKey,
  unitsDigest,
  type ExtractionEntry,
  type ExtractionKeyMaterial,
} from "./cache";
import { ClaudeCodeExtractor } from "./claude-code-extractor";
import { PROMPT_TEMPLATE_HASH } from "./extractor-common";
import { FixtureDigitisationProvider } from "./fixtures";
import { LlmExtractor } from "./llm-extractor";
import { pdfjsVersion } from "./pdf-text";
import { SARVAM_LANGUAGE, SARVAM_OUTPUT_FORMAT, SarvamProvider } from "./sarvam";
import { readSourceText, textReaderVersion } from "./source-text";

export type IngestMode = "cached" | "live";

export interface IngestDeps {
  cache: JsonCache;
  ocr: DigitisationProvider;
  /** Absent in cached mode: a cache miss is then an error, never a model call. */
  extractor?: FactExtractor;
  /** The extractor's model id, known without constructing it. */
  extractorModel: string;
}

export interface IngestOptions {
  /** 1-based pages to read; all pages when omitted. */
  pages?: number[];
  forceOcr?: boolean;
  specs?: FieldSpec[];
  /** The document's revision, recorded on its DocumentRef. */
  revision?: string;
  /** Extract again for inputs already extracted, recording a new pass beside the old ones. */
  newPass?: boolean;
  onProgress?: (message: string) => void;
  /** Injected clock for readings' addedAtISO; core never reads the clock. */
  now?: () => string;
}

export interface IngestResult {
  document: DocumentRef;
  pages: PageSource[];
  units: IntakeUnit[];
  extractions: IntakeExtraction[];
  records: ExtractionRecord[];
  extractorModel: string;
  promptHash: string;
  /** Set when any page was read by OCR. */
  ocrModel?: string;
  /** How many passes the extraction cache holds for these inputs. */
  passes: number;
  /** After a new pass: the extractions that differ from the previous pass. */
  changedSincePreviousPass?: { added: IntakeExtraction[]; removed: IntakeExtraction[] };
}

export interface BuildDepsOptions {
  /** "cached" uses only the cache (zero network); "live" calls providers on a miss; default: env. */
  mode?: IngestMode;
  onProgress?: (message: string) => void;
}

function extractorChoice(): "api" | "claude-code" {
  const forced = process.env.INTAKE_EXTRACTOR;
  if (forced === "api" || forced === "claude-code") return forced;
  return process.env.ANTHROPIC_API_KEY ? "api" : "claude-code";
}

export function extractorModelId(): string {
  const model = process.env.INTAKE_EXTRACTOR_MODEL;
  return extractorChoice() === "api" ? (model ?? "claude-opus-5") : `claude-code${model ? `:${model}` : ""}`;
}

export function buildIngestDeps(fixturesDir: string, opts: BuildDepsOptions = {}): IngestDeps {
  const cache = new JsonCache(join(fixturesDir, "cache"));
  const onProgress = opts.onProgress ?? (() => {});
  const cached = opts.mode ? opts.mode === "cached" : process.env.USE_FIXTURES === "true";
  if (cached) return { cache, ocr: new FixtureDigitisationProvider(cache), extractorModel: extractorModelId() };
  const model = extractorModelId();
  return {
    cache,
    ocr: {
      modelId: "sarvam-vision",
      digitise: (d) => new SarvamProvider({ workDir: join(fixturesDir, "cache"), onProgress }).digitise(d),
    },
    extractor: {
      modelId: model,
      extract: (units, specs) =>
        (extractorChoice() === "api" ? new LlmExtractor({ onProgress }) : new ClaudeCodeExtractor({ onProgress })).extract(units, specs),
    },
    extractorModel: model,
  };
}

function diff(previous: IntakeExtraction[], next: IntakeExtraction[]): { added: IntakeExtraction[]; removed: IntakeExtraction[] } {
  const key = (e: IntakeExtraction) => JSON.stringify([e.field, e.evidenceId, e.value, e.unit, e.qualifier]);
  const before = new Set(previous.map(key));
  const after = new Set(next.map(key));
  return { added: next.filter((e) => !before.has(key(e))), removed: previous.filter((e) => !after.has(key(e))) };
}

export async function ingest(doc: DocumentInput, deps: IngestDeps, opts: IngestOptions = {}): Promise<IngestResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const specs = opts.specs ?? DEFAULT_FIELD_SPECS;
  const docSha = sha256(doc.bytes);
  const document: DocumentRef = {
    documentId: doc.fileName,
    sha256: docSha,
    ...(opts.revision !== undefined ? { revision: opts.revision } : {}),
    authority: "MANUFACTURER",
  };

  // 1. Source text, cached under the document, the pages, forced OCR and the reader version.
  const reader = textReaderVersion(await pdfjsVersion());
  const textKey = textCacheKey(docSha, opts.pages, opts.forceOcr ?? false, reader);
  let pages = deps.cache.read<SourcePage[]>(textKey);
  let ocrModel: string | undefined;
  if (pages) {
    onProgress(`page text served from cache (${pages.length} pages)`);
  } else {
    const ocrKey = ocrCacheKey(docSha, deps.ocr.modelId, SARVAM_LANGUAGE, SARVAM_OUTPUT_FORMAT);
    const digitise = async (): Promise<DigitisedPage[]> => {
      const cachedOcr = deps.cache.read<DigitisedPage[]>(ocrKey);
      if (cachedOcr) return cachedOcr;
      onProgress(`a page has no usable text layer: digitising ${doc.fileName} with ${deps.ocr.modelId}`);
      const digitised = await deps.ocr.digitise(doc);
      deps.cache.write(ocrKey, digitised);
      return digitised;
    };
    const text = await readSourceText(new Uint8Array(doc.bytes), {
      ...(opts.pages ? { pages: opts.pages } : {}),
      ...(opts.forceOcr ? { forceOcr: true } : {}),
      digitise,
      ocrModel: deps.ocr.modelId,
    });
    pages = text.pages;
    deps.cache.write(textKey, pages);
    onProgress(
      `read ${pages.length} page(s): ${pages.filter((p) => p.textSource === "pdf-text").length} from the text layer, ${pages.filter((p) => p.textSource === "ocr").length} by OCR`,
    );
  }
  if (pages.some((p) => p.textSource === "ocr")) ocrModel = deps.ocr.modelId;

  // 2. Evidence units, minted by the core.
  const units = mintUnits(document, pages);
  onProgress(`minted ${units.length} evidence units`);

  // 3. Extraction, under every input that produced it.
  const material: Omit<ExtractionKeyMaterial, "model"> = {
    document: docSha,
    units: unitsDigest(units),
    fields: fieldsDigest(specs),
    promptHash: PROMPT_TEMPLATE_HASH,
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
  };
  let entry: ExtractionEntry | undefined;
  let key: string;
  let changed: IngestResult["changedSincePreviousPass"];
  if (!deps.extractor) {
    const found = deps.cache
      .list(extractionInputsKey(material))
      .map((k) => ({ k, e: deps.cache.read<ExtractionEntry>(k)! }))
      .filter(({ e }) => sameKey(e.key, { ...material, model: e.key.model }));
    const pick = found.find(({ e }) => e.key.model === deps.extractorModel) ?? (found.length === 1 ? found[0] : undefined);
    if (!pick) {
      throw new ExtractionError(
        found.length === 0
          ? `no cached extraction for ${doc.fileName} with these pages, fields and prompt; run live once`
          : `several cached extractions for ${doc.fileName}; set INTAKE_EXTRACTOR_MODEL to one of ${found.map(({ e }) => e.key.model).join(", ")}`,
      );
    }
    key = pick.k;
    entry = pick.e;
    onProgress(`extraction served from cache (${entry.key.model}, ${entry.passes.length} pass(es))`);
  } else {
    const full: ExtractionKeyMaterial = { ...material, model: deps.extractor.modelId };
    key = extractionCacheKey(full);
    entry = deps.cache.read<ExtractionEntry>(key);
    if (entry && !sameKey(entry.key, full)) throw new ExtractionError(`cache entry ${key} holds different key material`);
    if (!entry || opts.newPass) {
      onProgress(`extracting ${specs.length} fields with ${deps.extractor.modelId}`);
      const extractions = await deps.extractor.extract(units, specs);
      const previous = entry?.passes.at(-1)?.extractions;
      entry = { key: full, passes: [...(entry?.passes ?? []), { extractions }] };
      deps.cache.write(key, entry);
      if (previous) changed = diff(previous, extractions);
      onProgress(`extractor returned ${extractions.length} extraction(s)`);
    } else {
      onProgress(`extraction served from cache (${entry.passes.length} pass(es))`);
    }
  }
  const extractions = entry.passes.at(-1)!.extractions;

  // 4. Validation.
  const records = validateExtractions(extractions, units, {
    specs,
    knownDocuments: new Map([[docSha, document]]),
    contributor: entry.key.model,
    provider: { id: entry.key.model },
    now: opts.now ?? (() => "1970-01-01T00:00:00.000Z"),
  });
  const count = (o: string) => records.filter((r) => r.outcome === o).length;
  onProgress(`${count("ADMITTED")} admitted, ${count("REVIEW_REQUIRED")} for review, ${count("REJECTED")} rejected`);

  const result: IngestResult = {
    document,
    pages: pages.map((p) => ({ page: p.page, textSource: p.textSource, reader: p.reader })),
    units,
    extractions,
    records,
    extractorModel: entry.key.model,
    promptHash: PROMPT_TEMPLATE_HASH,
    passes: entry.passes.length,
  };
  if (ocrModel !== undefined) result.ocrModel = ocrModel;
  if (changed) result.changedSincePreviousPass = changed;
  return result;
}
