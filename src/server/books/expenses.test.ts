import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  createBooksExpense,
  getBooksExpense,
  listBooksExpenses,
  softDeleteBooksExpenseDraft,
  updateBooksExpenseDraft,
} from "@/server/books/expenses";
import { createTestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";

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
