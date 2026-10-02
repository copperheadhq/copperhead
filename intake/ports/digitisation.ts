// The digitisation port: turn a document into structured pages with
// bounding boxes. Implementations: SarvamProvider (live), FixtureProvider
// (cached JSON, zero network).

import { DigitisedPage } from "../core/digitised";

export interface DocumentInput {
  /** File name, used for upload naming and cache diagnostics. */
  fileName: string;
  bytes: Buffer;
}

export interface DigitisationProvider {
  /** Model/backend identifier recorded in manifests. */
  readonly modelId: string;
  digitise(doc: DocumentInput): Promise<DigitisedPage[]>;
}

export class DigitiseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigitiseTimeoutError";
  }
}

export class DigitiseRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigitiseRateLimitError";
  }
}

export class DigitiseFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigitiseFailedError";
  }
}
