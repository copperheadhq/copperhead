// Draft a part pack from a datasheet (add-part-pack-export):
//
//   npx tsx scripts/pack.ts <datasheet.pdf> --mpn <mpn> --manufacturer <name> --topology <buck|boost|...>
//       --title "<document title as printed>" [--revision <r>] [--alias <spelling>]... [--pages 1,2,5]
//       [--live] [--out <pack.yaml>]
//
// Runs the production intake on the regulator fields (core/fields.ts PACK_FIELD_SPECS): the text layer
// first, evidence units, the extractor (cached unless --live), validation. Only admitted readings enter
// the draft, each quoting its evidence unit. The draft has no confirmedBy; scripts/confirm-pack.ts
// confirms it once a person has checked it.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Document } from "yaml";
import { buildIngestDeps, ingest } from "../adapters/ingest";
import { PACK_FIELD_SPECS } from "../core/fields";
import { draftPack, TOPOLOGIES, type Topology } from "../core/pack";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const all = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1] as string] : []));
  const pdf = args[0];
  const mpn = flag("--mpn");
  const manufacturer = flag("--manufacturer");
  const topology = flag("--topology") as Topology | undefined;
  const title = flag("--title");
  if (!pdf || !mpn || !manufacturer || !topology || !title || !TOPOLOGIES.includes(topology)) {
    throw new Error(`usage: scripts/pack.ts <pdf> --mpn <mpn> --manufacturer <name> --topology <${TOPOLOGIES.join("|")}> --title <title> [--revision r] [--alias a]... [--pages 1,2] [--live] [--out file]`);
  }
  const pages = flag("--pages")?.split(",").map(Number);
  const revision = flag("--revision");
  const deps = buildIngestDeps(join(process.cwd(), "fixtures"), { mode: args.includes("--live") ? "live" : "cached", onProgress: (m) => console.error(`  ${m}`) });
  const result = await ingest({ fileName: basename(pdf), bytes: readFileSync(pdf) }, deps, {
    specs: PACK_FIELD_SPECS,
    ...(pages ? { pages } : {}),
    ...(revision !== undefined ? { revision } : {}),
    now: () => new Date().toISOString(),
    onProgress: (m) => console.error(`  ${m}`),
  });
  const draft = draftPack({
    mpn,
    manufacturer,
    aliases: all("--alias"),
    topology,
    title,
    document: result.document,
    records: result.records,
    extractor: `copperhead intake (${result.extractorModel}, prompt ${result.promptHash.slice(0, 12)})`,
    on: new Date().toISOString().slice(0, 10),
  });
  const { notes, ...pack } = draft;
  const doc = new Document(pack);
  doc.commentBefore = ` A part pack draft (part-packs v1, Copperhead RFC 4 Section 6.3).\n${notes.map((n) => ` ${n}`).join("\n")}`;
  const text = doc.toString({ lineWidth: 0 });
  const out = flag("--out");
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
  console.error(`${draft.facts.length} fact(s) from ${result.records.length} extraction(s); ${notes.slice(1).join(" ")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
