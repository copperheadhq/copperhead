// Content-addressed cache (ground-intake-extraction D9). Every key holds every input that
// produced its entry, and every entry stores that key material, so an entry is served only for
// the exact inputs that produced it. Fixture mode reads the same files.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../core/canonical";
import type { IntakeExtraction } from "../core/extraction";
import type { FieldSpec } from "../core/fields";
import type { IntakeUnit } from "../core/text/types";

export function sha256(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function short(text: string, n = 16): string {
  return sha256(text).slice(0, n);
}

export class JsonCache {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  read<T>(key: string): T | undefined {
    const file = this.path(key);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }

  /** Atomic write: temp file then rename. */
  write(key: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.path(key);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  }

  has(key: string): boolean {
    return existsSync(this.path(key));
  }

  /** Keys starting with a prefix, sorted. */
  list(prefix: string): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  }
}

function pagesKey(pages: number[] | undefined): string {
  return pages === undefined ? "all" : [...pages].sort((a, b) => a - b).join("-");
}

/** Text: the document, the sorted pages, whether OCR was forced, and the text reader version. */
export function textCacheKey(docSha: string, pages: number[] | undefined, forceOcr: boolean, reader: string): string {
  return `${docSha}.text.${pagesKey(pages)}${forceOcr ? ".ocr" : ""}.${short(reader, 8)}`;
}

/** OCR: the document, the provider, the language and the output format. */
export function ocrCacheKey(docSha: string, provider: string, language: string, format: string): string {
  return `${docSha}.ocr.${short(`${provider}|${language}|${format}`, 8)}`;
}

export interface ExtractionKeyMaterial {
  document: string;
  units: string;
  fields: string;
  model: string;
  promptHash: string;
  schemaVersion: string;
}

export interface ExtractionEntry {
  key: ExtractionKeyMaterial;
  /** Every pass for these inputs, oldest first. A new pass never replaces an old one. */
  passes: { extractions: IntakeExtraction[] }[];
}

export function unitsDigest(units: IntakeUnit[]): string {
  return sha256(canonicalJson(units.map((u) => [u.evidenceId, u.text, u.context ?? ""])));
}

export function fieldsDigest(specs: FieldSpec[]): string {
  return sha256(canonicalJson(specs));
}

/** The part of an extraction key that does not name the model, for finding fixtures. */
export function extractionInputsKey(m: Omit<ExtractionKeyMaterial, "model">): string {
  return `${m.document}.extract.${short(`${m.units}|${m.fields}|${m.promptHash}|${m.schemaVersion}`)}`;
}

export function extractionCacheKey(m: ExtractionKeyMaterial): string {
  return `${extractionInputsKey(m)}.${short(m.model, 8)}`;
}

export function sameKey(a: ExtractionKeyMaterial, b: ExtractionKeyMaterial): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
