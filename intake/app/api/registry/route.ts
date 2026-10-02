import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_FIELD_SPECS } from "../../../core/fields";
import { isAdmitted, type Qualifier } from "../../../core/model";
import { RegistryError } from "../../../core/registry";
import { loadIngest, registryStore } from "../../../lib/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(registryStore().load());
  } catch (err) {
    return NextResponse.json({ error: err instanceof RegistryError ? err.message : "registry unreadable" }, { status: 422 });
  }
}

/** Reset the working registry to the committed seed (demo housekeeping). */
export async function DELETE() {
  const { rmSync } = await import("node:fs");
  const { REGISTRY_PATH } = await import("../../../lib/server");
  rmSync(REGISTRY_PATH, { force: true });
  return NextResponse.json(registryStore().load());
}

interface CorrectionBody {
  key?: string;
  qualifier?: Qualifier;
  value?: string | number;
  unit?: string;
  reviewer?: string;
  reason?: string;
  /** A stored part's reading to correct. */
  partId?: string;
  /** Or an extraction held for review, from an ingest kept server-side. */
  documentSha?: string;
  evidenceId?: string;
}

/**
 * A person's correction (AC-9.1), appended as a human reading. A stored reading of that
 * qualifier is corrected in place in the ladder; an extraction held for review becomes a human
 * reading citing the same evidence unit.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as CorrectionBody;
  const value = body?.value === undefined ? undefined : String(body.value);
  if (typeof body?.key !== "string" || !body.qualifier || value === undefined || typeof body.unit !== "string") {
    return NextResponse.json({ error: "a correction needs key, qualifier, value and unit" }, { status: 400 });
  }
  const audit = { reviewer: body.reviewer?.trim() || "reviewer", reason: body.reason?.trim() || "corrected in the intake", timestampISO: new Date().toISOString() };
  const store = registryStore();
  try {
    const stored = body.documentSha ? loadIngest(body.documentSha) : undefined;
    const partId = stored?.part.id ?? body.partId;
    if (!partId) return NextResponse.json({ error: "a correction needs partId or documentSha" }, { status: 400 });
    const registry = store.load();
    // A stored reading of the named line (or, with no line named, of the qualifier) is corrected;
    // otherwise the reviewed extraction of that line becomes a human reading.
    const hasReading = registry.parts[partId]?.parameters.some(
      (p) => p.key === body.key && p.readings.some((r) => r.qualifier === body.qualifier && (body.evidenceId === undefined || r.evidence.evidenceId === body.evidenceId)),
    );
    if (hasReading) return NextResponse.json(store.correct(partId, body.key, body.qualifier, { value, unit: body.unit }, audit, body.evidenceId));
    const record = stored?.result.records.find((r) => r.extraction.evidenceId === body.evidenceId && r.extraction.field === body.key);
    if (!stored || !record?.unit?.bbox) {
      return NextResponse.json({ error: "nothing to correct: no stored reading, and no reviewed extraction with that evidence id" }, { status: 422 });
    }
    const evidence = { ...record.unit, bbox: record.unit.bbox };
    const conditions = isAdmitted(record) ? record.reading.conditions : (record.reading?.conditions ?? {});
    return NextResponse.json(
      store.confirm(stored.part, stored.result.document, body.key, { evidence, qualifier: body.qualifier, conditions }, { value, unit: body.unit }, audit, DEFAULT_FIELD_SPECS),
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof RegistryError ? err.message : "correction failed" }, { status: 422 });
  }
}
