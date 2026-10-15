import assert from "node:assert/strict";
import test from "node:test";

import { buildSimplePdf } from "@/server/books/pdf";

test("P6-3: simple PDF has header, section title and page footer", () => {
  const buf = buildSimplePdf({
    brand: "Arnifi · arnibooks",
    company: "Desert Falcon Services FZE",
    periodLabel: "2026-05-01 → 2026-05-31 (monthly)",
    preparedBy: "Layla Hassan",
    generatedAt: "2026-10-07T00:00:00.000Z",
    sections: [
      { title: "Profit & Loss", lines: ["Net profit  |  100.00"] },
      { title: "Balance Sheet", lines: ["Total assets  |  1100.00"] },
    ],
  });
  const text = buf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.match(text, /Arnifi/);
  assert.match(text, /Desert Falcon/);
  assert.match(text, /Profit & Loss/);
  assert.match(text, /Page 1 of 2/);
  assert.match(text, /%%EOF/);
});
