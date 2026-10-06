import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJournalTemplate,
  warnPrepaymentBookedAsAccrual,
} from "@/lib/journal-templates";

test("P4-3: accrual template enables auto-reverse and uses 2120", () => {
  const t = buildJournalTemplate("accrual");
  assert.equal(t.autoReverseNextPeriod, true);
  assert.ok(t.lines.some((l) => l.accountCode === "2120" && l.side === "credit"));
  assert.ok(t.lines.some((l) => l.side === "debit"));
  assert.match(String(t.hint || ""), /auto-reverse/i);
});

test("P4-3: prepayment template uses asset 1410 and warns", () => {
  const t = buildJournalTemplate("prepayment");
  assert.equal(t.autoReverseNextPeriod, false);
  assert.ok(t.lines.some((l) => l.accountCode === "1410" && l.side === "debit"));
  assert.ok(t.lines.some((l) => l.accountCode === "1120" && l.side === "credit"));
  assert.match(String(t.warning || ""), /1410|asset/i);
});

test("P4-3: warn when expense + accrued looks like prepaid mistake", () => {
  const accounts = [
    { id: "e1", code: "6500", accountType: "expense" },
    { id: "a1", code: "2120", accountType: "liability" },
    { id: "p1", code: "1410", accountType: "asset" },
  ];
  const bad = warnPrepaymentBookedAsAccrual(
    [
      { accountId: "e1", debitMinor: 0, creditMinor: 0 },
      { accountId: "a1", debitMinor: 0, creditMinor: 0 },
    ],
    accounts,
  );
  assert.ok(bad);
  assert.match(bad!, /prepayment|1410/i);

  const okPrepaid = warnPrepaymentBookedAsAccrual(
    [
      { accountId: "p1", debitMinor: 10000, creditMinor: 0 },
      { accountId: "a1", debitMinor: 0, creditMinor: 10000 },
    ],
    accounts,
  );
  assert.equal(okPrepaid, null);
});

test("P4-3: payroll template seeds salaries", () => {
  const t = buildJournalTemplate("payroll");
  assert.ok(t.lines.some((l) => l.accountCode === "6100"));
});
