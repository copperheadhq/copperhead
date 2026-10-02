import { NextRequest } from "next/server";
import { buildIngestDeps, ingest, IngestMode } from "../../../adapters/ingest";
import { partRef } from "../../../core/model";
import { FIXTURES_DIR, saveIngest, saveUpload } from "../../../lib/server";

export const runtime = "nodejs";

// Streams NDJSON progress events while ingesting:
//   {"t":"progress","message":"read 2 page(s): 2 from the text layer, 0 by OCR"}
//   ...
//   {"t":"done","part":...,"document":...,"pages":[...],"records":[...],...}
// or {"t":"error","error":"..."} as the terminal line. The result is also kept server-side,
// keyed by the document's sha256, so evaluation never trusts readings posted by a client.
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "no file uploaded" }, { status: 400 });
  const mode = form.get("mode");
  const manufacturer = String(form.get("manufacturer") ?? "").trim() || "unknown";
  const mpn = String(form.get("mpn") ?? "").trim() || file.name.replace(/\.pdf$/i, "");
  const pagesField = String(form.get("pages") ?? "").trim();
  const pages = pagesField === "" ? undefined : pagesField.split(/[,\s]+/).map(Number);
  if (pages && pages.some((p) => !Number.isInteger(p) || p < 1)) {
    return Response.json({ error: `pages must be positive integers, got "${pagesField}"` }, { status: 400 });
  }
  const forceOcr = form.get("forceOcr") === "true";
  const bytes = Buffer.from(await file.arrayBuffer());
  saveUpload(file.name, bytes);
  const doc = { fileName: file.name, bytes };
  const ingestMode: IngestMode | undefined = mode === "live" ? "live" : mode === "cached" ? "cached" : undefined;
  const part = partRef(manufacturer, mpn);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      const onProgress = (message: string) => emit({ t: "progress", message });
      try {
        emit({ t: "progress", message: `received ${file.name} (${bytes.length} bytes) as ${part.id}` });
        const deps = buildIngestDeps(FIXTURES_DIR, ingestMode ? { mode: ingestMode, onProgress } : { onProgress });
        const result = await ingest(doc, deps, {
          ...(pages ? { pages } : {}),
          ...(forceOcr ? { forceOcr } : {}),
          onProgress,
          now: () => new Date().toISOString(),
        });
        saveIngest({ part, result });
        emit({
          t: "done",
          fileName: file.name,
          part,
          document: result.document,
          pages: result.pages,
          records: result.records,
          extractorModel: result.extractorModel,
          promptHash: result.promptHash,
          ocrModel: result.ocrModel ?? null,
          passes: result.passes,
        });
      } catch (err) {
        emit({ t: "error", error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
