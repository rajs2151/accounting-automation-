/**
 * Phase 3/4 review fixes: expense approve idempotency + dual control, expense validation (period
 * dates, AED only, paid-from tenancy, zero lines, VAT only with SR), expense input VAT on VAT 201,
 * and accrual auto-reverse dating. Synthetic data only; every test makes its own company.
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
import { firstOfNextMonthIso } from "@/lib/schedule-dates";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createTestCompany } from "@/server/books/test-company";
import { generateVat201Draft } from "@/server/books/vat201";

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
  const ready = await admin.query(`SELECT to_regclass('books_expenses') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/55 expenses not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

type Company = Awaited<ReturnType<typeof createTestCompany>>;

function draft(c: Company, over: Record<string, unknown> = {}, line: Record<string, unknown> = {}) {
  return {
    expenseDate: "2026-05-14",
    periodId: c.periods["May 2026"]!,
    description: "Hardening test",
    paidFromKind: "employee_reimbursable" as const,
    paidFromAccountId: c.accountIdByCode["2130"]!,
    lines: [{ accountId: c.accountIdByCode["6600"]!, netMinor: 5000, vatMinor: 0, ...line }],
    ...over,
  };
}

async function rejects(p: Promise<unknown>, message: string) {
  await assert.rejects(p, (err: Error) => {
    assert.equal(err.message, message);
    return true;
  });
}

test("expense approve: parallel approvals post exactly one journal", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "exp-h-conc");
    const e = await createBooksExpense(OMAR, c.clientId, draft(c));
    await submitBooksExpense(OMAR, c.clientId, e.id);
    const results = await Promise.allSettled([1, 2, 3].map(() => approveAndPostBooksExpense(LAYLA, c.clientId, e.id)));
    // Losers either fail with a conflict or join the winner — never a second journal.
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ journalEntryId: string | null }>[];
    assert.ok(ok.length >= 1);
    assert.equal(new Set(ok.map((r) => r.value.journalEntryId)).size, 1, "all callers report the same journal");
    const posted = await admin.query(
      `SELECT count(*)::int AS n FROM books_journal_entries
       WHERE client_id = $1 AND voucher_type = 'Expense' AND status = 'posted' AND deleted_at IS NULL`,
      [c.clientId],
    );
    assert.equal(posted.rows[0].n, 1);
    const exp = await admin.query(`SELECT status, journal_entry_id FROM books_expenses WHERE id = $1`, [e.id]);
    assert.equal(exp.rows[0].status, "approved");
    // A later approve does not post again.
    await approveAndPostBooksExpense(LAYLA, c.clientId, e.id).catch(() => undefined);
    const again = await admin.query(
      `SELECT count(*)::int AS n FROM books_journal_entries
       WHERE client_id = $1 AND voucher_type = 'Expense' AND status = 'posted' AND deleted_at IS NULL`,
      [c.clientId],
    );
    assert.equal(again.rows[0].n, 1);
  } finally {
    await admin.end();
  }
});

test("expense approve: retry after a failure past posting resumes instead of double-posting", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "exp-h-resume");
    const e = await createBooksExpense(OMAR, c.clientId, draft(c));
    await submitBooksExpense(OMAR, c.clientId, e.id);
    // Simulate a crash after posting: journal posted + linked, expense still pending.
    const j = await createBooksJournal(OMAR, c.clientId, {
      periodId: c.periods["May 2026"]!,
      entryDate: "2026-05-14",
      memo: "pre-posted",
      voucherType: "Expense",
      lines: [
        { accountId: c.accountIdByCode["6600"]!, debitMinor: 5000, creditMinor: 0 },
        { accountId: c.accountIdByCode["2130"]!, debitMinor: 0, creditMinor: 5000 },
      ],
      post: false,
    });
    await postBooksJournal(LAYLA, c.clientId, j.id);
    await admin.query(`UPDATE books_expenses SET journal_entry_id = $2 WHERE id = $1`, [e.id, j.id]);
    const res = await approveAndPostBooksExpense(LAYLA, c.clientId, e.id);
    assert.equal(res.status, "approved");
    assert.equal(res.journalEntryId, j.id);
    const n = await admin.query(
      `SELECT count(*)::int AS n FROM books_journal_entries
       WHERE client_id = $1 AND voucher_type = 'Expense' AND status = 'posted'`,
      [c.clientId],
    );
    assert.equal(n.rows[0].n, 1);
  } finally {
    await admin.end();
  }
});

test("expense dual control: creator or editor cannot approve, even if someone else submitted", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "exp-h-dual");
    const created = await createBooksExpense(LAYLA, c.clientId, draft(c));
    await submitBooksExpense(OMAR, c.clientId, created.id);
    await rejects(approveAndPostBooksExpense(LAYLA, c.clientId, created.id), "post_preparer_cannot_approve");

    const edited = await createBooksExpense(OMAR, c.clientId, draft(c));
    await updateBooksExpenseDraft(LAYLA, c.clientId, edited.id, {
      lines: [{ accountId: c.accountIdByCode["6600"]!, netMinor: 7000, vatMinor: 0 }],
    });
    await submitBooksExpense(OMAR, c.clientId, edited.id);
    await rejects(approveAndPostBooksExpense(LAYLA, c.clientId, edited.id), "post_preparer_cannot_approve");
  } finally {
    await admin.end();
  }
});

test("expense validation: date in period, AED only, own paid-from account, no zero lines, VAT only with SR", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "exp-h-valid");
    const other = await createTestCompany(admin, "exp-h-valid-other");
    await rejects(createBooksExpense(OMAR, c.clientId, draft(c, { expenseDate: "2026-07-15" })), "expense_date_outside_period");
    await rejects(createBooksExpense(OMAR, c.clientId, draft(c, { currency: "USD" })), "expense_currency_aed_only");
    await rejects(
      createBooksExpense(OMAR, c.clientId, draft(c, {}, { vatCode: "ZR", vatMinor: 250 })),
      "expense_vat_requires_sr",
    );

    const e = await createBooksExpense(OMAR, c.clientId, draft(c));
    await rejects(
      updateBooksExpenseDraft(OMAR, c.clientId, e.id, { expenseDate: "2026-07-01" }),
      "expense_date_outside_period",
    );
    await rejects(
      updateBooksExpenseDraft(OMAR, c.clientId, e.id, { paidFromAccountId: other.accountIdByCode["1120"]! }),
      "account_not_found",
    );
    await rejects(
      updateBooksExpenseDraft(OMAR, c.clientId, e.id, {
        lines: [{ accountId: c.accountIdByCode["6600"]!, netMinor: 0, vatMinor: 0 }],
      }),
      "zero_amount",
    );
    // A failed line edit leaves the original lines in place.
    const lines = await admin.query(`SELECT net_minor FROM books_expense_lines WHERE expense_id = $1`, [e.id]);
    assert.deepEqual(lines.rows.map((r) => Number(r.net_minor)), [5000]);
  } finally {
    await admin.end();
  }
});

test("expense input VAT (SR, supplier with TRN) is reported in VAT 201 box 9", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "exp-h-vat201");
    const party = await admin.query(
      `INSERT INTO books_parties (client_id, party_type, name, trn)
       VALUES ($1, 'supplier', 'Synthetic TRN Vendor', '100000000000095') RETURNING id`,
      [c.clientId],
    );
    const e = await createBooksExpense(
      OMAR,
      c.clientId,
      draft(c, { vendorPartyId: party.rows[0].id }, { vatCode: "SR", netMinor: 10000, vatMinor: 500 }),
    );
    await submitBooksExpense(OMAR, c.clientId, e.id);
    await approveAndPostBooksExpense(LAYLA, c.clientId, e.id);
    const v = await generateVat201Draft(LAYLA, c.clientId, { from: "2026-05-01", to: "2026-05-31" });
    assert.equal(v.boxes["9"].amountMinor, 10000);
    assert.equal(v.boxes["9"].vatMinor, 500);
    assert.equal(v.box13RecoverableTaxMinor, 500);
    assert.equal(v.unlinked.inputVatMinor, 0);
  } finally {
    await admin.end();
  }
});

test("accrual auto-reverse: queued for the 1st of the next month, not now", async (t) => {
  assert.equal(firstOfNextMonthIso("2026-09-30"), "2026-10-01");
  assert.equal(firstOfNextMonthIso("2026-12-31"), "2027-01-01");
  assert.equal(firstOfNextMonthIso("2026-02-28"), "2026-03-01");
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "jnl-h-autorev");
    const j = await createBooksJournal(OMAR, c.clientId, {
      periodId: c.periods["May 2026"]!,
      entryDate: "2026-05-31",
      memo: "Accrued expense",
      autoReverseNextPeriod: true,
      lines: [
        { accountId: c.accountIdByCode["6600"]!, debitMinor: 1000000, creditMinor: 0 },
        { accountId: c.accountIdByCode["2130"]!, debitMinor: 0, creditMinor: 1000000 },
      ],
      post: false,
    });
    await postBooksJournal(LAYLA, c.clientId, j.id);
    const job = await admin.query(
      `SELECT payload, run_at FROM books_jobs WHERE client_id = $1 AND kind = 'auto_reverse'`,
      [c.clientId],
    );
    assert.equal(job.rowCount, 1);
    assert.equal(job.rows[0].payload.reverseOn, "2026-06-01");
    assert.ok(new Date(job.rows[0].run_at) >= new Date("2026-05-31T20:00:00.000Z"), "not queued for now");
  } finally {
    await admin.end();
  }
});
