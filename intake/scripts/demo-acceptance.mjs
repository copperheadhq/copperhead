// End-to-end demo acceptance (task 7.3): GT-1, GT-2, GT-3 back to back,
// against a running dev server, mirroring the exact UI click sequence.
// Each GT must end with a persisted registry entry and a manifest in the
// evaluate response, and the whole arc must finish inside 3 minutes.
//
//   node scripts/demo-acceptance.mjs            # server at localhost:3100
//   BASE_URL=http://localhost:3000 node scripts/demo-acceptance.mjs
//
// The arc uses cached mode (the committed fixture cache), the required demo fallback: the
// demo datasheets' extractions were made live once and are replayed, with no network call.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const DATASHEETS = join(process.cwd(), "fixtures", "datasheets");
const LIMIT_MS = 3 * 60 * 1000;

let failures = 0;
function check(label, ok, detail = "") {
  const mark = ok ? "ok " : "FAIL";
  console.log(`  [${mark}] ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

async function resetRegistry() {
  const res = await fetch(`${BASE}/api/registry`, { method: "DELETE" });
  if (!res.ok) throw new Error(`registry reset failed: ${res.status}`);
}

const PARTS = {
  "lm555-electrical.pdf": ["Texas Instruments", "LM555"],
  "esp32-wroom32-electrical.pdf": ["Espressif", "ESP32-WROOM-32"],
  "sn74ls00-electrical.pdf": ["Texas Instruments", "SN74LS00"],
};

async function ingest(fileName) {
  const bytes = readFileSync(join(DATASHEETS, fileName));
  const form = new FormData();
  form.append("file", new File([bytes], fileName, { type: "application/pdf" }));
  form.append("mode", "cached");
  form.append("manufacturer", PARTS[fileName][0]);
  form.append("mpn", PARTS[fileName][1]);
  const res = await fetch(`${BASE}/api/ingest`, { method: "POST", body: form });
  const lines = (await res.text()).split("\n").filter((l) => l.trim());
  const last = JSON.parse(lines[lines.length - 1]);
  if (last.t !== "done") throw new Error(`ingest of ${fileName} failed: ${last.error}`);
  return last;
}

async function evaluate(descriptor, ingested) {
  const res = await fetch(`${BASE}/api/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ descriptor, documentSha: ingested.document.sha256 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`evaluate failed: ${data.error}`);
  return data;
}

