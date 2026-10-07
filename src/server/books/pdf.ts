/**
 * P6-3: minimal text PDF writer (PDF 1.4, Helvetica) — no new dependency.
 * One logical section may span pages; footer shows "Page N of M".
 *
 * Text is written as WinAnsi (cp1252) bytes under /Encoding /WinAnsiEncoding, so "·", "—", "–",
 * "é" print correctly. Characters cp1252 has no glyph for (e.g. Arabic) become "?" — showing them
 * needs an embedded Unicode font, which this writer does not do.
 *
 * Tables are laid out at fixed x positions: every cell keeps its column (a blank amount prints "–"),
 * amounts are right-aligned using Helvetica's glyph widths.
 */

/** cp1252 bytes 0x80–0x9F (the rest of 0xA0–0xFF equals Latin-1). */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Symbols outside cp1252 that have a readable ASCII spelling. */
const ASCII_FALLBACK: Record<number, string> = {
  0x2192: "->", 0x2190: "<-", 0x2212: "-", 0x2011: "-", 0x2010: "-", 0x202f: " ", 0x2009: " ",
};

/**
 * Encode text as a "binary string": one char per cp1252 byte (char code 0–255).
 * Unmappable characters become "?"; control characters are dropped.
 */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of String(text ?? "")) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) continue;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) {
      out += String.fromCharCode(cp);
    } else if (CP1252_HIGH[cp] !== undefined) {
      out += String.fromCharCode(CP1252_HIGH[cp]);
    } else if (ASCII_FALLBACK[cp] !== undefined) {
      out += ASCII_FALLBACK[cp];
    } else {
      out += "?";
    }
  }
  return out;
}

/** Escape a WinAnsi binary string for a PDF literal string. */
function pdfEscape(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Helvetica advance widths (1/1000 em) for WinAnsi 0x20–0x7E; other bytes use 556. */
const HELV_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // 0x20–0x2F
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0x30–0x3F
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // 0x40–0x4F
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // 0x50–0x5F
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // 0x60–0x6F
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // 0x70–0x7E
];
const HELV_HIGH: Record<number, number> = { 0x96: 556, 0x97: 1000, 0xb7: 278, 0x95: 350, 0x85: 1000 };

/** Width in points of a WinAnsi binary string at `size`. */
function textWidth(bin: string, size: number): number {
  let w = 0;
  for (let i = 0; i < bin.length; i++) {
    const b = bin.charCodeAt(i);
    w += b >= 0x20 && b <= 0x7e ? HELV_ASCII[b - 0x20] : (HELV_HIGH[b] ?? 556);
  }
  return (w * size) / 1000;
}

/** Cut a WinAnsi string so it fits `maxWidth` points (adds "..." when cut). */
function fitText(bin: string, size: number, maxWidth: number): string {
  if (textWidth(bin, size) <= maxWidth) return bin;
  let s = bin;
  while (s.length > 1 && textWidth(`${s}...`, size) > maxWidth) s = s.slice(0, -1);
  return `${s}...`;
}

export type PdfTable = {
  /** First row is the column header. */
  rows: string[][];
  /** Leading left-aligned text columns (default 1); the rest are right-aligned amounts. */
  textColumns?: number;
};

export type PdfSection = {
  title: string;
  lines?: string[];
  table?: PdfTable;
};

function wrapLine(line: string, width: number): string[] {
  if (!line) return [""];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < width / 2) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

/** A positioned text run on a page (WinAnsi binary text). */
type Run = { x: number; y: number; size: number; text: string };

type Layout = {
  width: number;
  height: number;
  /** Column slots: text columns start at x, amount columns end (right-aligned) at x. */
  cols: Array<{ x: number; right: boolean; width: number }>;
  size: number;
};

const MARGIN = 50;
const LEADING = 14;

function tableLayout(table: PdfTable): Layout {
  const nCols = Math.max(1, ...table.rows.map((r) => r.length));
  const textCols = Math.min(nCols, Math.max(1, table.textColumns ?? 1));
  const amountCols = nCols - textCols;
  const landscape = amountCols > 4;
  const width = landscape ? 792 : 612;
  const height = landscape ? 612 : 792;
  const usable = width - 2 * MARGIN;
  // Widest printed amount (at 1pt) decides whether the font must shrink to fit the column.
  let maxAmount = 0;
  for (const r of table.rows) {
    for (let c = textCols; c < r.length; c++) {
      maxAmount = Math.max(maxAmount, textWidth(toWinAnsi(r[c] || "–"), 1));
    }
  }
  const gap = 8;
  let size = 9;
  const textShare = amountCols ? Math.max(140, usable * 0.34) : usable;
  const perAmount = amountCols ? (usable - textShare) / amountCols : 0;
  if (amountCols && maxAmount * size + gap > perAmount) {
    size = Math.max(6, Math.floor(((perAmount - gap) / Math.max(maxAmount, 1)) * 10) / 10);
  }
  const cols: Layout["cols"] = [];
  const textWidthEach = textShare / textCols;
  for (let c = 0; c < textCols; c++) {
    cols.push({ x: MARGIN + c * textWidthEach, right: false, width: textWidthEach - gap });
  }
  for (let c = 0; c < amountCols; c++) {
    cols.push({ x: MARGIN + textShare + (c + 1) * perAmount, right: true, width: perAmount - gap });
  }
  return { width, height, cols, size };
}

