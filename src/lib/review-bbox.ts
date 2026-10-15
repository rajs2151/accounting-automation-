/** PDF / image page space: origin top-left, units in page pixels/points. */
export type PageBBox = {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pageWidth: number;
  pageHeight: number;
  label: string;
};

/** Worker fields_json[*].source shape (E1+). */
export type FieldSource = {
  page: number;
  bbox: [number, number, number, number];
} | null;

export function bboxCentre(b: Pick<PageBBox, "x0" | "y0" | "x1" | "y1">) {
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

/** True when bbox centre lies inside the value's text rectangle (same coordinate space). */
export function bboxCentreOnText(
  bbox: Pick<PageBBox, "x0" | "y0" | "x1" | "y1">,
  textRect: { x0: number; y0: number; x1: number; y1: number },
): boolean {
  const c = bboxCentre(bbox);
  return c.x >= textRect.x0 && c.x <= textRect.x1 && c.y >= textRect.y0 && c.y <= textRect.y1;
}

/** CSS % overlay relative to rendered page box. */
export function bboxOverlayStyle(b: PageBBox): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  const w = Math.max(1, b.pageWidth);
  const h = Math.max(1, b.pageHeight);
  return {
    left: `${(b.x0 / w) * 100}%`,
    top: `${(b.y0 / h) * 100}%`,
    width: `${((b.x1 - b.x0) / w) * 100}%`,
    height: `${((b.y1 - b.y0) / h) * 100}%`,
  };
}

/** Boxes that belong on a given 1-based page. */
export function filterBoxesForPage(boxes: PageBBox[], page: number): PageBBox[] {
  return boxes.filter((b) => b.page === page);
}

/**
 * Map PDF-point bbox → CSS pixel rect on the rendered canvas.
 * zoom is the pdf.js viewport scale (e.g. 1.5).
 */
export function scaleBBoxToRender(
  box: Pick<PageBBox, "x0" | "y0" | "x1" | "y1">,
  zoom: number,
): { left: number; top: number; width: number; height: number } {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    left: box.x0 * z,
    top: box.y0 * z,
    width: (box.x1 - box.x0) * z,
    height: (box.y1 - box.y0) * z,
  };
}

/** Build a PageBBox from worker source + page dimensions (PDF points). */
export function pageBBoxFromSource(
  label: string,
  source: FieldSource,
  pageWidth: number,
  pageHeight: number,
): PageBBox | null {
  if (!source || !Array.isArray(source.bbox) || source.bbox.length < 4) return null;
  const page = Math.max(1, Math.floor(Number(source.page) || 1));
  const [x0, y0, x1, y1] = source.bbox.map(Number);
  if (![x0, y0, x1, y1].every((n) => Number.isFinite(n))) return null;
  return {
    label,
    page,
    x0,
    y0,
    x1,
    y1,
    pageWidth: pageWidth > 0 ? pageWidth : 595,
    pageHeight: pageHeight > 0 ? pageHeight : 842,
  };
}

/** Collect overlay boxes from review fields that carry a worker source. */
export function boxesFromFieldSources(
  fields: Record<string, { source?: FieldSource }>,
  pageSizeByPage: Record<number, { width: number; height: number }> = {},
  fallback = { width: 595, height: 842 },
): PageBBox[] {
  const out: PageBBox[] = [];
  for (const [label, field] of Object.entries(fields)) {
    const source = field?.source ?? null;
    if (!source) continue;
    const dims = pageSizeByPage[source.page] || fallback;
    const box = pageBBoxFromSource(label, source, dims.width, dims.height);
    if (box) out.push(box);
  }
  return out;
}

/** PDF point space (A4). PNG demo is rendered at 2× → multiply when overlaying PNG. */
export const INVOICE_SYN_001_PAGE = { width: 595, height: 842 } as const;
export const INVOICE_SYN_001_PNG_SCALE = 2;

/**
 * Measured via PyMuPDF search_for on fixtures/extraction/pdfs/invoice_01.pdf
 * (same bytes as public/books-demo/invoice-syn-001.pdf), then ×2 for the PNG raster.
 */
const PDF_TEXT_RECTS = {
  supplier_name: { x0: 50.0, y0: 75.3, x1: 200.0, y1: 90.4 },
  customer_name: { x0: 86.7, y0: 105.5, x1: 200.0, y1: 120.6 },
  supplier_trn: { x0: 75.7, y0: 90.4, x1: 167.4, y1: 105.5 },
  customer_trn: { x0: 75.7, y0: 120.6, x1: 167.4, y1: 135.7 },
  invoice_no: { x0: 108.1, y0: 135.7, x1: 174.7, y1: 150.9 },
  invoice_date: { x0: 79.3, y0: 150.9, x1: 134.4, y1: 166.0 },
  grand_total: { x0: 129.5, y0: 196.2, x1: 163.1, y1: 211.3 },
} as const;

function toPngBox(label: string, r: { x0: number; y0: number; x1: number; y1: number }): PageBBox {
  const s = INVOICE_SYN_001_PNG_SCALE;
  return {
    page: 1,
    label,
    x0: r.x0 * s,
    y0: r.y0 * s,
    x1: r.x1 * s,
    y1: r.y1 * s,
    pageWidth: INVOICE_SYN_001_PAGE.width * s,
    pageHeight: INVOICE_SYN_001_PAGE.height * s,
  };
}

/** @deprecated PNG demo path — kept for bbox unit tests only. */
export function invoiceSyn001DemoBboxes(): Record<string, PageBBox> {
  return {
    supplier_name: toPngBox("supplier_name", PDF_TEXT_RECTS.supplier_name),
    customer_name: toPngBox("customer_name", PDF_TEXT_RECTS.customer_name),
    supplier_trn: toPngBox("supplier_trn", PDF_TEXT_RECTS.supplier_trn),
    customer_trn: toPngBox("customer_trn", PDF_TEXT_RECTS.customer_trn),
    invoice_no: toPngBox("invoice_no", PDF_TEXT_RECTS.invoice_no),
    invoice_date: toPngBox("invoice_date", PDF_TEXT_RECTS.invoice_date),
    grand_total: toPngBox("grand_total", PDF_TEXT_RECTS.grand_total),
  };
}

/** Text rectangles in the same PNG pixel space — used by unit tests. */
export const INVOICE_SYN_001_TEXT_RECTS = {
  invoice_no: toPngBox("invoice_no", PDF_TEXT_RECTS.invoice_no),
  grand_total: toPngBox("grand_total", PDF_TEXT_RECTS.grand_total),
  supplier_name: toPngBox("supplier_name", PDF_TEXT_RECTS.supplier_name),
} as const;
