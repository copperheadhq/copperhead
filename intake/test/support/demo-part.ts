// DEMO-IO-EXPANDER: a synthetic datasheet with the golden tests' exact values (33 uA input
// leakage against a 25 uA sleep budget, a 3.6 V absolute maximum against a 5 V rail, and a
// footnote-qualified quiescent current), written as a real text-layer PDF.

import { row, textPdf, type PdfText } from "./text-pdf";

const COLS: [number, number, number, number, number] = [60, 260, 330, 400, 470];

function heading(text: string, y: number): PdfText {
  return { text, x: 60, y, size: 13 };
}

const filler = (y: number): PdfText => ({
  text: "This synthetic datasheet exists only for the intake's golden tests and describes no real part.",
  x: 60,
  y,
  size: 9,
});

export const DEMO_PAGES: PdfText[][] = [
  [
    heading("DEMO-IO-EXPANDER", 780),
    filler(760),
    heading("6.1 Absolute Maximum Ratings", 720),
    ...row(700, [[COLS[0], "PARAMETER"], [COLS[1], "MIN"], [COLS[3], "MAX"], [COLS[4], "UNIT"]]),
    ...row(685, [[COLS[0], "Input voltage VIN"], [COLS[1], "-0.3"], [COLS[3], "3.6"], [COLS[4], "V"]]),
    ...row(670, [[COLS[0], "Storage temperature"], [COLS[1], "-40"], [COLS[3], "125"], [COLS[4], "C"]]),
    filler(640),
  ],
  [
    heading("6.5 Electrical Characteristics", 780),
    filler(760),
    ...row(740, [[COLS[0], "PARAMETER"], [COLS[1], "MIN"], [COLS[2], "TYP"], [COLS[3], "MAX"], [COLS[4], "UNIT"]]),
    ...row(725, [[COLS[0], "Supply voltage"], [COLS[1], "1.65"], [COLS[3], "3.6"], [COLS[4], "V"]]),
    ...row(710, [[COLS[0], "Input leakage current"], [COLS[3], "0.033"], [COLS[4], "mA"]]),
    ...row(695, [[COLS[0], "Quiescent current"], [COLS[3], "1.5"], [COLS[4], "uA"]]),
    { text: "(1)", x: 140, y: 698, size: 5 },
    { text: "(1) Measured at 25 C only; not tested across temperature.", x: 60, y: 600, size: 8 },
  ],
];

export function demoPdf(): Uint8Array {
  return textPdf(DEMO_PAGES);
}
