import assert from "node:assert/strict";
import test from "node:test";

import {
  bboxCentreOnText,
  boxesFromFieldSources,
  filterBoxesForPage,
  invoiceSyn001DemoBboxes,
  INVOICE_SYN_001_TEXT_RECTS,
  pageBBoxFromSource,
  scaleBBoxToRender,
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

test("page 2 box at zoom 1.5 maps to the right pixels", () => {
  const source = { page: 2, bbox: [100, 200, 180, 220] as [number, number, number, number] };
  const box = pageBBoxFromSource("grand_total", source, 595, 842);
  assert.ok(box);
  assert.equal(box.page, 2);
  const rendered = scaleBBoxToRender(box, 1.5);
  assert.equal(rendered.left, 150);
  assert.equal(rendered.top, 300);
  assert.equal(rendered.width, 120);
  assert.equal(rendered.height, 30);
});

test("filterBoxesForPage keeps only the requested page", () => {
  const boxes = boxesFromFieldSources(
    {
      invoice_no: { source: { page: 1, bbox: [10, 10, 50, 20] } },
      grand_total: { source: { page: 2, bbox: [100, 200, 180, 220] } },
      missing: { source: null },
    },
    { 1: { width: 595, height: 842 }, 2: { width: 595, height: 842 } },
  );
  assert.equal(boxes.length, 2);
  assert.equal(filterBoxesForPage(boxes, 2).length, 1);
  assert.equal(filterBoxesForPage(boxes, 2)[0].label, "grand_total");
  assert.equal(filterBoxesForPage(boxes, 1)[0].label, "invoice_no");
});
