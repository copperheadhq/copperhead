// API-backed FactExtractor (design D9): claude-opus-5 through the
// Anthropic SDK with structured outputs, so the reply is schema-valid
// JSON. The extractor is untrusted: the core pipeline verifies every
// snippet against the digitised text and stitches bboxes
// deterministically, so nothing returned here can become a trusted fact
// on its own say-so.

import Anthropic from "@anthropic-ai/sdk";
import type { IntakeExtraction } from "../core/extraction";
import type { FieldSpec } from "../core/fields";
import type { IntakeUnit } from "../core/text/types";
import { ExtractionError, FactExtractor } from "../ports/extractor";
import { buildExtractionPrompt, OUTPUT_SCHEMA, toExtractions } from "./extractor-common";

const DEFAULT_MODEL = "claude-opus-5";

export class LlmExtractor implements FactExtractor {
  readonly modelId: string;
  private readonly client: Anthropic;
  private readonly onProgress: (message: string) => void;

  constructor(options: { apiKey?: string; model?: string; onProgress?: (message: string) => void } = {}) {
    this.modelId = options.model ?? process.env.INTAKE_EXTRACTOR_MODEL ?? DEFAULT_MODEL;
    this.client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();
    this.onProgress = options.onProgress ?? (() => {});
  }

  async extract(units: IntakeUnit[], specs: FieldSpec[]): Promise<IntakeExtraction[]> {
    this.onProgress(`asking ${this.modelId} to point at ${specs.length} fields among ${units.length} lines`);
    const response = await this.client.beta.messages.create({
      model: this.modelId,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: buildExtractionPrompt(units, specs) }],
    });
    if (response.stop_reason === "refusal") throw new ExtractionError("extractor model declined the request (refusal)");
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new ExtractionError("extractor returned no text content");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch (err) {
      throw new ExtractionError(`extractor output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { extractions, dropped } = toExtractions(parsed);
    if (dropped > 0) this.onProgress(`dropped ${dropped} malformed extraction(s)`);
    return extractions;
  }
}
