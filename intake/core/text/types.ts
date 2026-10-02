// Source-text types (ground-intake-extraction D2, D3). Pure: no I/O.

import type { EvidenceUnit } from "../knowledge/types";

/** One text item from a PDF text layer, in PDF user space (origin bottom-left, y up). */
export interface TextItem {
  str: string;
  /** Left edge of the item's baseline. */
  x: number;
  /** Baseline. */
  y: number;
  /** Advance width. */
  w: number;
  /** Font size: the vertical scale of the item's transform. */
  fs: number;
}

export interface PageItems {
  page: number;
  /** Page width and height in PDF user space. */
  width: number;
  height: number;
  items: TextItem[];
}

/** A bounding box normalised to 0..1 of the page, origin top-left. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A cell of a line. Text-layer cells carry their horizontal extent (0..1 of the page width),
 * so a value can be placed under a header column even when the cells to its left are empty.
 * OCR cells carry their index, because OCR tables keep empty cells.
 */
export interface Cell {
  text: string;
  x0?: number;
  x1?: number;
  index: number;
}

export interface Line {
  text: string;
  cells: Cell[];
  bbox: Box;
  /** The dominant font size of the line, in points; 0 for OCR lines. */
  fontSize: number;
  /** Footnote markers set as superscripts or as a marker-only line, such as "1" or "3". */
  footnoteRefs: string[];
}

export type TextSource = "pdf-text" | "ocr";

export interface SourcePage {
  page: number;
  textSource: TextSource;
  /** The reader that produced the lines: the pdf.js and row builder versions, or the OCR provider. */
  reader: string;
  lines: Line[];
}

/** The intake's evidence unit: cortex's unit plus the layout the intake's validators read. */
export interface IntakeUnit extends EvidenceUnit {
  textSource: TextSource;
  /** The unit's own cells, and the header row's cells when the unit is a table row under one. */
  layout: { cells: Cell[]; header?: Cell[] };
  /** Footnote markers the unit references. */
  footnoteRefs: string[];
  /**
   * The table lines directly above and below, for merged cells such as a unit column spanning
   * two rows. Read only by the unit-present check, never by containment, so a number in a
   * neighbouring row is never taken as cited by this unit.
   */
  neighbors: string[];
}
