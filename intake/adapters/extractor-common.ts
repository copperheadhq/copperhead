// Shared by the API and Claude Code extractors (ground-intake-extraction D3): the prompt, which
// lists the evidence units by id; the output schema, which has no room for text or coordinates;
// the prompt template hash recorded in cache keys and manifests; and the defensive re-validation
// of what a model returns.

import { createHash } from "node:crypto";
import { EXTRACTION_SCHEMA_VERSION, QUALIFIERS, type IntakeExtraction } from "../core/extraction";
import type { FieldSpec } from "../core/fields";
import type { Qualifier } from "../core/knowledge/types";
import type { IntakeUnit } from "../core/text/types";
import { ExtractionError } from "../ports/extractor";

const INSTRUCTIONS = [
  "You are reading a component datasheet and pointing at where each requested parameter is printed.",
  "",
  "The datasheet is given as numbered lines, each with its id in square brackets. Table rows show their cells separated by \" | \", and a table's header row appears above its rows. A footnote marker on a line is shown as [^n].",
  "",
  "Report every requested field you can find, one entry per printed value, with:",
  "- field: the field key, exactly as requested.",
  "- evidenceId: the id of the line that holds the value. Use only ids from the list; never invent one.",
  "- value: the value exactly as printed in that line, character for character (keep \"–0.3\", \"1,100\" or \"nine\" as printed).",
  "- unit: the unit exactly as printed, in that line or in the table's unit column. When the row's unit cell is empty because one unit cell spans several rows, report the unit printed in that spanning cell.",
  "- qualifier: MIN, TYP, MAX or NOM from the table column the value sits under; ABS_MAX for a value in an absolute maximum ratings table. Omit it when the line does not say.",
  "- conditions: test conditions printed for this value, as key/value pairs whose keys are only VCC, VDD, VIN, TA, TJ, F, IOUT or ILOAD (for example {\"VCC\": \"5 V\", \"TA\": \"25 °C\"}). Leave out any other condition.",
  "- footnoteQualified: true when a footnote on the value changes its meaning.",
  "- confidence: 0 to 1, how sure you are that the line, value, unit and qualifier are right.",
  "",
  "Rules:",
  "- A value printed as a range (\"4.5 to 16\") is two entries, MIN and MAX, citing the same line.",
  "- Report a value only if it is printed in the line you cite. Do not compute, convert or infer values.",
  "- Omit fields you cannot find. Do not guess.",
].join("\n");

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["extractions"],
  properties: {
    extractions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "evidenceId", "value", "confidence"],
        properties: {
          field: { type: "string", description: "The requested field key" },
          evidenceId: { type: "string", description: "The id of the line holding the value" },
          value: { type: "string", description: "The value exactly as printed" },
          unit: { type: "string", description: "The unit exactly as printed" },
          qualifier: { type: "string", enum: [...QUALIFIERS] },
          conditions: { type: "object", additionalProperties: { type: "string" } },
          footnoteQualified: { type: "boolean" },
          confidence: { type: "number" },
        },
      },
    },
  },
} as const;

/** The hash of the prompt template and output schema, recorded with every extraction. */
export const PROMPT_TEMPLATE_HASH = createHash("sha256")
  .update(INSTRUCTIONS)
  .update(JSON.stringify(OUTPUT_SCHEMA))
  .update(EXTRACTION_SCHEMA_VERSION)
  .digest("hex")
  .slice(0, 16);

function unitLine(u: IntakeUnit): string {
  const refs = u.footnoteRefs.length > 0 ? ` ${u.footnoteRefs.map((r) => `[^${r}]`).join("")}` : "";
  return `[${u.evidenceId}] ${u.text}${refs}`;
}

export function buildExtractionPrompt(units: IntakeUnit[], specs: FieldSpec[]): string {
  const pages = [...new Set(units.map((u) => u.page))];
  const body = pages
    .map((p) => [`--- page ${p} ---`, ...units.filter((u) => u.page === p).map(unitLine)].join("\n"))
    .join("\n\n");
  return [
    INSTRUCTIONS,
    "",
    "Requested fields:",
    ...specs.map((s) => `- ${s.key}: ${s.description}`),
    "",
    "Datasheet lines:",
    body,
  ].join("\n");
}

const KEYS = new Set(["field", "evidenceId", "value", "unit", "qualifier", "conditions", "footnoteQualified", "confidence"]);

/**
 * Validate a parsed { extractions: [...] } payload. An entry with a key outside the schema (a
 * snippet, a box), a wrong type, or a confidence outside 0..1 is dropped and counted.
 */
export function toExtractions(parsed: unknown): { extractions: IntakeExtraction[]; dropped: number } {
  const list = (parsed as { extractions?: unknown[] })?.extractions;
  if (!Array.isArray(list)) throw new ExtractionError("extractor output has no extractions array");
  const extractions: IntakeExtraction[] = [];
  let dropped = 0;
  for (const raw of list) {
    const e = raw as Record<string, unknown>;
    const ok =
      typeof raw === "object" && raw !== null &&
      Object.keys(e).every((k) => KEYS.has(k)) &&
      typeof e.field === "string" && typeof e.evidenceId === "string" &&
      (typeof e.value === "string" || typeof e.value === "number") &&
      typeof e.confidence === "number" && e.confidence >= 0 && e.confidence <= 1 &&
      (e.unit === undefined || typeof e.unit === "string") &&
      (e.qualifier === undefined || QUALIFIERS.includes(e.qualifier as Qualifier)) &&
      (e.footnoteQualified === undefined || typeof e.footnoteQualified === "boolean") &&
      (e.conditions === undefined ||
        (typeof e.conditions === "object" && e.conditions !== null && Object.values(e.conditions).every((v) => typeof v === "string")));
    if (!ok) {
      dropped++;
      continue;
    }
    const out: IntakeExtraction = {
      field: e.field as string,
      evidenceId: e.evidenceId as string,
      value: String(e.value),
      confidence: e.confidence as number,
    };
    if (e.unit !== undefined) out.unit = e.unit as string;
    if (e.qualifier !== undefined) out.qualifier = e.qualifier as Qualifier;
    if (e.conditions !== undefined && Object.keys(e.conditions as object).length > 0) out.conditions = e.conditions as Record<string, string>;
    if (e.footnoteQualified !== undefined) out.footnoteQualified = e.footnoteQualified as boolean;
    extractions.push(out);
  }
  return { extractions, dropped };
}

/** Parse JSON out of a model reply that may wrap it in fences or prose. */
export function parseJsonReply(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ExtractionError("extractor reply contains no JSON object");
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch (err) {
    throw new ExtractionError(`extractor reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
