import { createHash } from "node:crypto";
import fs from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const base = fs.readFileSync("fixtures/extraction/pdfs/invoice_02.pdf");
const data = Buffer.concat([base, Buffer.from(`\n% e2e-${Date.now()}\n`)]);
console.log("sha", createHash("sha256").update(data).digest("hex").slice(0, 12));
const doc = await pdfjs
  .getDocument({ data: new Uint8Array(data), useSystemFonts: true, disableWorker: true })
  .promise;
const page = await doc.getPage(1);
const tc = await page.getTextContent();
const text = tc.items.map((i) => ("str" in i ? i.str : "")).join("\n");
console.log(text.includes("INV-SYN-002") ? "HAS_INV" : "MISSING_INV");
console.log(text.slice(0, 200));
