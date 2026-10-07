/**
 * P6-3: minimal text PDF writer (PDF 1.4, Helvetica) — no new dependency.
 * One logical section may span pages; footer shows "Page N of M".
 */

function pdfEscape(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export type PdfSection = {
  title: string;
  lines: string[];
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

function buildPageStream(lines: string[]): string {
  const cmds: string[] = ["BT", "/F1 10 Tf", "50 760 Td", "14 TL"];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      cmds.push(`/F1 12 Tf (${pdfEscape(lines[i])}) Tj`, "/F1 10 Tf", "T*");
    } else {
      cmds.push(`(${pdfEscape(lines[i])}) Tj`, "T*");
    }
  }
  cmds.push("ET");
  return cmds.join("\n");
}

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
  const pages: string[][] = [];
  for (const sec of meta.sections) {
    const body = [sec.title, "", ...sec.lines];
    let chunk: string[] = [...header, ""];
    for (const line of body) {
      for (const w of wrapLine(line, 95)) {
        if (chunk.length >= 52) {
          pages.push(chunk);
          chunk = [...header, "", `(continued) ${sec.title}`, ""];
        }
        chunk.push(w);
      }
    }
    pages.push(chunk);
  }
  if (!pages.length) pages.push([...header, "", "No data."]);

  type Obj = { id: number; body: string };
  const objs: Obj[] = [];
  const add = (body: string) => {
    const id = objs.length + 1;
    objs.push({ id, body });
    return id;
  };

  const catalogId = add(""); // placeholder
  const pagesId = add(""); // placeholder
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const pageObjIds: number[] = [];
  for (let p = 0; p < pages.length; p++) {
    const lines = [...pages[p], "", `Page ${p + 1} of ${pages.length}`];
    const stream = buildPageStream(lines);
    const contentId = add(
      `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    );
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    pageObjIds.push(pageId);
  }

  objs[catalogId - 1].body = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1].body =
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjIds.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(out, "utf8"));
    out += `${o.id} 0 obj\n${o.body}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, "utf8");
  out += `xref\n0 ${objs.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "utf8");
}
