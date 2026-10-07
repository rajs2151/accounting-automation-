/**
 * P6-4d: trailing average exact; forecasts never touch TB / BS / actuals export path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { booksBalanceSheet } from "@/server/books/financial-statements";
import {
  linearNextMinor,
  listBooksForecasts,
  projectAmountMinor,
  trailingAverageMinor,
  upsertBooksForecast,
} from "@/server/books/forecasts";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createTestCompany } from "@/server/books/test-company";
import { booksTrialBalance } from "@/server/books/trial-balance";

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
  const probe = await admin.query(
    `SELECT to_regclass('public.books_forecasts') IS NOT NULL AS ok`,
  );
  if (!probe.rows[0]?.ok) {
    await admin.end();
    t.skip("db/61 forecasts not migrated");
    return null;
  }
  return admin;
}

async function postJv(clientId: string, body: Parameters<typeof createBooksJournal>[2]) {
  const d = await createBooksJournal(OMAR, clientId, { ...body, post: false });
  await postBooksJournal(LAYLA, clientId, d.id);
  return d.id;
}

test("P6-4d: trailingAverageMinor / linearNextMinor exact", () => {
  // (100 + 200 + 300) / 3 = 200
  assert.equal(trailingAverageMinor([100, 200, 300], 3), 200);
  // only two points available → avg of both
  assert.equal(trailingAverageMinor([100, 200], 3), 150);
  // linear: last + (last − prev) = 300 + (300 − 200) = 400
  assert.equal(linearNextMinor([100, 200, 300]), 400);
  assert.equal(projectAmountMinor("trailing_avg_3", [1000, 2000, 3000]), 2000);
  assert.equal(projectAmountMinor("override", [], { overrideMinor: 555 }), 555);
});

test("P6-4d: forecasts excluded from TB and Balance Sheet", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p6-4d-fc");
    const may = company.periods["May 2026"];
    const jun = company.periods["Jun 2026"];
    const bank = company.accountIdByCode["1120"];
    const rev = company.accountIdByCode["4100"];

    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-12",
      memo: "actual only",
      voucherType: "Journal",
      lines: [
        { accountId: bank, debitMinor: 10_000, creditMinor: 0 },
        { accountId: rev, debitMinor: 0, creditMinor: 10_000 },
      ],
    });

    const tbBefore = await booksTrialBalance(OMAR, company.clientId, jun);
    const bsBefore = await booksBalanceSheet(OMAR, company.clientId, {
      mode: "monthly",
      from: "2026-06-01",
      to: "2026-06-30",
    });

    await upsertBooksForecast(OMAR, company.clientId, {
      accountId: rev,
      periodId: jun,
      amountMinor: 9_999_999,
      method: "override",
    });
    const listed = await listBooksForecasts(OMAR, company.clientId, { periodId: jun });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].amountMinor, 9_999_999);

    const tbAfter = await booksTrialBalance(OMAR, company.clientId, jun);
    const bsAfter = await booksBalanceSheet(OMAR, company.clientId, {
      mode: "monthly",
      from: "2026-06-01",
      to: "2026-06-30",
    });

    assert.equal(tbAfter.totalClosingDebit, tbBefore.totalClosingDebit);
    assert.equal(tbAfter.totalClosingCredit, tbBefore.totalClosingCredit);
    assert.equal(
      bsAfter.columns[0].totalAssetsMinor,
      bsBefore.columns[0].totalAssetsMinor,
    );
    assert.equal(
      bsAfter.columns[0].totalEquityMinor,
      bsBefore.columns[0].totalEquityMinor,
    );

    // Negative: journals table has no forecast rows (forecasts never written as journals).
    const jCount = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_journal_entries
       WHERE client_id = $1 AND memo ILIKE '%forecast%'`,
      [company.clientId],
    );
    assert.equal(Number(jCount.rows[0].n), 0);
  } finally {
    await admin.end();
  }
});
