/**
 * P6-1: P&L / BS / CF hand-computed + period columns + integrity gates.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { getBooksCloseChecklist, lockBooksPeriodWithChecklist, waiveBooksCloseGate } from "@/server/books/close";
import {
  booksBalanceSheet,
  booksCashFlow,
  booksFinancialStatementsPack,
  booksProfitAndLoss,
} from "@/server/books/financial-statements";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { buildPeriodColumns } from "@/server/books/period-columns";
import { createTestCompany } from "@/server/books/test-company";
import { closeBooksYearToRE, postBooksYearEndClose } from "@/server/books/year-end";

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
  return admin;
}

async function postJv(clientId: string, body: Parameters<typeof createBooksJournal>[2]) {
  const d = await createBooksJournal(OMAR, clientId, { ...body, post: false });
  await postBooksJournal(LAYLA, clientId, d.id);
  return d.id;
}

test("P6-1: period engine MTD like-for-like day count", () => {
  const cols = buildPeriodColumns({
    mode: "monthly",
    periods: [
      {
        id: "p1",
        label: "May 2026",
        periodStart: "2026-05-01",
        periodEnd: "2026-05-31",
      },
    ],
    from: "2026-05-01",
    to: "2026-05-31",
    asOf: "2026-05-15",
  });
  assert.equal(cols.length, 1);
  assert.equal(cols[0].isPartial, true);
  assert.equal(cols[0].partialKind, "MTD");
  assert.equal(cols[0].to, "2026-05-15");
  assert.match(cols[0].label, /^MTD /);
  // 15 days (1–15) → prior window 16 Apr–30 Apr = 15 days
  assert.equal(cols[0].compareFrom, "2026-04-16");
  assert.equal(cols[0].compareTo, "2026-04-30");
});

test("P6-1: hand-computed P&L / BS / CF + gates + quarterly sum", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p6-1-fs");
    const may = company.periods["May 2026"];
    const jun = company.periods["Jun 2026"];
    const bank = company.accountIdByCode["1120"];
    const ar = company.accountIdByCode["1210"];
    const ap = company.accountIdByCode["2110"];
    const rev = company.accountIdByCode["4100"];
    const cogs = company.accountIdByCode["5100"];
    const rent = company.accountIdByCode["6200"];
    const depr = company.accountIdByCode["6800"];
    const accum = company.accountIdByCode["1690"];
    const fa = company.accountIdByCode["1620"];
    const interest = company.accountIdByCode["7400"];
    const fx = company.accountIdByCode["7310"];
    const suspense = company.accountIdByCode["1390"];
    const ct = company.accountIdByCode["8100"];
    const ctPay = company.accountIdByCode["2230"];
    const vatOut = company.accountIdByCode["2210"];
    const capital = company.accountIdByCode["3100"];
    const drawings = company.accountIdByCode["3400"];
    assert.ok(may && jun && bank && ar && ap && rev && cogs && rent && depr && accum && fa);
    assert.ok(interest && fx && suspense && ct && ctPay && vatOut && capital && drawings);

    /*
     * Hand arithmetic (fils), May 2026:
     * Capital 100_000; Sales 10_000 + VAT 500 AR; COGS 2_000 AP; Rent 1_000 cash;
     * Depr 500; Interest 200 cash; FX unrealised 50 vs suspense (non-cash);
     * CT 100 accrual; FA purchase 5_000 cash; Drawings 300 cash;
     * Collect AR 10_500; Pay AP 2_000.
     *
     * P&L: Rev 10_000 − COGS 2_000 = GP 8_000
     *      − Opex 1_000 = EBITDA 7_000
     *      − Depr 500 = EBIT 6_500
     *      − Interest 200 − FX 50 = EBT 6_250
     *      − CT 100 = NP 6_150
     *
     * Cash: 100000 −1000 −200 −5000 −300 +10500 −2000 = 102_000
     */
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-01",
      memo: "Capital",
      lines: [
        { accountId: bank, debitMinor: 100_000, creditMinor: 0 },
        { accountId: capital, debitMinor: 0, creditMinor: 100_000 },
      ],
    });
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-05",
      memo: "Sale",
      lines: [
        { accountId: ar, debitMinor: 10_500, creditMinor: 0 },
        { accountId: rev, debitMinor: 0, creditMinor: 10_000 },
        { accountId: vatOut, debitMinor: 0, creditMinor: 500 },
      ],
    });
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-06",
      memo: "COGS",
      lines: [
        { accountId: cogs, debitMinor: 2_000, creditMinor: 0 },
        { accountId: ap, debitMinor: 0, creditMinor: 2_000 },
      ],
    });
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-07",
      memo: "Rent",
      lines: [
        { accountId: rent, debitMinor: 1_000, creditMinor: 0 },
        { accountId: bank, debitMinor: 0, creditMinor: 1_000 },
      ],
    });
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-08",
      memo: "Depr",
      lines: [
        { accountId: depr, debitMinor: 500, creditMinor: 0 },
        { accountId: accum, debitMinor: 0, creditMinor: 500 },
      ],
    });
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-09",
      memo: "Interest",
      lines: [
        { accountId: interest, debitMinor: 200, creditMinor: 0 },
        { accountId: bank, debitMinor: 0, creditMinor: 200 },
      ],
    });
    // Unrealised FX: non-cash contra (suspense), so CF add-back does not double-count WC.
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-10",
      memo: "FX unrealised",
      lines: [
        { accountId: fx, debitMinor: 50, creditMinor: 0 },
        { accountId: suspense, debitMinor: 0, creditMinor: 50 },
      ],
    });
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-11",
      memo: "CT",
      lines: [
        { accountId: ct, debitMinor: 100, creditMinor: 0 },
        { accountId: ctPay, debitMinor: 0, creditMinor: 100 },
      ],
    });
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-12",
      memo: "FA purchase",
      lines: [
        { accountId: fa, debitMinor: 5_000, creditMinor: 0 },
        { accountId: bank, debitMinor: 0, creditMinor: 5_000 },
      ],
    });
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-13",
      memo: "Drawings",
      lines: [
        { accountId: drawings, debitMinor: 300, creditMinor: 0 },
        { accountId: bank, debitMinor: 0, creditMinor: 300 },
      ],
    });
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-20",
      memo: "Collect AR",
      lines: [
        { accountId: bank, debitMinor: 10_500, creditMinor: 0 },
        { accountId: ar, debitMinor: 0, creditMinor: 10_500 },
      ],
    });
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-21",
      memo: "Pay AP",
      lines: [
        { accountId: ap, debitMinor: 2_000, creditMinor: 0 },
        { accountId: bank, debitMinor: 0, creditMinor: 2_000 },
      ],
    });

    // Small Jun revenue so quarterly = May + Jun
    await postJv(company.clientId, {
      periodId: jun,
      entryDate: "2026-06-05",
      memo: "Jun sale",
      lines: [
        { accountId: bank, debitMinor: 1_000, creditMinor: 0 },
        { accountId: rev, debitMinor: 0, creditMinor: 1_000 },
      ],
    });

    const pnl = await booksProfitAndLoss(OMAR, company.clientId, {
      mode: "monthly",
      from: "2026-05-01",
      to: "2026-05-31",
      asOf: "2026-12-31",
    });
    assert.equal(pnl.columns.length, 1);
    const mayPnl = pnl.columns[0];
    assert.equal(mayPnl.grossProfitMinor, 8_000);
    assert.equal(mayPnl.ebitdaMinor, 7_000);
    assert.equal(mayPnl.ebitMinor, 6_500);
    assert.equal(mayPnl.ebtMinor, 6_250);
    assert.equal(mayPnl.netProfitMinor, 6_150);

    const bs = await booksBalanceSheet(OMAR, company.clientId, {
      mode: "monthly",
      from: "2026-05-01",
      to: "2026-05-31",
      asOf: "2026-12-31",
    });
    const mayBs = bs.columns[0];
    const cashRow = mayBs.assets
      .flatMap((s) => s.accounts)
      .find((a) => a.code === "1120");
    assert.equal(cashRow?.amountMinor, 102_000);
    assert.equal(mayBs.currentYearProfitMinor, 6_150);
    assert.equal(
      mayBs.totalAssetsMinor,
      mayBs.totalLiabilitiesMinor + mayBs.totalEquityMinor,
    );

    const cf = await booksCashFlow(OMAR, company.clientId, {
      mode: "monthly",
      from: "2026-05-01",
      to: "2026-05-31",
      asOf: "2026-12-31",
    });
    const mayCf = cf.columns[0];
    assert.equal(mayCf.netProfitMinor, 6_150);
    assert.equal(mayCf.openingCashMinor + mayCf.netChangeMinor, mayCf.closingCashMinor);
    assert.equal(mayCf.closingCashMinor, 102_000);

    const pack = await booksFinancialStatementsPack(OMAR, company.clientId, {
      mode: "monthly",
      from: "2026-05-01",
      to: "2026-05-31",
      asOf: "2026-12-31",
    });
    assert.equal(pack.integrity.bsBalances.ok, true);
    assert.equal(pack.integrity.cfTies.ok, true);
    assert.equal(pack.integrity.ready, true);

    // Quarterly: May NP 6150 + Jun NP 1000 = 7150
    const q = await booksProfitAndLoss(OMAR, company.clientId, {
      mode: "quarterly",
      from: "2026-04-01",
      to: "2026-06-30",
      asOf: "2026-12-31",
    });
    const qCol = q.columns.find((c) => c.column.label.includes("Q"));
    assert.ok(qCol);
    assert.equal(qCol!.netProfitMinor, 7_150);

    const months = await booksProfitAndLoss(OMAR, company.clientId, {
      mode: "monthly",
      from: "2026-05-01",
      to: "2026-06-30",
      asOf: "2026-12-31",
    });
    const sumNp = months.columns.reduce((s, c) => s + c.netProfitMinor, 0);
    assert.equal(sumNp, qCol!.netProfitMinor);

    // Closing entry excluded from P&L; BS equity moves to RE (no double CYE).
    await admin.query(`UPDATE clients SET fiscal_year_start_month = 7 WHERE id = $1`, [
      company.clientId,
    ]);
    // Year-end close (P5 hardening): earlier months of the year locked first, then one approver
    // prepares the closing entry and a different approver posts it.
    for (const pid of [company.periods["Apr 2026"]!, company.periods["May 2026"]!, jun]) {
      const cl = await getBooksCloseChecklist(LAYLA, company.clientId, pid);
      for (const key of cl.failing) {
        await waiveBooksCloseGate(LAYLA, company.clientId, pid, key, "P6-1 waiver");
      }
      if (pid !== jun) await lockBooksPeriodWithChecklist(LAYLA, company.clientId, pid);
    }
    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [RAJ, company.clientId],
    );
    await closeBooksYearToRE(LAYLA, company.clientId, jun);
    await postBooksYearEndClose(RAJ, company.clientId, 2025);

    const afterClose = await booksProfitAndLoss(OMAR, company.clientId, {
      mode: "monthly",
      from: "2026-05-01",
      to: "2026-06-30",
      asOf: "2026-12-31",
    });
    const mayAfter = afterClose.columns.find((c) => c.column.label.includes("May"));
    assert.equal(mayAfter?.netProfitMinor, 6_150, "closing excluded from P&L");

    const bsAfter = await booksBalanceSheet(OMAR, company.clientId, {
      mode: "monthly",
      from: "2026-06-01",
      to: "2026-06-30",
      asOf: "2026-12-31",
    });
    assert.equal(bsAfter.columns[0].currentYearProfitMinor, 0, "CYE cleared after YE");
    assert.equal(
      bsAfter.columns[0].totalAssetsMinor,
      bsAfter.columns[0].totalLiabilitiesMinor + bsAfter.columns[0].totalEquityMinor,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});