async function correct(ingested, record, value, unit) {
  const res = await fetch(`${BASE}/api/registry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: record.extraction.field,
      qualifier: record.extraction.qualifier,
      value,
      unit,
      reviewer: "acceptance",
      documentSha: ingested.document.sha256,
      evidenceId: record.extraction.evidenceId,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`correction failed: ${data.error}`);
  return data;
}

async function registry() {
  return (await fetch(`${BASE}/api/registry`)).json();
}

function readingsOf(reg, partId, key) {
  return reg.parts[partId]?.parameters.find((p) => p.key === key)?.readings ?? [];
}

function checkManifest(gt, manifest, ingested) {
  check(`${gt} manifest names the document and the model that ran`,
    manifest?.document?.sha256 === ingested.document.sha256 && manifest?.extraction?.extractorModel === ingested.extractorModel);
}

async function runArc(runLabel) {
  console.log(`\n${runLabel}`);
  const t0 = performance.now();

  // GT-1: LM555 kept powered through sleep. Its worst-case supply current (15 mA MAX at
  // VCC = 15 V) is admitted from the text layer, so the 25 uA budget refuses at once. The held
  // 6 mA (VCC = 5 V, footnote) is then verified by a person, as a human reading.
  console.log("GT-1: LM555 supply current vs the 25 uA sleep budget");
  await resetRegistry();
  const lm555 = await ingest("lm555-electrical.pdf");
  const sleep = { kind: "add_component", label: "keep the LM555 powered through sleep", contributions: [{ factKey: "quiescent_current_uA" }] };
  const gt1 = await evaluate(sleep, lm555);
  check("GT-1 verdict is REFUSE", gt1.verdict.decision === "REFUSE", gt1.verdict.reason);
  check("GT-1 cites the budget constraint", gt1.verdict.citedConstraint?.id === "sleep_current_budget");
  check("GT-1 cites a supply-current line of the datasheet", gt1.verdict.citedReadings?.[0]?.evidence?.text?.includes("RL = ∞") === true);
  checkManifest("GT-1", gt1.manifest, lm555);
  check("GT-1 readings written under the part", readingsOf(await registry(), lm555.part.id, "quiescent_current_uA").length > 0);
  const held = lm555.records.find((r) => r.extraction.field === "quiescent_current_uA" && r.outcome === "REVIEW_REQUIRED" && r.extraction.qualifier === "MAX");
  check("GT-1 has a held supply-current read to verify", Boolean(held));
  if (held) {
    await correct(lm555, held, held.extraction.value, held.extraction.unit ?? "mA");
    const human = readingsOf(await registry(), lm555.part.id, "quiescent_current_uA").filter((r) => r.method.kind === "human");
    check("GT-1 verification stored as a human reading on the same line", human.length === 1 && human[0].evidence.evidenceId === held.extraction.evidenceId);
    const after = await evaluate(sleep, lm555);
    check("GT-1 still REFUSE after verification", after.verdict.decision === "REFUSE");
  }

  // GT-2: ESP32 GPIO driven from the 5V rail. The 3.6 V absolute maximum is admitted; the rail
  // rule (3.3 V, stressFrom the absolute maximum) refuses 5 V.
  console.log("GT-2: ESP32 5V rail vs the absolute-maximum input");
  await resetRegistry();
  const esp32 = await ingest("esp32-wroom32-electrical.pdf");
  const rail = { kind: "connect_rail", label: "drive an ESP32 GPIO from the 5V rail", contributions: [{ factKey: "abs_max_vin_V", value: 5, unit: "V" }] };
  const gt2 = await evaluate(rail, esp32);
  check("GT-2 verdict is REFUSE", gt2.verdict.decision === "REFUSE", gt2.verdict.reason);
  check("GT-2 cites the rail constraint", gt2.verdict.citedConstraint?.id === "rail_voltage_max");
  check("GT-2 cites the ABS_MAX reading", gt2.verdict.citedReadings?.[0]?.qualifier === "ABS_MAX");
  checkManifest("GT-2", gt2.manifest, esp32);
  check("GT-2 readings written under the part", readingsOf(await registry(), esp32.part.id, "abs_max_vin_V").length > 0);

  // GT-3: SN74LS00 pull-up on a gate input. Its input currents are stated at "VCC = MAX", a
  // condition with no number, so every read is held for review and the verdict is HOLD.
  console.log("GT-3: SN74LS00 held input current never decides");
  await resetRegistry();
  const ls00 = await ingest("sn74ls00-electrical.pdf");
  const pullUp = { kind: "add_component", label: "add 100k pull-up on an SN74LS00 input", contributions: [{ factKey: "pin_input_leakage_uA" }] };
  const gt3 = await evaluate(pullUp, ls00);
  check("GT-3 verdict is HOLD", gt3.verdict.decision === "HOLD", gt3.verdict.reason);
  check("GT-3 names the parameter to re-check", gt3.verdict.reason.includes("pin_input_leakage_uA"));
  checkManifest("GT-3", gt3.manifest, ls00);
  check("GT-3 HOLD writes nothing to the registry", (await registry()).parts[ls00.part.id] === undefined);

  const elapsed = performance.now() - t0;
  check("arc inside 3 minutes", elapsed < LIMIT_MS, `${(elapsed / 1000).toFixed(1)}s`);
  return elapsed;
}

const first = await runArc("Run 1 (cold)");
const second = await runArc("Run 2");
console.log(
  `\n${failures === 0 ? "ACCEPTANCE PASSED" : `ACCEPTANCE FAILED (${failures} checks)`}: run 1 ${(first / 1000).toFixed(1)}s, run 2 ${(second / 1000).toFixed(1)}s (limit 180s each)`,
);
process.exit(failures === 0 ? 0 : 1);