function tableRowRuns(cells: string[], layout: Layout, y: number, isHeader: boolean): Run[] {
  const runs: Run[] = [];
  const textCols = layout.cols.filter((c) => !c.right).length;
  const amounts = cells.slice(textCols);
  // A heading row (no amounts at all) prints just its label; otherwise every cell keeps its slot.
  const heading = !isHeader && amounts.every((v) => !v);
  for (let c = 0; c < layout.cols.length; c++) {
    const col = layout.cols[c];
    let raw = cells[c] ?? "";
    if (col.right) {
      if (heading) continue;
      if (!raw) raw = "–";
    }
    if (!raw) continue;
    const text = fitText(toWinAnsi(raw), layout.size, col.width);
    const x = col.right ? col.x - textWidth(text, layout.size) : col.x;
    runs.push({ x: Math.round(x * 100) / 100, y, size: layout.size, text });
  }
  return runs;
}

function pageStream(runs: Run[]): string {
  return runs
    .map((r) => `BT /F1 ${r.size} Tf ${r.x} ${r.y} Td (${pdfEscape(r.text)}) Tj ET`)
    .join("\n");
}

type Page = { width: number; height: number; runs: Run[] };

/** Build a simple multi-page PDF. */
export function buildSimplePdf(meta: {
  brand: string;
  company: string;
  periodLabel: string;
  preparedBy: string;
  generatedAt: string;
  sections: PdfSection[];
}): Buffer {
  const header = [
    meta.brand,
    meta.company,
    `${meta.periodLabel} · AED · Prepared by ${meta.preparedBy || "—"}`,
    `Generated ${meta.generatedAt}`,
  ];
  const pages: Page[] = [];

  const newPage = (width: number, height: number, title: string, continued: boolean) => {
    const page: Page = { width, height, runs: [] };
    let y = height - 32;
    header.forEach((h, i) => {
      page.runs.push({ x: MARGIN, y, size: i === 0 ? 12 : 10, text: toWinAnsi(h) });
      y -= LEADING;
    });
    y -= LEADING;
    if (title) {
      page.runs.push({
        x: MARGIN,
        y,
        size: 11,
        text: toWinAnsi(continued ? `(continued) ${title}` : title),
      });
    }
    y -= LEADING * 1.5;
    pages.push(page);
    return { page, y };
  };

  for (const sec of meta.sections) {
    if (sec.table && sec.table.rows.length) {
      const layout = tableLayout(sec.table);
      const [head, ...body] = sec.table.rows;
      let { page, y } = newPage(layout.width, layout.height, sec.title, false);
      page.runs.push(...tableRowRuns(head, layout, y, true));
      y -= LEADING;
      for (const row of body) {
        if (y < 60) {
          ({ page, y } = newPage(layout.width, layout.height, sec.title, true));
          page.runs.push(...tableRowRuns(head, layout, y, true));
          y -= LEADING;
        }
        if (row.length) page.runs.push(...tableRowRuns(row, layout, y, false));
        y -= LEADING;
      }
      continue;
    }
    let { page, y } = newPage(612, 792, sec.title, false);
    for (const line of sec.lines || []) {
      for (const w of wrapLine(line, 95)) {
        if (y < 60) ({ page, y } = newPage(612, 792, sec.title, true));
        if (w) page.runs.push({ x: MARGIN, y, size: 10, text: toWinAnsi(w) });
        y -= LEADING;
      }
    }
  }
  if (!pages.length) {
    const { page, y } = newPage(612, 792, "", false);
    page.runs.push({ x: MARGIN, y, size: 10, text: "No data." });
  }

  type Obj = { id: number; body: string };
  const objs: Obj[] = [];
  const add = (body: string) => {
    const id = objs.length + 1;
    objs.push({ id, body });
    return id;
  };

  const catalogId = add(""); // placeholder
  const pagesId = add(""); // placeholder
  const fontId = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );

  const pageObjIds: number[] = [];
  for (let p = 0; p < pages.length; p++) {
    const pg = pages[p];
    const runs = [...pg.runs, { x: MARGIN, y: 30, size: 9, text: `Page ${p + 1} of ${pages.length}` }];
    // Every string here is a binary string (one char per byte), so length === byte length.
    const stream = pageStream(runs);
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pg.width} ${pg.height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    pageObjIds.push(pageId);
  }

  objs[catalogId - 1].body = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1].body =
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjIds.length} >>`;

  // Binary string throughout; written as latin1 so each char becomes exactly one byte.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const o of objs) {
    offsets.push(out.length);
    out += `${o.id} 0 obj\n${o.body}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
