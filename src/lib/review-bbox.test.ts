import assert from "node:assert/strict";
import test from "node:test";

import {
  bboxCentreOnText,
  invoiceSyn001DemoBboxes,
  INVOICE_SYN_001_TEXT_RECTS,
} from "@/lib/review-bbox";

test("demo invoice bbox centres fall on the value text", () => {
  const boxes = invoiceSyn001DemoBboxes();
  for (const key of ["invoice_no", "grand_total", "supplier_name"] as const) {
    assert.ok(
      bboxCentreOnText(boxes[key], INVOICE_SYN_001_TEXT_RECTS[key]),
      `${key} centre not on text`,
    );
  }
});
