import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { assertBooksBalanced, createBooksJournal, postBooksJournal, reverseBooksJournal } from "./journals";
import { lockBooksPeriod } from "./periods";
import { BooksError } from "./errors";
import { createTestCompany } from "./test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
/** Dummy account ids for pure balance-check unit test (no DB). */
const BANK = "a3000001-0000-4000-8000-000000000001";
const REVENUE = "a3000001-0000-4000-8000-000000000007";

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
  const ready = await admin.query(`SELECT to_regclass('books_periods') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("books schema not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("assertBooksBalanced rejects unbalanced lines", () => {
  assert.throws(
    () =>
      assertBooksBalanced([
        { accountId: BANK, debitMinor: 100 },
        { accountId: REVENUE, creditMinor: 50 },
      ]),
    (error: unknown) => error instanceof BooksError,
  );
});

test("unbalanced post is rejected by app and DB balance trigger", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "journals-unbal");
    const clientId = company.clientId;
    const bank = company.accountIdByCode["1120"];
    const revenue = company.accountIdByCode["4100"];
    assert.ok(bank && revenue);
    // Use a throwaway period so seed golden TB stays untouched.
    const temp = await admin.query(
      `INSERT INTO books_periods (client_id, label, period_start, period_end, status)
       VALUES ($1,$2,'2026-08-01','2026-08-31','OPEN') RETURNING id`,
      [clientId, `unbal-${Date.now()}`],
    );
    const periodId = String(temp.rows[0].id);
    await assert.rejects(
      () =>
        createBooksJournal(OMAR, clientId, {
          periodId,
          entryDate: "2026-08-01",
          memo: "bad",
          lines: [
            { accountId: bank, debitMinor: 100 },
            { accountId: revenue, creditMinor: 40 },
          ],
          post: true,
        }),
      (error: unknown) => error instanceof BooksError,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("period lock blocks posting; reverse links a new posted entry", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "journals-lock");
    const clientId = company.clientId;
    const bank = company.accountIdByCode["1120"];
    const revenue = company.accountIdByCode["4100"];
    assert.ok(bank && revenue);
    const tempPeriod = await admin.query(
      `INSERT INTO books_periods (client_id, label, period_start, period_end, status)
       VALUES ($1,$2,'2026-07-01','2026-07-31','OPEN') RETURNING id`,
      [clientId, `lock-${Date.now()}`],
    );
    const periodId = String(tempPeriod.rows[0].id);

    const draft = await createBooksJournal(OMAR, clientId, {
      periodId,
      entryDate: "2026-07-02",
      memo: `lock-test-${Date.now()}`,
      lines: [
        { accountId: bank, debitMinor: 500 },
        { accountId: revenue, creditMinor: 500 },
      ],
      post: false,
    });
    assert.equal(draft.status, "draft");
    await assert.rejects(
      () => postBooksJournal(OMAR, clientId, draft.id),
      (error: unknown) => error instanceof BooksError && String(error.message).includes("approver"),
    );
    const posted = await postBooksJournal(LAYLA, clientId, draft.id);
    assert.equal(posted.status, "posted");
    assert.match(String(posted.entryNo), /^(JV|JE)-2026-\d{4}$/);

    const reversed = await reverseBooksJournal(LAYLA, clientId, draft.id, "2026-07-03");
    assert.equal(reversed.status, "reversed");
    assert.ok(reversed.reversalId);
    assert.equal(reversed.reversedByEntryId, reversed.reversalId);
    assert.equal(reversed.reversesEntryId, draft.id);
    assert.match(String(reversed.entryNo), /^(JV|JE)-2026-\d{4}$/);

    await lockBooksPeriod(LAYLA, clientId, periodId);
    await assert.rejects(
      () =>
        createBooksJournal(OMAR, clientId, {
          periodId,
          entryDate: "2026-07-05",
          memo: "into locked",
          lines: [
            { accountId: bank, debitMinor: 100 },
            { accountId: revenue, creditMinor: 100 },
          ],
          post: true,
        }),
      (error: unknown) => error instanceof Error,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("posted lines are immutable", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "journals-immut");
    const clientId = company.clientId;
    const bank = company.accountIdByCode["1120"];
    const revenue = company.accountIdByCode["4100"];
    const periodId = company.periods["May 2026"];
    assert.ok(bank && revenue && periodId);
    const draft = await createBooksJournal(OMAR, clientId, {
      periodId,
      entryDate: "2026-05-02",
      memo: `immut-${Date.now()}`,
      lines: [
        { accountId: bank, debitMinor: 100 },
        { accountId: revenue, creditMinor: 100 },
      ],
      post: false,
    });
    await postBooksJournal(LAYLA, clientId, draft.id);
    await assert.rejects(
      () =>
        admin.query(
          `UPDATE books_journal_lines SET debit_minor = 1
           WHERE entry_id = $1`,
          [draft.id],
        ),
      (error: unknown) => error instanceof Error && String(error).includes("books_posted_immutable"),
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});
