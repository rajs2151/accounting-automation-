import assert from "node:assert/strict";
import test from "node:test";

import { monthlyLoanInterestMinor } from "@/server/books/loans";

test("Phase 3 rank 9: monthly interest floor maths", () => {
  // 100,000.00 AED @ 5% → 500_000 fils/year → 41_666 fils/month
  assert.equal(monthlyLoanInterestMinor(10_000_000, 500), 41_666);
  assert.equal(monthlyLoanInterestMinor(0, 500), 0);
  assert.equal(monthlyLoanInterestMinor(10_000_000, 0), 0);
});
