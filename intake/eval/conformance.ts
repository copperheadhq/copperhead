// The intake's extractors as cortex extraction providers (ground-intake-extraction D12; task
// 10.4), so cortex's conformance suite (golden pages, a prompt-injection page, a forged-evidence
// page) runs against them unchanged.

import type { ExtractionProvider, FieldRequest, RawExtraction } from "../core/knowledge/provider/kinds";
import type { EvidenceUnit } from "../core/knowledge/types";
import type { FieldSpec } from "../core/fields";
import type { IntakeUnit } from "../core/text/types";
import type { FactExtractor } from "../ports/extractor";

function asIntakeUnit(unit: EvidenceUnit): IntakeUnit {
  return {
    ...unit,
    textSource: "pdf-text",
    layout: { cells: unit.text.split(" | ").map((text, index) => ({ text, index })) },
    footnoteRefs: [],
    neighbors: unit.context ? [unit.context] : [],
  };
}

function asSpec(field: FieldRequest): FieldSpec {
  return { key: field.key, description: field.description, dimension: field.expectDimension, requiredConditions: [] };
}

export function asExtractionProvider(extractor: FactExtractor): ExtractionProvider {
  return {
    descriptor: { id: extractor.modelId, kind: "extraction", capabilities: ["per-field-confidence", "grounding-bbox"], configSchema: {} },
    async extract({ unit, fields }) {
      const extractions = await extractor.extract([asIntakeUnit(unit)], fields.map(asSpec));
      return extractions.map((e): RawExtraction => {
        const raw: RawExtraction = { rawField: e.field, value: e.value, confidence: e.confidence, evidenceId: e.evidenceId };
        if (e.unit !== undefined) raw.unit = e.unit;
        if (e.qualifier !== undefined) raw.qualifier = e.qualifier;
        if (e.conditions !== undefined) raw.rawConditions = e.conditions;
        return raw;
      });
    },
  };
}
