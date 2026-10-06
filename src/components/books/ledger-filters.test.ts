import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_LEDGER_FILTERS,
  VOUCHER_TYPE_FILTERS,
  buildJournalsQuery,
} from "@/components/books/ledger-filters";

test("P4-1: buildJournalsQuery encodes period, search, types, statuses, filters", () => {
  const qs = buildJournalsQuery(
    "period-1",
    " rent ",
    ["manual", "auto"],
    ["posted", "draft"],
    {
      ...EMPTY_LEDGER_FILTERS,
      voucherTypes: ["Expense", "Journal"],
      fromDate: "2026-05-01",
      toDate: "2026-05-31",
      amountMin: "10.50",
      amountMax: "100",
      hasAttachment: "yes",
      tags: ["ops"],
    },
  );
  const p = new URLSearchParams(qs);
  assert.equal(p.get("periodId"), "period-1");
  assert.equal(p.get("q"), "rent");
  assert.equal(p.get("entryType"), "manual,auto");
  assert.equal(p.get("status"), "posted,draft");
  assert.equal(p.get("voucherType"), "Expense,Journal");
  assert.equal(p.get("fromDate"), "2026-05-01");
  assert.equal(p.get("toDate"), "2026-05-31");
  assert.equal(p.get("amountMinMinor"), "1050");
  assert.equal(p.get("amountMaxMinor"), "10000");
  assert.equal(p.get("hasAttachment"), "1");
  assert.equal(p.get("tags"), "ops");
});

test("P4-1: Expense is a voucher filter option", () => {
  assert.ok((VOUCHER_TYPE_FILTERS as readonly string[]).includes("Expense"));
});
