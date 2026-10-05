import assert from "node:assert/strict";
import test from "node:test";

import { vatByCodeSummary } from "@/lib/vat-by-code";

test("vatByCodeSummary groups integer fils by code", () => {
  const rows = vatByCodeSummary([
    { vatCode: "SR", netMinor: 10000, vatMinor: 500 },
    { vatCode: "SR", netMinor: 20000, vatMinor: 1000 },
    { vatCode: "ZR", netMinor: 5000, vatMinor: 0 },
  ]);
  assert.equal(rows.length, 2);
  const sr = rows.find((r) => r.code === "SR");
  const zr = rows.find((r) => r.code === "ZR");
  assert.ok(sr);
  assert.ok(zr);
  assert.equal(sr!.netMinor, 30000);
  assert.equal(sr!.vatMinor, 1500);
  assert.equal(sr!.display, "SR 5% on 300.00 = 15.00");
  assert.equal(zr!.display, "Zero-rated on 50.00 = 0.00");
});

test("vatByCodeSummary only includes codes present on lines", () => {
  const rows = vatByCodeSummary([{ vatCode: "EX", netMinor: 1000, vatMinor: 0 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.code, "EX");
  assert.ok(!rows.some((r) => r.code === "SR"));
});

test("vatByCodeSummary empty lines → empty summary", () => {
  assert.deepEqual(vatByCodeSummary([]), []);
});
