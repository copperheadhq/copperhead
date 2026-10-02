// FactExtractor backed by Claude Code's saved login via the Claude Agent
// SDK: no API key needed; a Claude subscription runs the extraction. Same
// contract and guardrails as the API extractor (see design D9) — the SDK
// executes nothing (tools disabled, single turn, reasoning only), and the
// core pipeline verifies every snippet regardless.
//
// Mirrors the root repo's claude-code provider (src/agent/providers/
// claude-code.ts): saved-login auth, tools disabled at three layers, and
// the billed API keys stripped from the subprocess env so a run never
// silently bills a paid key.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { IntakeExtraction } from "../core/extraction";
import type { FieldSpec } from "../core/fields";
import type { IntakeUnit } from "../core/text/types";
import { ExtractionError, FactExtractor } from "../ports/extractor";
import { buildExtractionPrompt, parseJsonReply, toExtractions } from "./extractor-common";

const JSON_INSTRUCTION = [
  "",
  "Respond with ONLY a JSON object of the shape:",
  '{ "extractions": [ { "field": string, "evidenceId": string, "value": string, "unit"?: string, "qualifier"?: "MIN"|"TYP"|"MAX"|"NOM"|"ABS_MAX", "conditions"?: { [key: string]: string }, "footnoteQualified"?: boolean, "confidence": number } ] }',
  "No prose, no markdown fences.",
].join("\n");

export class ClaudeCodeExtractor implements FactExtractor {
  readonly modelId: string;
  private readonly model: string | undefined;
  private readonly onProgress: (message: string) => void;

  constructor(options: { model?: string; onProgress?: (message: string) => void } = {}) {
    this.model = options.model ?? process.env.INTAKE_EXTRACTOR_MODEL;
    this.modelId = `claude-code${this.model ? `:${this.model}` : ""}`;
    this.onProgress = options.onProgress ?? (() => {});
  }

  async extract(units: IntakeUnit[], specs: FieldSpec[]): Promise<IntakeExtraction[]> {
    this.onProgress(
      `asking Claude (via the Claude Code saved login, no API key) to point at ${specs.length} fields among ${units.length} lines`,
    );
    const prompt = buildExtractionPrompt(units, specs) + JSON_INSTRUCTION;

    let text = "";
    try {
      for await (const msg of query({
        prompt,
        options: {
          ...(this.model ? { model: this.model } : {}),
          tools: [],
          disallowedTools: ["*"],
          canUseTool: async (toolName) => ({
            behavior: "deny",
            message: `the intake extractor is reasoning-only (blocked ${toolName})`,
            interrupt: true,
          }),
          maxTurns: 1,
          // env REPLACES the subprocess environment: inherit, but strip the
          // billed keys so the saved login always pays, never an API key.
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: undefined,
            OPENAI_API_KEY: undefined,
            // A nested Claude Code session refuses to start when it sees its parent's marker.
            CLAUDECODE: undefined,
          } as Record<string, string | undefined>,
        },
      })) {
        if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text) text += block.text;
            else if (block.type === "tool_use") {
              throw new ExtractionError(
                "claude-code extractor emitted a tool_use block despite tools being disabled; refusing to continue",
              );
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (/unauthenticat|unauthoriz|not logged in|please log in|setup-token/i.test(message)) {
        throw new ExtractionError(
          "claude-code is not authenticated: log in to Claude Code, or run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN",
        );
      }
      throw new ExtractionError(`claude-code extraction failed: ${message}`);
    }

    if (!text.trim()) throw new ExtractionError("claude-code extractor returned no text");
    const { extractions, dropped } = toExtractions(parseJsonReply(text));
    if (dropped > 0) this.onProgress(`dropped ${dropped} malformed extraction(s)`);
    return extractions;
  }
}
