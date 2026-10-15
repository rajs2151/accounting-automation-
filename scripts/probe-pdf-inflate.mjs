import fs from "node:fs";
import zlib from "node:zlib";

const buf = fs.readFileSync("fixtures/extraction/pdfs/invoice_02.pdf");
const latin = buf.toString("latin1");
let i = 0;
for (const m of latin.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
  i += 1;
  let raw = Buffer.from(m[1], "binary");
  // PDF streams often end with \n before endstream already stripped by regex
  while (raw.length && (raw[raw.length - 1] === 10 || raw[raw.length - 1] === 13)) {
    raw = raw.subarray(0, raw.length - 1);
  }
  try {
    const inflated = zlib.inflateSync(raw);
    const s = inflated.toString("latin1");
    console.log("--- stream", i, "len", inflated.length);
    console.log(s.slice(0, 400));
    const tjs = [...s.matchAll(/\(([^)]*)\)\s*Tj/g)].map((x) => x[1]);
    console.log("Tj", tjs);
  } catch (e) {
    console.log("--- stream", i, "inflate fail", e.message, "raw", raw.length);
  }
}
