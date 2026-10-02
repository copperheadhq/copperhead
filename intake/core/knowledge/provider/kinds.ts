/**
 * Provider kinds and per-kind typed interfaces (SPEC §3.1, §7).
 *
 * Core code depends only on these interfaces; vendor SDK imports are confined
 * to adapter modules under packages/providers/*.
 */

import type { EvidenceUnit, Qualifier } from "../types";

export const PROVIDER_KINDS = [
  "extraction",
  "model",
  "embedding",
  "blob",
  "index",
  "identity",
  "secrets",
  "telemetry",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderDescriptor {
  id: string;
  kind: ProviderKind;
  capabilities: string[];
  configSchema: object;
}

/** Extraction capabilities (SPEC §3.3). */
export const EXTRACTION_CAPABILITIES = [
  "per-field-confidence",
  "grounding-bbox",
  "grounding-span",
  "async-batch",
  "labeled-samples",
] as const;

export type ExtractionCapability = (typeof EXTRACTION_CAPABILITIES)[number];

/** Required for admissible readings — citation containment needs them. */
export const REQUIRED_EXTRACTION_CAPABILITIES: readonly ExtractionCapability[] =
  ["per-field-confidence", "grounding-bbox"];

// ---------------------------------------------------------------------------
// extraction (SPEC §7)
// ---------------------------------------------------------------------------

export interface FieldRequest {
  key: string;
  description: string;
  expectDimension: string;
}

export interface RawExtraction {
  rawField: string;
  value: string;
  unit?: string;
  qualifier?: Qualifier;
  /** Never inferred. */
  rawConditions?: Record<string, string>;
  confidence: number;
  /** MUST echo a supplied id. */
  evidenceId: string;
}

export interface ExtractionProvider {
  descriptor: ProviderDescriptor;
  extract(input: {
    unit: EvidenceUnit;
    fields: FieldRequest[];
  }): Promise<RawExtraction[]>;
}

// ---------------------------------------------------------------------------
// model — drafting glue only; output is mechanically re-parsed (SPEC §7)
// ---------------------------------------------------------------------------

/**
 * Token accounting, when the provider reports it. Optional because not every
 * model surface returns usage; consumers that need it (the §18 baseline
 * comparison) fall back to an explicit estimate rather than silently zero.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Actual spend, when the surface reports it (preferred over estimates). */
  costUsd?: number;
  /**
   * SERVER-SIDE web searches only. An agent surface may retrieve through its
   * own client-side tools instead, which this counter does not see — so zero
   * here does not prove the arm did not look something up. `turns` is the
   * more reliable signal that an agent did work.
   */
  webSearchRequests?: number;
  /** Agent turns taken to produce the answer; 1 for a plain completion. */
  turns?: number;
}

export interface ModelProvider {
  descriptor: ProviderDescriptor;
  complete(input: {
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<{ text: string; usage?: ModelUsage }>;
}

// ---------------------------------------------------------------------------
// embedding
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  descriptor: ProviderDescriptor;
  /** Dimensions are recorded in index metadata. */
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// blob — immutable, content-addressed (SPEC §7)
// ---------------------------------------------------------------------------

export interface BlobStore {
  descriptor: ProviderDescriptor;
  /** Returns the SHA-256 of the stored content. Never overwrites in place. */
  put(content: Uint8Array): Promise<{ sha256: string }>;
  get(sha256: string): Promise<Uint8Array>;
  has(sha256: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// index — disposable, rebuilt from git (SPEC §10)
// ---------------------------------------------------------------------------

export interface IndexStore {
  descriptor: ProviderDescriptor;
  /** Opaque handle; concrete query surface lands with the index-store package (§19 step 7). */
  raw(): unknown;
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

export interface IdentityProvider {
  descriptor: ProviderDescriptor;
  verifyToken(token: string): Promise<{ principalId: string; tenantId: string }>;
}

// ---------------------------------------------------------------------------
// secrets — references resolve here; values never live in config (SPEC §3.2)
// ---------------------------------------------------------------------------

export interface SecretStore {
  descriptor: ProviderDescriptor;
  resolve(secretRef: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// telemetry
// ---------------------------------------------------------------------------

export interface TelemetrySink {
  descriptor: ProviderDescriptor;
  emit(event: {
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }): void;
}

export interface ProviderInterfaces {
  extraction: ExtractionProvider;
  model: ModelProvider;
  embedding: EmbeddingProvider;
  blob: BlobStore;
  index: IndexStore;
  identity: IdentityProvider;
  secrets: SecretStore;
  telemetry: TelemetrySink;
}
