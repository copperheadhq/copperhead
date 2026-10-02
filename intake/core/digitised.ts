// Digitised (OCR) pages, as the digitisation port returns them. Pure types.

/** Normalized 0..1 page-relative coordinates, origin top-left. */
export interface BoundingBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One region of a digitised page, with its bounding box. */
export interface DigitisedRegion {
  text: string;
  bbox: BoundingBox;
}

export interface DigitisedPage {
  /** 1-based page number. */
  page: number;
  /** Full concatenated text of the page. */
  text: string;
  regions: DigitisedRegion[];
}
