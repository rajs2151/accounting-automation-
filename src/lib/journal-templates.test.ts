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

test("Phase 3 rank 2: income accrual Dr 1210 / Cr 4100 with auto-reverse", () => {
  const t = buildJournalTemplate("income_accrual");
  assert.equal(t.autoReverseNextPeriod, true);
  assert.ok(t.lines.some((l) => l.accountCode === "1210" && l.side === "debit"));
  assert.ok(t.lines.some((l) => l.accountCode === "4100" && l.side === "credit"));
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

test("Phase 3 rank 5: payroll template Dr 6100 / Cr 2330", () => {
  const t = buildJournalTemplate("payroll");
  assert.ok(t.lines.some((l) => l.accountCode === "6100" && l.side === "debit"));
  assert.ok(t.lines.some((l) => l.accountCode === "2330" && l.side === "credit"));
  assert.ok(!t.lines.some((l) => l.accountCode === "2120"));
  assert.match(String(t.hint || ""), /2330/);
});

test("Phase 3 rank 4: CT accrual template Dr 8100 / Cr 2230", () => {
  const t = buildJournalTemplate("ct_accrual");
  assert.equal(t.autoReverseNextPeriod, false);
  assert.ok(t.lines.some((l) => l.accountCode === "8100" && l.side === "debit"));
  assert.ok(t.lines.some((l) => l.accountCode === "2230" && l.side === "credit"));
  assert.match(String(t.hint || ""), /estimate/i);
});

test("Phase 3 rank 7: bad debt template Dr 4900 / Cr 1210", () => {
  const t = buildJournalTemplate("bad_debt");
  assert.ok(t.lines.some((l) => l.accountCode === "4900" && l.side === "debit"));
  assert.ok(t.lines.some((l) => l.accountCode === "1210" && l.side === "credit"));
  assert.match(String(t.warning || ""), /open item/i);
});

test("Phase 3 rank 8: EOSB accrual Dr 6110 / Cr 2410", () => {
  const t = buildJournalTemplate("eosb_accrual");
  assert.ok(t.lines.some((l) => l.accountCode === "6110" && l.side === "debit"));
  assert.ok(t.lines.some((l) => l.accountCode === "2410" && l.side === "credit"));
});

test("Phase 3 rank 9: loan interest template Dr 7400 / Cr 2420", () => {
  const t = buildJournalTemplate("loan_interest");
  assert.ok(t.lines.some((l) => l.accountCode === "7400" && l.side === "debit"));
  assert.ok(t.lines.some((l) => l.accountCode === "2420" && l.side === "credit"));
});

test("Phase 3 rank 10: staff advance + recovery templates use 1230", () => {
  const pay = buildJournalTemplate("staff_advance");
  assert.ok(pay.lines.some((l) => l.accountCode === "1230" && l.side === "debit"));
  assert.ok(pay.lines.some((l) => l.accountCode === "1120" && l.side === "credit"));
  const rec = buildJournalTemplate("staff_advance_recovery");
  assert.ok(rec.lines.some((l) => l.accountCode === "1230" && l.side === "credit"));
  assert.ok(rec.lines.some((l) => l.accountCode === "2330" && l.side === "credit"));
});
