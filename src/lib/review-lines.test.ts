import assert from "node:assert/strict";
import test from "node:test";

import { normalizeReviewLines } from "@/lib/review-lines";

test("normalizeReviewLines does not invent 0.00 or use filename as description", () => {
  const rows = normalizeReviewLines([
    { description: "bill-scan.png", netMinor: null, vatMinor: null },
    { description: "Consulting", netMinor: 10000, vatMinor: 500, vatCode: "SR" },
  ]);
  assert.equal(rows[0].description, "");
  assert.equal(rows[0].netMinor, null);
  assert.equal(rows[0].vatMinor, null);
  assert.equal(rows[1].description, "Consulting");
  assert.equal(rows[1].netMinor, 10000);
  assert.equal(rows[1].vatMinor, 500);
});
