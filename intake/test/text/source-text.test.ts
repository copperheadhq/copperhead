// Source text and evidence units (ground-intake-extraction D2, D3; source-text spec).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSourceText } from "../../adapters/source-text";
import type { DigitisedPage } from "../../core/digitised";
import { usableTextLayer } from "../../core/text/lines";
import type { IntakeUnit, PageItems } from "../../core/text/types";
import { headerCellFor, mintUnits } from "../../core/text/units";

const here = path.dirname(fileURLToPath(import.meta.url));
const datasheets = path.resolve(here, "../../fixtures/datasheets");
const DEMO = ["lm555-electrical.pdf", "sn74ls00-electrical.pdf", "esp32-wroom32-electrical.pdf", "2n3055-scanned.pdf"];

const noOcr = async (): Promise<DigitisedPage[]> => {
  throw new Error("OCR must not be called");
};

async function unitsOf(file: string, pages?: number[]): Promise<IntakeUnit[]> {
  const bytes = readFileSync(path.join(datasheets, file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const text = await readSourceText(bytes, pages ? { pages, digitise: noOcr } : { digitise: noOcr });
  return mintUnits({ documentId: file, sha256, authority: "MANUFACTURER" }, text.pages);
}

/** A one-page PDF with no text at all, as a scanned page with no OCR layer would be. */
function imageOnlyPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const OCR_PAGE: DigitisedPage = {
  page: 1,
  text: "",
  regions: [
    { text: "## Electrical Characteristics", bbox: { page: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.02 } },
    {
      text: "<table><tr><th>Parameter</th><th>Min</th><th>Typ</th><th>Max</th><th>Unit</th></tr><tr><td>Supply voltage</td><td></td><td></td><td>3.6</td><td>V</td></tr></table>",
      bbox: { page: 1, x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
    },
  ],
};

describe("text layer first", () => {
  it.each(DEMO)("%s is read from its text layer without OCR", async (file) => {
    const bytes = readFileSync(path.join(datasheets, file));
    const text = await readSourceText(bytes, { digitise: noOcr });
    expect(text.usedOcr).toBe(false);
    for (const page of text.pages) {
      expect(page.textSource).toBe("pdf-text");
      expect(page.reader).toMatch(/^pdfjs-[\d.]+\+rows-1$/);
      expect(page.lines.length).toBeGreaterThan(5);
    }
  });

  it("reads a table row as cells and places each value under its header column", async () => {
    const units = await unitsOf("lm555-electrical.pdf", [1]);
    const row = units.find((u) => u.text === "Supply Voltage | 4.5 | 16 | V")!;
    expect(row).toBeDefined();
    expect(row.context).toContain("PARAMETER | TEST CONDITIONS | MIN | TYP | MAX | UNIT");
    const header = row.layout.header!;
    const cell = (text: string) => row.layout.cells.find((c) => c.text === text)!;
    expect(headerCellFor(cell("4.5"), header)?.text).toBe("MIN");
    expect(headerCellFor(cell("16"), header)?.text).toBe("MAX");
    expect(headerCellFor(cell("V"), header)?.text).toBe("UNIT");
    expect(row.bbox!.y).toBeGreaterThan(0);
    expect(row.bbox!.y + row.bbox!.height).toBeLessThan(1);
  });

  it("merges subscripts into their word", async () => {
    const units = await unitsOf("lm555-electrical.pdf", [1]);
    expect(units.map((u) => u.text)).toContain("Supply Current | VCC = 5 V, RL = ∞ | 3 | 6");
  });
});

describe("usable text layer test", () => {
  const page = (str: string): PageItems => ({ page: 1, width: 595, height: 842, items: [{ str, x: 0, y: 0, w: 10, fs: 10 }] });
  it("accepts 300 readable characters", () => expect(usableTextLayer(page("a".repeat(300)))).toBe(true));
  it("rejects fewer than 200 characters", () => expect(usableTextLayer(page("a".repeat(150)))).toBe(false));
  it("rejects a layer of private-use glyphs from a font without a Unicode map", () =>
    expect(usableTextLayer(page("".repeat(250) + "abc"))).toBe(false));
});

describe("OCR fallback and page marking", () => {
  it("sends a page with no text layer to OCR and keeps OCR table cells by index", async () => {
    let calls = 0;
    const text = await readSourceText(imageOnlyPdf(), {
      digitise: async () => {
        calls++;
        return [OCR_PAGE];
      },
      ocrModel: "sarvam-vision",
    });
    expect(calls).toBe(1);
    expect(text.pages[0]!.textSource).toBe("ocr");
    expect(text.pages[0]!.reader).toBe("sarvam-vision+ocr-rows-1");
    const row = text.pages[0]!.lines.find((l) => l.text.startsWith("Supply voltage"))!;
    expect(row.text).toBe("Supply voltage |  |  | 3.6 | V");
    expect(row.cells.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("fails naming the page when a page needs OCR and no provider was given", async () => {
    await expect(readSourceText(imageOnlyPdf())).rejects.toThrow(/page 1 has no usable text layer/);
  });

  it("forceOcr sends every selected page to OCR and marks it", async () => {
    const bytes = readFileSync(path.join(datasheets, "lm555-electrical.pdf"));
    const text = await readSourceText(bytes, {
      forceOcr: true,
      digitise: async () => [OCR_PAGE, { ...OCR_PAGE, page: 2 }],
      ocrModel: "sarvam-vision",
    });
    expect(text.pages.map((p) => p.textSource)).toEqual(["ocr", "ocr"]);
  });
});

describe("evidence units", () => {
  it("ids are deterministic across two reads", async () => {
    const a = await unitsOf("esp32-wroom32-electrical.pdf");
    const b = await unitsOf("esp32-wroom32-electrical.pdf");
    expect(a).toEqual(b);
    expect(a[0]!.evidenceId).toMatch(/^ev-[0-9a-f]{8}-p1-l1$/);
    expect(new Set(a.map((u) => u.evidenceId)).size).toBe(a.length);
  });

  it("attaches a footnote by reference, from the table's own footnotes", async () => {
    const lm555 = await unitsOf("lm555-electrical.pdf", [1]);
    const lowState = lm555.find((u) => u.text === "(Low State)")!;
    expect(lowState.footnoteRefs).toEqual(["3"]);
    expect(lowState.context).toContain("Supply current when output high typically 1 mA less");

    const esp32 = await unitsOf("esp32-wroom32-electrical.pdf");
    const vih = esp32.find((u) => u.text.startsWith("VIH |"))!;
    expect(vih.footnoteRefs).toEqual(["1"]);
    expect(vih.context).toContain("Please see Appendix IO_MUX");
  });

  it("keeps neighbouring table rows out of the context", async () => {
    const units = await unitsOf("lm555-electrical.pdf", [1]);
    const first = units.find((u) => u.text === "Supply Current | VCC = 5 V, RL = ∞ | 3 | 6")!;
    expect(first.neighbors).toContain("VCC = 15 V, RL = ∞ | 10 | 15 | mA");
    expect(first.context ?? "").not.toContain("mA");
  });
});
