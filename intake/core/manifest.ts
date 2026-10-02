// The verification manifest (ground-intake-extraction D8): what ran, on which document and
// pages, with which model and prompt, and the exact inputs that reproduce the verdict. Pure:
// the timestamp and run id are injected by the caller.

import { canonicalJson } from "./canonical";
import { evaluateChange, type EvaluateResult } from "./evaluate";
import type { ChangeDescriptor, Constraint, IntakeManifest, PageSource } from "./model";
import type { DocumentRef } from "./knowledge/types";
import type { EngineContext, FactSnapshot } from "./knowledge/verdict/types";

export interface ManifestInputs {
  timestampISO: string;
  decisionRunId: string;
  partId: string;
  descriptor: ChangeDescriptor;
  constraints: Constraint[];
  snapshot: FactSnapshot;
  result: EvaluateResult;
  ruleVersion: string;
  document?: DocumentRef;
  pages: PageSource[];
  extraction: IntakeManifest["extraction"];
  validators: string[];
}

export function buildManifest(inputs: ManifestInputs): IntakeManifest {
  const manifest: IntakeManifest = {
    timestampISO: inputs.timestampISO,
    decisionRunId: inputs.decisionRunId,
    part: inputs.partId,
    change: inputs.descriptor.label,
    checksRun: inputs.result.checks.map((c) => c.verdict.citedConstraint?.id ?? "").filter((id) => id !== ""),
    pages: inputs.pages,
    extraction: inputs.extraction,
    validators: inputs.validators,
    factVersions: inputs.result.checks.flatMap((c) => c.manifest.factVersions),
    verdict: inputs.result.verdict,
    inputs: { descriptor: inputs.descriptor, constraints: inputs.constraints, snapshot: inputs.snapshot, ruleVersion: inputs.ruleVersion },
  };
  if (inputs.document) {
    manifest.document = {
      documentId: inputs.document.documentId,
      sha256: inputs.document.sha256,
      ...(inputs.document.revision !== undefined ? { revision: inputs.document.revision } : {}),
    };
  }
  return manifest;
}

/** Re-run the engine on a manifest's stored inputs; true when the verdict is identical. */
export function reproduces(manifest: IntakeManifest): boolean {
  const context: EngineContext = {
    decisionRunId: manifest.decisionRunId,
    timestampISO: manifest.timestampISO,
    providers: [],
    ruleVersion: manifest.inputs.ruleVersion,
  };
  const rerun = evaluateChange({
    change: manifest.inputs.descriptor,
    partId: manifest.part,
    snapshot: manifest.inputs.snapshot,
    constraints: manifest.inputs.constraints,
    context,
  });
  return canonicalJson(rerun.verdict) === canonicalJson(manifest.verdict);
}
