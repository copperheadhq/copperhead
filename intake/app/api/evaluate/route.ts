import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { evaluateChange } from "../../../core/evaluate";
import { DEFAULT_FIELD_SPECS } from "../../../core/fields";
import { buildManifest } from "../../../core/manifest";
import type { ChangeDescriptor, Registry } from "../../../core/model";
import { RegistryError, snapshotFor } from "../../../core/registry";
import { loadIngest, registryStore } from "../../../lib/server";

export const runtime = "nodejs";

const RULE_VERSION = "intake-registry-v2";

interface EvaluateBody {
  descriptor: ChangeDescriptor;
  /** The ingested datasheet whose admitted readings join the part's stored ones. */
  documentSha?: string;
  /** Evaluate a part from stored readings alone (reuse without extraction). */
  partId?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as EvaluateBody;
  if (!body?.descriptor?.label || !Array.isArray(body.descriptor.contributions)) {
    return NextResponse.json({ error: "invalid change descriptor" }, { status: 400 });
  }
  const store = registryStore();
  let registry: Registry;
  try {
    registry = store.load();
  } catch (err) {
    // Fail closed: a malformed registry refuses to evaluate (AC-5.2).
    return NextResponse.json({ error: err instanceof RegistryError ? err.message : "registry unreadable" }, { status: 422 });
  }

  const stored = body.documentSha ? loadIngest(body.documentSha) : undefined;
  if (body.documentSha && !stored) return NextResponse.json({ error: "no ingest for that document; upload it first" }, { status: 404 });
  const partId = stored?.part.id ?? body.partId;
  if (!partId) return NextResponse.json({ error: "evaluation needs documentSha or partId" }, { status: 400 });

  // The part's stored readings plus this document's admitted ones; never another part's.
  const candidate = stored
    ? store.withReadings(registry, stored.part, stored.result.document, stored.result.records, DEFAULT_FIELD_SPECS)
    : registry;
  const snapshot = snapshotFor(candidate, partId);
  const timestampISO = new Date().toISOString();
  const decisionRunId = randomUUID();
  const result = evaluateChange({
    change: body.descriptor,
    partId,
    snapshot,
    constraints: candidate.constraints,
    context: { decisionRunId, timestampISO, providers: [], ruleVersion: RULE_VERSION },
  });
  // Readings are written when the verdict is decided (AC-8.1).
  if (result.verdict.decision !== "HOLD" && stored) store.save(candidate);

  const manifest = buildManifest({
    timestampISO,
    decisionRunId,
    partId,
    descriptor: body.descriptor,
    constraints: candidate.constraints,
    snapshot,
    result,
    ruleVersion: RULE_VERSION,
    ...(stored ? { document: stored.result.document } : {}),
    pages: stored?.result.pages ?? [],
    extraction: {
      extractorModel: stored?.result.extractorModel ?? "registry",
      promptHash: stored?.result.promptHash ?? "",
      schemaVersion: "extractions-1",
      ...(stored?.result.ocrModel ? { ocrModel: stored.result.ocrModel } : {}),
    },
    validators: [...new Set((stored?.result.records ?? []).flatMap((r) => r.results.map((v) => `${v.validator}@${v.version}`)))].sort(),
  });
  return NextResponse.json({ verdict: result.verdict, checks: result.checks.map((c) => c.verdict), manifest });
}
