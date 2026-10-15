import assert from "node:assert/strict";
import test from "node:test";

import { mapWorkerFieldsToDisplay } from "@/lib/review-fields";
import { workerField, workerInvoiceFieldsJson } from "@/server/books/test-fixtures/worker-extraction";

test("worker net/vat/gross fils → display AED strings", () => {
  const mapped = mapWorkerFieldsToDisplay(
    workerInvoiceFieldsJson({
      invoiceNo: "INV-1",
      netMinor: 10000,
      vatMinor: 500,
      grossMinor: 10500,
    }) as unknown as Record<string, unknown>,
  );
  assert.equal(mapped.subtotal?.value, "100.00");
  assert.equal(mapped.vat_total?.value, "5.00");
  assert.equal(mapped.grand_total?.value, "105.00");
});

test("gross missing but grand_total fils → display grand total", () => {
  const mapped = mapWorkerFieldsToDisplay({
    grand_total: workerField(10500),
  } as unknown as Record<string, unknown>);
  assert.equal(mapped.grand_total?.value, "105.00");
  assert.equal(mapped.subtotal, undefined);
});

test("net null → empty string with status missing", () => {
  const mapped = mapWorkerFieldsToDisplay({
    net: workerField(null),
  } as unknown as Record<string, unknown>);
  assert.equal(mapped.subtotal?.value, "");
  assert.equal(mapped.subtotal?.status, "missing");
});

test("ISO invoice_date → dd/mm/yyyy", () => {
  const mapped = mapWorkerFieldsToDisplay({
    invoice_date: workerField("2026-05-15"),
  } as unknown as Record<string, unknown>);
  assert.equal(mapped.invoice_date?.value, "15/05/2026");
});

test("legacy string subtotal still maps", () => {
  const mapped = mapWorkerFieldsToDisplay({
    subtotal: { value: "100.00", confidence: 0.9, status: "ok", source: null },
  });
  assert.equal(mapped.subtotal?.value, "100.00");
});
