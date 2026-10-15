/**
 * Phase 3 rank 4: CT accrual delta maths + close gate (FY-end blocking).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  booksCtAccrualPreview,
  buildCtAccrualLines,
  ctAccrualDeltaMinor,
  ctAccrualGateFromAmounts,
  ctPayableFromNetMinor,
} from "@/server/books/ct-accrual";
import { getBooksCloseChecklist } from "@/server/books/close";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createTestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";

async function withAdmin(t: test.TestContext) {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const adminUrl = process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return null;
  }
  return admin;
}

test("Phase 3 rank 4: payable + delta helpers", () => {
  assert.equal(ctPayableFromNetMinor(-1_125_000), 1_125_000);
  assert.equal(ctPayableFromNetMinor(50_000), -50_000);
  assert.equal(ctAccrualDeltaMinor(1_125_000, 0), 1_125_000);
  assert.equal(ctAccrualDeltaMinor(1_125_000, 1_125_000), 0);
  assert.equal(ctAccrualDeltaMinor(900_000, 1_125_000), -225_000);
});

test("Phase 3 rank 4: buildCtAccrualLines top-up and reverse", () => {
  const up = buildCtAccrualLines({
    expenseAccountId: "e",
    payableAccountId: "p",
    deltaMinor: 100,
  });
  assert.equal(up.length, 2);
  assert.equal(up[0].accountCode, "8100");
  assert.equal(up[0].debitMinor, 100);
  assert.equal(up[1].accountCode, "2230");
  assert.equal(up[1].creditMinor, 100);

  const rev = buildCtAccrualLines({
    expenseAccountId: "e",
    payableAccountId: "p",
    deltaMinor: -40,
  });
  assert.equal(rev[0].accountCode, "2230");
  assert.equal(rev[0].debitMinor, 40);
  assert.equal(rev[1].accountCode, "8100");
  assert.equal(rev[1].creditMinor, 40);

  assert.deepEqual(
    buildCtAccrualLines({ expenseAccountId: "e", payableAccountId: "p", deltaMinor: 0 }),
    [],
  );
});

test("Phase 3 rank 4: gate blocking only at FY end", () => {
  const mid = ctAccrualGateFromAmounts({
    estimateMinor: 100,
    bookedPayableMinor: 0,
    isFiscalYearEnd: false,
  });
  assert.equal(mid.status, "info");
  assert.equal(mid.blocking, false);

  const yeFail = ctAccrualGateFromAmounts({
    estimateMinor: 100,
    bookedPayableMinor: 0,
    isFiscalYearEnd: true,
  });
  assert.equal(yeFail.status, "fail");
  assert.equal(yeFail.blocking, true);

  const yeOk = ctAccrualGateFromAmounts({
    estimateMinor: 100,
    bookedPayableMinor: 100,
    isFiscalYearEnd: true,
  });
  assert.equal(yeOk.status, "pass");
});

test("Phase 3 rank 4: preview top-up then zero delta after post", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "ct-accrual-rank4");
    const periods = await admin.query(
      `SELECT id, period_end::text AS pe FROM books_periods
       WHERE client_id = $1 ORDER BY period_end DESC LIMIT 1`,
      [company.clientId],
    );
    if (!periods.rowCount) {
      t.skip("no periods");
      return;
    }
    const periodId = String(periods.rows[0].id);
    const periodEnd = String(periods.rows[0].pe).slice(0, 10);

    // Push taxable income well above CT threshold so estimate > 0 (unless SBR/QFZP).
    const rev = company.accountIdByCode["4100"];
    const bank = company.accountIdByCode["1120"] || company.accountIdByCode["1110"];
    assert.ok(rev && bank);
    const draft = await createBooksJournal(OMAR, company.clientId, {
      periodId,
      entryDate: periodEnd,
      memo: "seed revenue for CT",
      lines: [
        { accountId: bank, debitMinor: 50_000_000, creditMinor: 0 },
        { accountId: rev, debitMinor: 0, creditMinor: 50_000_000 },
      ],
      post: false,
      allowControlAccounts: true,
    });
    await postBooksJournal(LAYLA, company.clientId, draft.id);

    const preview = await booksCtAccrualPreview(OMAR, company.clientId, periodId);
    assert.ok(preview.estimateMinor > 0, "estimate should be positive after large revenue");
    assert.equal(preview.bookedPayableMinor, 0);
    assert.equal(preview.deltaMinor, preview.estimateMinor);
    assert.equal(preview.lines.length, 2);
    assert.ok(preview.lines.some((l) => l.accountCode === "8100" && l.debitMinor === preview.deltaMinor));
    assert.ok(preview.lines.some((l) => l.accountCode === "2230" && l.creditMinor === preview.deltaMinor));

    const accrual = await createBooksJournal(OMAR, company.clientId, {
      periodId,
      entryDate: periodEnd,
      memo: preview.memo,
      templateKey: "ct_accrual",
      lines: preview.lines.map((l) => ({
        accountId: l.accountId,
        debitMinor: l.debitMinor,
        creditMinor: l.creditMinor,
        lineMemo: l.lineMemo,
      })),
      post: false,
    });
    await postBooksJournal(LAYLA, company.clientId, accrual.id);

    const after = await booksCtAccrualPreview(OMAR, company.clientId, periodId);
    assert.equal(after.deltaMinor, 0);
    assert.equal(after.lines.length, 0);
    assert.equal(after.bookedPayableMinor, after.estimateMinor);

    const checklist = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    const gate = checklist.gates.find((g) => g.key === "ct_accrual");
    assert.ok(gate);
    assert.equal(gate!.status, "pass");
  } finally {
    await admin.end();
  }
});
