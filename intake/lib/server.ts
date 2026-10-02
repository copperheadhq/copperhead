// Server-layer composition helpers for the Next.js routes.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IngestResult } from "../adapters/ingest";
import { RegistryStore } from "../adapters/registry-store";
import type { PartRef } from "../core/model";

// Next.js loads intake/.env only; the repo keeps shared keys (SARVAM_API_KEY
// etc.) in the root .env. Load it as a fallback: already-set variables win.
function loadRootEnv(): void {
  const path = join(process.cwd(), "..", ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && match[1] && match[2] !== "" && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}
loadRootEnv();

export const DATA_DIR = join(process.cwd(), "data");
export const FIXTURES_DIR = join(process.cwd(), "fixtures");
export const REGISTRY_PATH = join(DATA_DIR, "registry.json");
const SEED_PATH = join(process.cwd(), "fixtures", "registry.seed.json");
const INGESTS_DIR = join(DATA_DIR, "ingests");

export function registryStore(): RegistryStore {
  // First run: seed the working registry from the committed starter.
  if (!existsSync(REGISTRY_PATH) && existsSync(SEED_PATH)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REGISTRY_PATH, readFileSync(SEED_PATH));
  }
  return new RegistryStore(REGISTRY_PATH);
}

export function saveUpload(fileName: string, bytes: Buffer): string {
  const dir = join(DATA_DIR, "uploads");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName.replace(/[^A-Za-z0-9._-]/g, "_"));
  writeFileSync(path, bytes);
  return path;
}

/** An ingest result kept server-side, so evaluation never trusts facts posted by a client. */
export interface StoredIngest {
  part: PartRef;
  result: IngestResult;
}

export function saveIngest(stored: StoredIngest): void {
  mkdirSync(INGESTS_DIR, { recursive: true });
  writeFileSync(join(INGESTS_DIR, `${stored.result.document.sha256}.json`), JSON.stringify(stored));
}

export function loadIngest(documentSha: string): StoredIngest | undefined {
  if (!/^[0-9a-f]{64}$/.test(documentSha)) return undefined;
  const path = join(INGESTS_DIR, `${documentSha}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as StoredIngest) : undefined;
}
