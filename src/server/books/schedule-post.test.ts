import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { createBooksJournal, postBooksJournal } from "./journals";
import { booksTrialBalance } from "./trial-balance";
import { createTestCompany } from "./test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";

function appUrl() {
  return process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
}

function adminUrl() {
  return process.env.DATABASE_URL_SUPER || appUrl().replace("://daftar_app:", "://daftar:");
}

test("schedule_post posts due rent; VAT settlement is two-step", async (t) => {
  process.env.DATABASE_URL = appUrl();
  const admin = new pg.Client({ connectionString: adminUrl() });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return;
  }
  try {
    const ready = await admin.query(`SELECT to_regclass('books_jobs') AS t`);
    if (!ready.rows[0]?.t) {
      t.skip("books seed not applied");
      return;
    }

    const company = await createTestCompany(admin, "schedule-post");
    const clientId = company.clientId;
    const periodMay = company.periods["May 2026"];
    const periodJun = company.periods["Jun 2026"];
    const rent = company.accountIdByCode["6200"];
    const bank = company.accountIdByCode["1120"];
    const vatOut = company.accountIdByCode["2210"];
    const vatPay = company.accountIdByCode["2220"];
    assert.ok(periodMay && periodJun && rent && bank && vatOut && vatPay);

    // May rent (posted) — TB period debit 8000
    const mayDraft = await createBooksJournal(OMAR, clientId, {
      periodId: periodMay,
      entryDate: "2026-05-01",
      memo: "Office rent May",
      lines: [
        { accountId: rent, debitMinor: 8000 },
        { accountId: bank, creditMinor: 8000 },
      ],
      post: false,
    });
    await postBooksJournal(LAYLA, clientId, mayDraft.id);

    // June rent scheduled + due job
    const schedRent = await createBooksJournal(OMAR, clientId, {
      periodId: periodJun,
      entryDate: "2026-06-01",
      memo: "Office rent June",
      scheduledFor: "2026-06-01",
      lines: [
        { accountId: rent, debitMinor: 8000 },
        { accountId: bank, creditMinor: 8000 },
      ],
      post: false,
    });

    // VAT return (posted Journal) + payment (posted Payment)
    const vatReturnDraft = await createBooksJournal(OMAR, clientId, {
      periodId: periodJun,
      entryDate: "2026-06-28",
      memo: "VAT return Jun 2026",
      voucherType: "Journal",
      lines: [
        { accountId: vatOut, debitMinor: 500 },
        { accountId: vatPay, creditMinor: 500 },
      ],
      post: false,
      allowControlAccounts: true,
    });
    const vatReturnPosted = await postBooksJournal(LAYLA, clientId, vatReturnDraft.id);

    const vatPayDraft = await createBooksJournal(OMAR, clientId, {
      periodId: periodJun,
      entryDate: "2026-06-29",
      memo: "VAT payment Jun 2026",
      voucherType: "Payment",
      lines: [
        { accountId: vatPay, debitMinor: 500 },
        { accountId: bank, creditMinor: 500 },
      ],
      post: false,
      allowControlAccounts: true,
    });
    const vatPayPosted = await postBooksJournal(LAYLA, clientId, vatPayDraft.id);

    const n = await admin.query(`SELECT books_run_due_schedule_posts() AS n`);
    assert.ok(Number(n.rows[0].n) >= 0);

    const rentRow = await admin.query(
      `SELECT status, entry_no, reference, memo FROM books_journal_entries WHERE id = $1`,
      [schedRent.id],
    );
    assert.equal(rentRow.rows[0].status, "posted", "June scheduled rent must be posted by job");
    assert.match(String(rentRow.rows[0].entry_no || ""), /^(JV|JE)-2026-\d{4}$/);
    assert.equal(String(rentRow.rows[0].memo), "Office rent June");

    const vatReturn = await admin.query(
      `SELECT status, entry_type, voucher_type FROM books_journal_entries WHERE id = $1`,
      [vatReturnPosted.id],
    );
    if (!vatReturn.rowCount) {
      t.skip("VAT two-step seed (22) not applied");
      return;
    }
    assert.equal(vatReturn.rows[0].status, "posted");
    assert.equal(vatReturn.rows[0].entry_type, "manual");
    assert.equal(vatReturn.rows[0].voucher_type, "Journal");

    const vatPayRow = await admin.query(
      `SELECT status, voucher_type FROM books_journal_entries WHERE id = $1`,
      [vatPayPosted.id],
    );
    assert.equal(vatPayRow.rows[0].status, "posted");
    assert.equal(vatPayRow.rows[0].voucher_type, "Payment");

    const tbMay = await booksTrialBalance(OMAR, clientId, periodMay);
    assert.equal(tbMay.accounts["6200"]?.periodDebitMinor, 8000, "May rent only");

    const tbJun = await booksTrialBalance(OMAR, clientId, periodJun);
    assert.equal(tbJun.accounts["6200"]?.periodDebitMinor, 8000, "June rent only");

    const fn = await admin.query(
      `SELECT pg_get_functiondef('books_run_due_schedule_posts()'::regprocedure) AS def`,
    );
    assert.match(String(fn.rows[0].def), /status = 'blocked'/);
    assert.match(String(fn.rows[0].def), /LOCKED/);

    // P4-4: auto-reverse job is queued for 1st of next month, not immediately
    const accrual = await createBooksJournal(OMAR, clientId, {
      periodId: periodMay,
      entryDate: "2026-05-31",
      memo: "May accrual",
      autoReverseNextPeriod: true,
      lines: [
        { accountId: rent, debitMinor: 2500 },
        { accountId: bank, creditMinor: 2500 },
      ],
      post: false,
    });
    await postBooksJournal(LAYLA, clientId, accrual.id);
    const arJob = await admin.query(
      `SELECT run_at::date AS run_day, kind, status
       FROM books_jobs
       WHERE client_id = $1 AND kind = 'auto_reverse'
         AND payload->>'entryId' = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [clientId, accrual.id],
    );
    assert.equal(arJob.rowCount, 1);
    assert.equal(String(arJob.rows[0].run_day).slice(0, 10), "2026-06-01");
  } finally {
    await admin.end().catch(() => undefined);
  }
});
