/**
 * Regression tests for Phase 3/4 bugs fixed after the review report.
 * These fail on the pre-fix code and pass with the fixes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  approveAndPostBooksExpense,
  createBooksExpense,
  submitBooksExpense,
  updateBooksExpenseDraft,
} from "@/server/books/expenses";
import {
  createBooksJournal,
  postBooksJournal,
  replaceBooksJournalDraft,
} from "@/server/books/journals";
import { createBooksParty } from "@/server/books/parties";
import { createTestCompany } from "@/server/books/test-company";
import { generateVat201Draft } from "@/server/books/vat201";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const RAJ = "77777777-7777-4777-8777-777777777777";

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
  const ready = await admin.query(`SELECT to_regclass('books_expenses') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/55 expenses not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("P4-reg: auto_reverse job carries reverseOn = 1st of next month", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p4-ar-payload");
    const periodMay = company.periods["May 2026"];
    const rent = company.accountIdByCode["6200"];
    const bank = company.accountIdByCode["1110"];
    assert.ok(periodMay && rent && bank);

    const accrual = await createBooksJournal(OMAR, company.clientId, {
      periodId: periodMay,
      entryDate: "2026-05-31",
      memo: "May accrual reg",
      autoReverseNextPeriod: true,
      lines: [
        { accountId: rent, debitMinor: 2500 },
        { accountId: bank, creditMinor: 2500 },
      ],
      post: false,
    });
    await postBooksJournal(LAYLA, company.clientId, accrual.id);

    const job = await admin.query(
      `SELECT run_at::date AS run_day, payload
       FROM books_jobs
       WHERE client_id = $1 AND kind = 'auto_reverse'
         AND payload->>'entryId' = $2
       ORDER BY created_at DESC LIMIT 1`,
      [company.clientId, accrual.id],
    );
    assert.equal(job.rowCount, 1);
    assert.equal(String(job.rows[0].run_day).slice(0, 10), "2026-06-01");
    const payload =
      typeof job.rows[0].payload === "string"
        ? JSON.parse(job.rows[0].payload)
        : job.rows[0].payload;
    assert.equal(payload.reverseOn, "2026-06-01");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P4-reg: draft replace persists autoReverseNextPeriod", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p4-draft-ar");
    const periodMay = company.periods["May 2026"];
    const rent = company.accountIdByCode["6200"];
    const bank = company.accountIdByCode["1110"];
    assert.ok(periodMay && rent && bank);

    const draft = await createBooksJournal(OMAR, company.clientId, {
      periodId: periodMay,
      entryDate: "2026-05-15",
      memo: "Draft accrual",
      autoReverseNextPeriod: false,
      lines: [
        { accountId: rent, debitMinor: 1000 },
        { accountId: bank, creditMinor: 1000 },
      ],
      post: false,
    });

    await replaceBooksJournalDraft(OMAR, company.clientId, draft.id, {
      periodId: periodMay,
      entryDate: "2026-05-15",
      memo: "Draft accrual",
      autoReverseNextPeriod: true,
      lines: [
        { accountId: rent, debitMinor: 1000 },
        { accountId: bank, creditMinor: 1000 },
      ],
    });

    const row = await admin.query(
      `SELECT auto_reverse_next_period FROM books_journal_entries WHERE id = $1`,
      [draft.id],
    );
    assert.equal(row.rows[0].auto_reverse_next_period, true);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P3-reg: double approve posts only one journal", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p3-dbl-approve");
    const periodId = company.periods["May 2026"];
    const opex = company.accountIdByCode["6600"];
    const reimb = company.accountIdByCode["2130"];
    assert.ok(periodId && opex && reimb);

    const created = await createBooksExpense(OMAR, company.clientId, {
      expenseDate: "2026-05-10",
      periodId,
      description: "Double-click approve",
      paidFromKind: "employee_reimbursable",
      paidFromAccountId: reimb,
      lines: [{ accountId: opex, netMinor: 2000, vatMinor: 0 }],
    });
    await submitBooksExpense(OMAR, company.clientId, created.id);

    const a1 = await approveAndPostBooksExpense(LAYLA, company.clientId, created.id);
    const a2 = await approveAndPostBooksExpense(LAYLA, company.clientId, created.id);
    assert.equal(a1.journalEntryId, a2.journalEntryId);

    const journals = await admin.query(
      `SELECT id FROM books_journal_entries
       WHERE client_id = $1 AND voucher_type = 'Expense'
         AND reference = $2 AND deleted_at IS NULL AND status = 'posted'`,
      [company.clientId, created.expenseNo],
    );
    assert.equal(journals.rowCount, 1);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P3-reg: expense date must fall inside open period; AED-only; VAT only with SR", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p3-validate");
    const periodMay = company.periods["May 2026"];
    const opex = company.accountIdByCode["6600"];
    const reimb = company.accountIdByCode["2130"];
    assert.ok(periodMay && opex && reimb);

    await assert.rejects(
      () =>
        createBooksExpense(OMAR, company.clientId, {
          expenseDate: "2026-07-15",
          periodId: periodMay,
          description: "Wrong period",
          paidFromKind: "employee_reimbursable",
          paidFromAccountId: reimb,
          lines: [{ accountId: opex, netMinor: 1000, vatMinor: 0 }],
        }),
      /expense_date_outside_period/,
    );

    await assert.rejects(
      () =>
        createBooksExpense(OMAR, company.clientId, {
          expenseDate: "2026-05-15",
          periodId: periodMay,
          description: "USD expense",
          currency: "USD",
          paidFromKind: "employee_reimbursable",
          paidFromAccountId: reimb,
          lines: [{ accountId: opex, netMinor: 1000, vatMinor: 0 }],
        }),
      /expense_currency_aed_only/,
    );

    await assert.rejects(
      () =>
        createBooksExpense(OMAR, company.clientId, {
          expenseDate: "2026-05-15",
          periodId: periodMay,
          description: "ZR with VAT",
          paidFromKind: "employee_reimbursable",
          paidFromAccountId: reimb,
          lines: [{ accountId: opex, vatCode: "ZR", netMinor: 1000, vatMinor: 50 }],
        }),
      /expense_vat_requires_sr/,
    );

    // Rejected edit must leave original lines intact
    const draft = await createBooksExpense(OMAR, company.clientId, {
      expenseDate: "2026-05-15",
      periodId: periodMay,
      description: "Keep lines",
      paidFromKind: "employee_reimbursable",
      paidFromAccountId: reimb,
      lines: [{ accountId: opex, vatCode: "SR", netMinor: 1000, vatMinor: 50 }],
    });
    await assert.rejects(
      () =>
        updateBooksExpenseDraft(OMAR, company.clientId, draft.id, {
          lines: [{ accountId: opex, vatCode: "ZR", netMinor: 1000, vatMinor: 50 }],
        }),
      /expense_vat_requires_sr/,
    );
    const lines = await admin.query(
      `SELECT vat_code, vat_minor FROM books_expense_lines WHERE expense_id = $1`,
      [draft.id],
    );
    assert.equal(lines.rowCount, 1);
    assert.equal(String(lines.rows[0].vat_code), "SR");
    assert.equal(Number(lines.rows[0].vat_minor), 50);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P3-reg: creator/editor cannot approve; expense VAT reaches VAT 201 box 9", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p3-dual-vat");
    const periodId = company.periods["May 2026"];
    const opex = company.accountIdByCode["6600"];
    const reimb = company.accountIdByCode["2130"];
    assert.ok(periodId && opex && reimb);

    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [RAJ, company.clientId],
    );

    const supplier = await createBooksParty(OMAR, company.clientId, {
      partyType: "supplier",
      name: "Office Co LLC",
      trn: "100299887766554",
      force: true,
    });

    const created = await createBooksExpense(OMAR, company.clientId, {
      expenseDate: "2026-05-18",
      periodId,
      description: "Stationery with VAT",
      vendorPartyId: supplier.id,
      vendorName: "Office Co LLC",
      paidFromKind: "employee_reimbursable",
      paidFromAccountId: reimb,
      lines: [{ accountId: opex, vatCode: "SR", netMinor: 10000, vatMinor: 500 }],
    });
    // Layla edits → blocked from approving even though Omar submits
    await updateBooksExpenseDraft(LAYLA, company.clientId, created.id, {
      description: "Stationery with VAT (edited)",
    });
    await submitBooksExpense(OMAR, company.clientId, created.id);

    await assert.rejects(
      () => approveAndPostBooksExpense(LAYLA, company.clientId, created.id),
      /post_preparer_cannot_approve/,
    );

    const approved = await approveAndPostBooksExpense(RAJ, company.clientId, created.id);
    assert.equal(approved.status, "approved");
    assert.ok(approved.journalEntryId);

    const jlines = await admin.query(
      `SELECT a.code, l.vat_treatment, l.debit_minor
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1 AND a.code = '1430'`,
      [approved.journalEntryId],
    );
    assert.equal(jlines.rowCount, 1, "recoverable VAT must post to 1430");
    assert.equal(Number(jlines.rows[0].debit_minor), 500);

    const draft = await generateVat201Draft(RAJ, company.clientId, {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    assert.ok(draft.boxes["9"].vatMinor >= 500, "input VAT should land in box 9");
    assert.ok(draft.boxes["9"].amountMinor >= 10000, "net should land in box 9 amount");
    assert.ok(draft.box13RecoverableTaxMinor >= 500);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P4-reg: Jun 2026 period exists for auto-reverse target date", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p4-jun-period");
    assert.ok(company.periods["Jun 2026"], "Jun 2026 period required for auto-reverse");
    const jun = await admin.query(
      `SELECT status FROM books_periods WHERE id = $1`,
      [company.periods["Jun 2026"]],
    );
    assert.equal(String(jun.rows[0].status), "OPEN");
  } finally {
    await admin.end().catch(() => undefined);
  }
});
