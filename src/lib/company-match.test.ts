import assert from "node:assert/strict";
import test from "node:test";

import { matchCompany } from "@/lib/company-match";

const COMPANY = {
  companyTrn: "100000000000001",
  companyIban: "AE070331234567890123456",
  companyName: "Desert Falcon Services FZE",
};

test("near-miss TRN does not match as TRN", () => {
  const r = matchCompany({
    ...COMPANY,
    text: "TAX INVOICE\nTRN 100000000000002\nTotal 105.00\n",
  });
  assert.notEqual(r.method, "trn_exact");
  assert.equal(/TRN exact/i.test(r.label), false);
});

test("exact TRN matches", () => {
  const r = matchCompany({
    ...COMPANY,
    text: "Bill To Oasis Retail\nTRN 100000000000001\n",
  });
  assert.equal(r.matched, true);
  assert.equal(r.method, "trn_exact");
  assert.equal(r.needsReview, false);
  assert.match(r.label, /TRN exact/);
});

test("name-only match → needs_review, not auto-assigned, never labelled TRN", () => {
  const r = matchCompany({
    ...COMPANY,
    text: "Invoice for Desert Falcon Services consulting\nTotal 50.00\n",
  });
  assert.equal(r.matched, true);
  assert.equal(r.method, "name_fuzzy");
  assert.equal(r.needsReview, true);
  assert.equal(r.unassigned, false);
  assert.equal(/TRN exact/i.test(r.label), false);
  assert.match(r.label, /name fuzzy/i);
});
