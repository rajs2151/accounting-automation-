import assert from "node:assert/strict";
import test from "node:test";

import { fiscalYearForDate } from "@/lib/fiscal-year";

test("default January FY = calendar year", () => {
  assert.equal(fiscalYearForDate("2026-05-15", 1), 2026);
  assert.equal(fiscalYearForDate("2026-01-01", 1), 2026);
});

test("April FY start rolls back Jan–Mar", () => {
  assert.equal(fiscalYearForDate("2026-03-15", 4), 2025);
  assert.equal(fiscalYearForDate("2026-04-01", 4), 2026);
  assert.equal(fiscalYearForDate("2026-12-31", 4), 2026);
});
