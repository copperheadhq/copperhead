// Fixture-backed OCR: cached Sarvam output, zero network. Extraction needs no fixture provider:
// in cached mode the ingest reads the extraction cache and never calls an extractor.

import type { DigitisedPage } from "../core/digitised";
import { DigitisationProvider, DigitiseFailedError, DocumentInput } from "../ports/digitisation";
import { JsonCache, ocrCacheKey, sha256 } from "./cache";
import { SARVAM_LANGUAGE, SARVAM_OUTPUT_FORMAT } from "./sarvam";

export class FixtureDigitisationProvider implements DigitisationProvider {
  readonly modelId = "sarvam-vision";
  constructor(private readonly cache: JsonCache) {}

  async digitise(doc: DocumentInput): Promise<DigitisedPage[]> {
    const key = ocrCacheKey(sha256(doc.bytes), this.modelId, SARVAM_LANGUAGE, SARVAM_OUTPUT_FORMAT);
    const pages = this.cache.read<DigitisedPage[]>(key);
    if (!pages) throw new DigitiseFailedError(`no OCR fixture for ${doc.fileName}; generate fixtures with a live run first`);
    return pages;
  }
}
