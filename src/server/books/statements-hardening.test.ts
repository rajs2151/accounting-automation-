/**
 * P6-1 review fixes for the financial statements engine: unclosed / draft / reversed year-end profit on
 * the balance sheet, cash flow that ties for every kind of balance-sheet movement (card, provisions,
 * dividends, suspense, clearing, disposals, FX on cash vs receivables), accounts without a statement
 * line, per-column integrity, column clamping and date validation. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { createBooksAccount } from "@/server/books/accounts";
import { getBooksCloseChecklist, waiveBooksCloseGate } from "@/server/books/close";
import {
  booksBalanceSheet,
  booksCashFlow,
  booksFinancialStatementsPack,
  booksProfitAndLoss,
} from "@/server/books/financial-statements";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { buildPeriodColumns } from "@/server/books/period-columns";
import { createTestCompany } from "@/server/books/test-company";
import { closeBooksYearToRE } from "@/server/books/year-end";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const RAJ = "77777777-7777-4777-8777-777777777777";
const FAR = "2030-12-31";

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

const L = (accountId: string, debitMinor: number, creditMinor: number) => ({ accountId, debitMinor, creditMinor });

async function postJv(clientId: string, body: Parameters<typeof createBooksJournal>[2]) {
  const d = await createBooksJournal(OMAR, clientId, { ...body, post: false });
  await postBooksJournal(LAYLA, clientId, d.id);
  return d.id;
}

async function bsDiff(clientId: string, date: string) {
  const bs = await booksBalanceSheet(OMAR, clientId, { mode: "range", from: date, to: date, asOf: FAR });
  const b = bs.columns[0]!;
  return b.totalAssetsMinor - b.totalLiabilitiesMinor - b.totalEquityMinor;
}

async function addJul(admin: pg.Client, clientId: string) {
  const r = await admin.query(
    `INSERT INTO books_periods (id, client_id, label, period_start, period_end, status)
     VALUES (gen_random_uuid(), $1, 'Jul 2026', '2026-07-01', '2026-07-31', 'OPEN') RETURNING id`,
    [clientId],
  );
  return String(r.rows[0].id);
}

test("balance sheet: draft year-end close and unclosed prior-year profit keep it balanced", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const co = await createTestCompany(admin, "fs-h-ye");
    const c = co.clientId;
    await admin.query(`UPDATE clients SET fiscal_year_start_month = 7 WHERE id = $1`, [c]);
    const jun = co.periods["Jun 2026"]!;
    const bank = co.accountIdByCode["1120"]!;
    const rev = co.accountIdByCode["4100"]!;
    await postJv(c, { periodId: jun, entryDate: "2026-06-10", memo: "FY2025 revenue", lines: [L(bank, 100_000, 0), L(rev, 0, 100_000)] });

    // Prior fiscal year never closed: its profit must still be in equity.
    const jul = await addJul(admin, c);
    await postJv(c, { periodId: jul, entryDate: "2026-07-05", memo: "FY2026 revenue", lines: [L(bank, 7_000, 0), L(rev, 0, 7_000)] });
    assert.equal(await bsDiff(c, "2026-07-31"), 0);
    const bsJul = await booksBalanceSheet(OMAR, c, { mode: "range", from: "2026-07-31", to: "2026-07-31", asOf: FAR });
    assert.equal(bsJul.columns[0]!.currentYearProfitMinor, 7_000);
    assert.equal(bsJul.columns[0]!.priorYearsUnclosedProfitMinor, 100_000);

    // A prepared (draft) close is not a close.
    await admin.query(`UPDATE books_periods SET status = 'LOCKED' WHERE client_id = $1 AND label IN ('Apr 2026', 'May 2026')`, [c]);
    const cl = await getBooksCloseChecklist(LAYLA, c, jun);
    for (const k of cl.failing) await waiveBooksCloseGate(LAYLA, c, jun, k, "fs-h test");
    await closeBooksYearToRE(LAYLA, c, jun);
    assert.equal(await bsDiff(c, "2026-06-30"), 0);
    const pack = await booksFinancialStatementsPack(OMAR, c, { mode: "range", from: "2026-06-01", to: "2026-06-30", asOf: FAR });
    assert.equal(pack.integrity.bsBalances.ok, true);
  } finally {
    await admin.end();
  }
});

test("cash flow ties for every kind of balance-sheet movement", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const co = await createTestCompany(admin, "fs-h-cf");
    const c = co.clientId;
    const may = co.periods["May 2026"]!;
    const A = co.accountIdByCode as Record<string, string>;
    const scen: Array<[string, string, ReturnType<typeof L>[]]> = [
      ["2026-05-01", "capital", [L(A["1120"], 100_000, 0), L(A["3100"], 0, 100_000)]],
      ["2026-05-02", "opening equity", [L(A["1120"], 50_000, 0), L(A["3900"], 0, 50_000)]],
      ["2026-05-03", "card expense", [L(A["6300"], 1_000, 0), L(A["2150"], 0, 1_000)]],
      ["2026-05-04", "EOSB provision", [L(A["6110"], 2_000, 0), L(A["2410"], 0, 2_000)]],
      ["2026-05-05", "FX reval USD bank", [L(A["1121"], 500, 0), L(A["7310"], 0, 500)]],
      ["2026-05-06", "FX reval AR", [L(A["1210"], 300, 0), L(A["7310"], 0, 300)]],
      ["2026-05-07", "dividend", [L(A["3200"], 400, 0), L(A["1120"], 0, 400)]],
      ["2026-05-08", "suspense receipt", [L(A["1120"], 700, 0), L(A["1390"], 0, 700)]],
      ["2026-05-09", "card clearing", [L(A["1130"], 900, 0), L(A["1120"], 0, 900)]],
      ["2026-05-10", "bank transfer", [L(A["1121"], 5_000, 0), L(A["1120"], 0, 5_000)]],
      ["2026-05-11", "buy fixed asset", [L(A["1610"], 10_000, 0), L(A["1120"], 0, 10_000)]],
      ["2026-05-12", "depreciation", [L(A["6800"], 6_000, 0), L(A["1690"], 0, 6_000)]],
      ["2026-05-13", "dispose asset at a loss", [L(A["1120"], 3_000, 0), L(A["1690"], 6_000, 0), L(A["7500"], 1_000, 0), L(A["1610"], 0, 10_000)]],
      ["2026-05-14", "owner current account", [L(A["1120"], 800, 0), L(A["2340"], 0, 800)]],
      ["2026-05-15", "sale with return", [L(A["1120"], 900, 0), L(A["4100"], 0, 1_000), L(A["4900"], 100, 0)]],
    ];
    for (const [d, memo, lines] of scen) await postJv(c, { periodId: may, entryDate: d, memo, lines });
    for (const [d, memo] of scen) {
      const x = (await booksCashFlow(OMAR, c, { mode: "range", from: d, to: d, asOf: FAR })).columns[0]!;
      assert.equal(x.openingCashMinor + x.netChangeMinor + x.fxEffectOnCashMinor - x.closingCashMinor, 0, `ties: ${memo}`);
    }
    // Disposal: investing shows the 3,000 proceeds; FX on the bank is shown as an FX effect.
    const disposal = (await booksCashFlow(OMAR, c, { mode: "range", from: "2026-05-13", to: "2026-05-13", asOf: FAR })).columns[0]!;
    assert.equal(disposal.investingMinor, 3_000);
    const fx = (await booksCashFlow(OMAR, c, { mode: "range", from: "2026-05-05", to: "2026-05-05", asOf: FAR })).columns[0]!;
    assert.equal(fx.netChangeMinor, 0);
    // Whole month ties too, and the balance sheet balances.
    const pack = await booksFinancialStatementsPack(OMAR, c, { mode: "monthly", from: "2026-05-01", to: "2026-05-31", asOf: FAR });
    assert.equal(pack.integrity.cfTies.ok, true);
    assert.equal(pack.integrity.bsBalances.ok, true);
    assert.equal(pack.integrity.tbBalances.ok, true);
  } finally {
    await admin.end();
  }
});

test("an account without a statement line still counts in P&L and the balance sheet", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const co = await createTestCompany(admin, "fs-h-custom");
    const c = co.clientId;
    const jun = co.periods["Jun 2026"]!;
    await admin.query(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [RAJ, c]);
    const acct = await createBooksAccount(RAJ, c, { code: "6950", name: "Custom expense", accountType: "expense" });
    await postJv(c, { periodId: jun, entryDate: "2026-06-02", memo: "custom", lines: [L(acct.id, 1_234, 0), L(co.accountIdByCode["1120"]!, 0, 1_234)] });
    const p = await booksProfitAndLoss(OMAR, c, { mode: "range", from: "2026-06-02", to: "2026-06-02", asOf: FAR });
    assert.equal(p.columns[0]!.netProfitMinor, -1_234);
    assert.equal(await bsDiff(c, "2026-06-02"), 0);
  } finally {
    await admin.end();
  }
});

test("columns stay inside the requested dates; impossible dates are refused", async (t) => {
  const periods = [{ id: "m", label: "May 2026", periodStart: "2026-05-01", periodEnd: "2026-05-31" }];
  const cols = buildPeriodColumns({ mode: "monthly", periods, from: "2026-05-15", to: "2026-05-20", asOf: FAR });
  assert.deepEqual(cols.map((x) => [x.from, x.to]), [["2026-05-15", "2026-05-20"]]);
  assert.throws(() => buildPeriodColumns({ mode: "range", periods, from: "2026-02-30", to: "2026-03-01", asOf: FAR }), /invalid_date/);
  const admin = await withAdmin(t);
  if (!admin) return;
  await admin.end();
});
