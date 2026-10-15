/**
 * P5-4: year-end close to RE — hand-computed closing lines + gate/idempotency.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  getBooksCloseChecklist,
  lockBooksPeriodWithChecklist,
  waiveBooksCloseGate,
} from "@/server/books/close";
import { createBooksJournal, getBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createTestCompany } from "@/server/books/test-company";
import {
  booksYearPnlNets,
  closeBooksYearToRE,
  postBooksYearEndClose,
  reverseBooksYearEndClose,
} from "@/server/books/year-end";
import { withUser } from "@/lib/db";

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
  const ready = await admin.query(`SELECT to_regclass('books_year_end_closes') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/60 year-end not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

async function waiveAllFailing(userId: string, clientId: string, periodId: string) {
  const cl = await getBooksCloseChecklist(userId, clientId, periodId);
  for (const key of cl.failing) {
    await waiveBooksCloseGate(userId, clientId, periodId, key, "P5-4 year-end test waiver");
  }
}

async function postJv(
  clientId: string,
  body: Parameters<typeof createBooksJournal>[2],
) {
  const d = await createBooksJournal(OMAR, clientId, { ...body, post: false, allowControlAccounts: true });
  await postBooksJournal(LAYLA, clientId, d.id);
  return d.id;
}

test("P5-4: year-end closing lines; refuse before checklist; refuse twice; P&L excludes closing", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p5-4-ye");
    // Seed calendar only has Apr–Jun 2026; set FY start = July so Jun is year-end.
    await admin.query(`UPDATE clients SET fiscal_year_start_month = 7 WHERE id = $1`, [
      company.clientId,
    ]);
    const yearEndId = company.periods["Jun 2026"];
    const mayId = company.periods["May 2026"];
    const rev = company.accountIdByCode["4100"];
    const opexCode = company.accountIdByCode["6100"]
      ? "6100"
      : company.accountIdByCode["6200"]
        ? "6200"
        : "6900";
    const opex = company.accountIdByCode[opexCode];
    const bank = company.accountIdByCode["1120"];
    const re = company.accountIdByCode["3200"];
    assert.ok(yearEndId && mayId && rev && opex && bank && re);

    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [RAJ, company.clientId],
    );

    // Revenue 1,000.00 / Expense 400.00 in Jun → NI 600.00 (FY Jul 2025–Jun 2026)
    await postJv(company.clientId, {
      periodId: yearEndId,
      entryDate: "2026-06-10",
      memo: "YE revenue",
      lines: [
        { accountId: bank, debitMinor: 100_000, creditMinor: 0 },
        { accountId: rev, debitMinor: 0, creditMinor: 100_000 },
      ],
    });
    await postJv(company.clientId, {
      periodId: yearEndId,
      entryDate: "2026-06-12",
      memo: "YE expense",
      lines: [
        { accountId: opex, debitMinor: 40_000, creditMinor: 0 },
        { accountId: bank, debitMinor: 0, creditMinor: 40_000 },
      ],
    });

    await assert.rejects(
      () => closeBooksYearToRE(LAYLA, company.clientId, yearEndId),
      /close_checklist_incomplete/,
    );

    await assert.rejects(
      () => closeBooksYearToRE(LAYLA, company.clientId, mayId),
      /not_fiscal_year_end_period/,
    );

    // Year-end needs every earlier month of the fiscal year locked (through the close gates).
    for (const label of ["Apr 2026", "May 2026"]) {
      await waiveAllFailing(LAYLA, company.clientId, company.periods[label]);
      await lockBooksPeriodWithChecklist(LAYLA, company.clientId, company.periods[label]);
    }

    await waiveAllFailing(LAYLA, company.clientId, yearEndId);
    // Two steps: Layla prepares the draft, a different approver/admin (Raj) posts it.
    await closeBooksYearToRE(LAYLA, company.clientId, yearEndId, "FY2025 close");
    const closed = await postBooksYearEndClose(RAJ, company.clientId, 2025);
    assert.equal(closed.netIncomeMinor, 60_000);
    assert.equal(closed.fiscalYear, 2025);

    const je = await getBooksJournal(LAYLA, company.clientId, closed.journalEntryId);
    assert.equal(je.entryType, "closing");
    assert.equal(je.voucherType, "Closing");
    type JLine = { accountCode: string; debitMinor: number; creditMinor: number };
    const lines = je.lines as JLine[];
    assert.equal(lines.find((l) => l.accountCode === "4100")?.debitMinor, 100_000);
    assert.equal(lines.find((l) => l.accountCode === opexCode)?.creditMinor, 40_000);
    assert.equal(lines.find((l) => l.accountCode === "3200")?.creditMinor, 60_000);
    assert.equal(
      lines.reduce((s, l) => s + l.debitMinor, 0),
      lines.reduce((s, l) => s + l.creditMinor, 0),
    );

    await assert.rejects(
      () => closeBooksYearToRE(LAYLA, company.clientId, yearEndId),
      /year_end_already_closed/,
    );

    // P&L for the year after closing still shows profit when closing excluded
    const pnl = await withUser(LAYLA, async (db) =>
      booksYearPnlNets(db, company.clientId, "2025-07-01", "2026-06-30", {
        excludeClosingEntries: true,
      }),
    );
    assert.equal(pnl.netIncomeMinor, 60_000);

    // RE increased by NI (closing credit on 3200)
    const reBal = await admin.query(
      `SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0)::bigint AS n
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1 AND e.client_id = $2 AND e.status = 'posted'`,
      [re, company.clientId],
    );
    assert.equal(Number(reBal.rows[0].n), 60_000);

    // Reverse by different admin (Raj)
    const revResult = await reverseBooksYearEndClose(
      RAJ,
      company.clientId,
      2025,
      "Restate YE",
      "2026-06-30",
    );
    assert.ok(revResult.reversalId);

    // Can close again after reverse
    await waiveAllFailing(LAYLA, company.clientId, yearEndId);
    await closeBooksYearToRE(LAYLA, company.clientId, yearEndId);
    const again = await postBooksYearEndClose(RAJ, company.clientId, 2025);
    assert.equal(again.netIncomeMinor, 60_000);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
