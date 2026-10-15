import assert from "node:assert/strict";
import test from "node:test";

import { validateInvoiceLineSum } from "@/lib/invoice-validation";

test("INV-SYN-001: 100.00 + VAT 5.00 = 105.00 does not flag line_sum_mismatch", () => {
  const result = validateInvoiceLineSum({
    lines: [{ netMinor: 10000, vatMinor: 500 }],
    grandTotalMinor: 10500,
  });
  assert.deepEqual(result.flags, []);
  assert.equal(result.fieldStatus.grand_total, "ok");
  assert.equal(result.subtotalMinor, 10000);
  assert.equal(result.vatTotalMinor, 500);
  assert.equal(result.computedGrandMinor, 10500);
});

test("real mismatch: 100.00 + VAT 5.00 vs grand 120.00 flags line_sum_mismatch", () => {
  const result = validateInvoiceLineSum({
    lines: [{ netMinor: 10000, vatMinor: 500 }],
    grandTotalMinor: 12000,
  });
  assert.deepEqual(result.flags, ["line_sum_mismatch"]);
  assert.equal(result.fieldStatus.grand_total, "fail");
  assert.equal(result.computedGrandMinor, 10500);
});
