import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  approveAndPostBooksExpense,
  createBooksExpense,
  getBooksExpense,
  listBooksExpenses,
  rejectBooksExpense,
  resubmitBooksExpense,
  softDeleteBooksExpenseDraft,
  submitBooksExpense,
  updateBooksExpenseDraft,
} from "@/server/books/expenses";
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
  const ready = await admin.query(`SELECT to_regclass('books_expenses') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/55 expenses not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("P3-1: create draft expense with EXP number, update, soft-delete", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  try {
    const company = await createTestCompany(admin, "p3-1-exp");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const opex = company.accountIdByCode["6600"];
    const reimb = company.accountIdByCode["2130"];
    assert.ok(periodId && opex && reimb);

    const created = await createBooksExpense(OMAR, clientId, {
      expenseDate: "2026-05-12",
      periodId,
      description: "Office stationery",
      vendorName: "Paper Mart LLC",
      paidFromKind: "employee_reimbursable",
      paidFromAccountId: reimb,
      lines: [
        {
          description: "Notebooks",
          accountId: opex,
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
        },
      ],
    });

    assert.match(created.expenseNo, /^EXP-2026-\d{4}$/);
    assert.equal(created.status, "draft");
    assert.equal(created.netMinor, 10000);
    assert.equal(created.vatMinor, 500);
    assert.equal(created.grossMinor, 10500);
    assert.equal(created.paidFromKind, "employee_reimbursable");

    const got = await getBooksExpense(OMAR, clientId, created.id);
    assert.equal(got.lines?.length, 1);
    assert.equal(got.lines![0].accountCode, "6600");
    assert.equal(got.lines![0].grossMinor, 10500);

    const listed = await listBooksExpenses(OMAR, clientId, { status: "draft", q: "stationery" });
    assert.ok(listed.some((r) => r.id === created.id));

    const updated = await updateBooksExpenseDraft(OMAR, clientId, created.id, {
      description: "Office stationery (updated)",
      lines: [
        {
          description: "Notebooks + pens",
          accountId: opex,
          vatCode: "SR",
          netMinor: 20000,
          vatMinor: 1000,
        },
      ],
    });
    assert.equal(updated.description, "Office stationery (updated)");
    assert.equal(updated.grossMinor, 21000);

    const del = await softDeleteBooksExpenseDraft(OMAR, clientId, created.id);
    assert.equal(del.deleted, true);
    const after = await listBooksExpenses(OMAR, clientId, { q: "stationery" });
    assert.ok(!after.some((r) => r.id === created.id));
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P3-1: vat without code rejected; zero line rejected", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  try {
    const company = await createTestCompany(admin, "p3-1-vat");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const opex = company.accountIdByCode["6600"];
    assert.ok(periodId && opex);

    await assert.rejects(
      () =>
        createBooksExpense(OMAR, clientId, {
          expenseDate: "2026-05-12",
          periodId,
          description: "bad vat",
          lines: [{ accountId: opex, netMinor: 1000, vatMinor: 50 }],
        }),
      /vat_code_required/,
    );

    await assert.rejects(
      () =>
        createBooksExpense(OMAR, clientId, {
          expenseDate: "2026-05-12",
          periodId,
          description: "zero",
          lines: [{ accountId: opex, netMinor: 0, vatMinor: 0 }],
        }),
      /zero_amount|invalid_money/,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P3-2: submit → approve posts EXP journal; dual control", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  try {
    const company = await createTestCompany(admin, "p3-2-approve");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const opex = company.accountIdByCode["6600"];
    const reimb = company.accountIdByCode["2130"];
    assert.ok(periodId && opex && reimb);

    const created = await createBooksExpense(OMAR, clientId, {
      expenseDate: "2026-05-14",
      periodId,
      description: "Taxi to client",
      vendorName: "Careem",
      paidFromKind: "employee_reimbursable",
      paidFromAccountId: reimb,
      lines: [{ accountId: opex, description: "Taxi", vatCode: null, netMinor: 5000, vatMinor: 0 }],
    });

    await assert.rejects(
      () => approveAndPostBooksExpense(LAYLA, clientId, created.id),
      /expense_not_pending/,
    );

    const submitted = await submitBooksExpense(OMAR, clientId, created.id);
    assert.equal(submitted.status, "pending");
    assert.equal(submitted.submittedBy, OMAR);

    await assert.rejects(
      () => approveAndPostBooksExpense(OMAR, clientId, created.id),
      /post_preparer_cannot_approve|post_requires_approver/,
    );

    const approved = await approveAndPostBooksExpense(LAYLA, clientId, created.id);
    assert.equal(approved.status, "approved");
    assert.ok(approved.journalEntryId);
    assert.match(String(approved.entryNo || ""), /^EXP-2026-\d{4}$/);

    const je = await admin.query(
      `SELECT status, voucher_type, entry_no, created_by FROM books_journal_entries WHERE id = $1`,
      [approved.journalEntryId],
    );
    assert.equal(String(je.rows[0].status), "posted");
    assert.equal(String(je.rows[0].voucher_type), "Expense");
    assert.equal(String(je.rows[0].created_by), OMAR);

    const jlines = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1
       ORDER BY a.code`,
      [approved.journalEntryId],
    );
    const byCode = Object.fromEntries(
      jlines.rows.map((r) => [
        String(r.code),
        { dr: Number(r.debit_minor), cr: Number(r.credit_minor) },
      ]),
    );
    assert.equal(byCode["6600"]?.dr, 5000);
    assert.equal(byCode["2130"]?.cr, 5000);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P3-2: reject requires reason; resubmit returns to pending", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  try {
    const company = await createTestCompany(admin, "p3-2-reject");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const opex = company.accountIdByCode["6600"];
    const petty = company.accountIdByCode["1110"];
    assert.ok(periodId && opex && petty);

    const created = await createBooksExpense(OMAR, clientId, {
      expenseDate: "2026-05-16",
      periodId,
      description: "Coffee",
      paidFromKind: "petty_cash",
      paidFromAccountId: petty,
      lines: [{ accountId: opex, netMinor: 1500, vatMinor: 0 }],
    });
    await submitBooksExpense(OMAR, clientId, created.id);

    await assert.rejects(() => rejectBooksExpense(LAYLA, clientId, created.id, "  "), /rejection_reason/);

    const rejected = await rejectBooksExpense(LAYLA, clientId, created.id, "Missing receipt");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejectionReason, "Missing receipt");
    assert.equal(rejected.journalEntryId, null);

    const again = await resubmitBooksExpense(OMAR, clientId, created.id);
    assert.equal(again.status, "pending");
    assert.equal(again.rejectionReason, null);
    assert.equal(again.expenseNo, created.expenseNo);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P3-2: VAT without supplier TRN stays in cost", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  try {
    const company = await createTestCompany(admin, "p3-2-vat-cost");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const opex = company.accountIdByCode["6600"];
    const bank = company.accountIdByCode["1120"];
    assert.ok(periodId && opex && bank);

    const created = await createBooksExpense(OMAR, clientId, {
      expenseDate: "2026-05-18",
      periodId,
      description: "No TRN vendor",
      vendorName: "Cash shop",
      paidFromKind: "bank",
      paidFromAccountId: bank,
      lines: [{ accountId: opex, vatCode: "SR", netMinor: 10000, vatMinor: 500 }],
    });
    await submitBooksExpense(OMAR, clientId, created.id);
    const approved = await approveAndPostBooksExpense(LAYLA, clientId, created.id);

    const jlines = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1`,
      [approved.journalEntryId],
    );
    const byCode: Record<string, { dr: number; cr: number }> = {};
    for (const r of jlines.rows) {
      const code = String(r.code);
      byCode[code] = byCode[code] || { dr: 0, cr: 0 };
      byCode[code].dr += Number(r.debit_minor);
      byCode[code].cr += Number(r.credit_minor);
    }
    assert.equal(byCode["6600"]?.dr, 10500);
    assert.equal(byCode["1120"]?.cr, 10500);
    assert.ok(!byCode["1430"] || byCode["1430"].dr === 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
