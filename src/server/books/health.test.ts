/**
 * P7-1: health metric pure helpers + ledger-backed summary (hand-computed fils).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  avgNetCashFlowMinor,
  booksHealthDebtorsCreditors,
  booksHealthPanel,
  booksHealthSummary,
  cashConversionCycleDays,
  cashRunway,
  collectionRateBps,
  dpoDays,
  dioDays,
  dsoDays,
  liabilitiesAssetsRatioBps,
  trackerStatus,
} from "@/server/books/health";
import { approveAndPostBooksDocument, createBooksDocument } from "@/server/books/documents";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createBooksParty } from "@/server/books/parties";
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
  return admin;
}

async function postJv(clientId: string, body: Parameters<typeof createBooksJournal>[2]) {
  const d = await createBooksJournal(OMAR, clientId, { ...body, post: false, allowControlAccounts: true });
  await postBooksJournal(LAYLA, clientId, d.id);
  return d.id;
}

test("P7-1: avgNetCashFlowMinor / runway / L÷A pure", () => {
  // (−1000 + −2000 + −3000) / 3 = −2000
  assert.equal(avgNetCashFlowMinor([-1000, -2000, -3000]), -2000);
  assert.equal(avgNetCashFlowMinor([]), 0);

  assert.deepEqual(cashRunway(5_000_00, 1_000_00), { kind: "cash_positive" });
  assert.deepEqual(cashRunway(5_000_00, 0), { kind: "cash_positive" });

  // Cash 12_000.00 AED (1_200_000 fils), burn 3_000.00/mo → 4.000 months → 4000 milli
  assert.deepEqual(cashRunway(1_200_000, -300_000), {
    kind: "months",
    monthsMilli: 4000,
    burnMinor: 300_000,
  });

  assert.equal(liabilitiesAssetsRatioBps(45_000, 100_000), 4500);
  assert.equal(liabilitiesAssetsRatioBps(1, 0), null);
});

test("P7-3: panel returns scorecard + trends + insights shape", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p7-3-panel");
    const jun = company.periods["Jun 2026"];
    assert.ok(jun);
    const panel = await booksHealthPanel(OMAR, company.clientId, jun);
    assert.equal(panel.scorecard.periodId, jun);
    assert.equal(typeof panel.scorecard.closeReady, "boolean");
    assert.equal(typeof panel.scorecard.tbBalanced, "boolean");
    assert.ok(Array.isArray(panel.trends.cashSeries));
    assert.ok(Array.isArray(panel.trends.pnlSeries));
    assert.ok(Array.isArray(panel.insights));
  } finally {
    await admin.end();
  }
});

test("P7-2: DSO / DPO / DIO / CCC / collection / trackerStatus pure", () => {
  // AR 100.00, revenue 300.00, 30 days → 10 days DSO
  assert.equal(dsoDays(100_00, 300_00, 30), 10);
  assert.equal(dsoDays(100, 0, 30), null);

  assert.equal(dpoDays(50_00, 250_00, 30), 6);
  assert.equal(dioDays(20_00, 200_00, 30), 3);
  assert.equal(dioDays(0, 200_00, 30), null);

  assert.equal(cashConversionCycleDays(10, null, 6), 4);
  assert.equal(cashConversionCycleDays(10, 3, 6), 7);
  assert.equal(cashConversionCycleDays(null, 3, 6), null);

  assert.equal(collectionRateBps(50_000, 100_000), 5000);
  assert.equal(collectionRateBps(1, 0), null);

  assert.equal(trackerStatus(5), "overdue");
  assert.equal(trackerStatus(-3), "pending");
  assert.equal(trackerStatus(-10), "upcoming");
});

test("P7-2: debtors API lists posted invoice and computes DSO", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p7-2-dso");
    const jun = company.periods["Jun 2026"];
    assert.ok(jun, "fixtures");
    const customer = await createBooksParty(OMAR, company.clientId, {
      partyType: "customer",
      name: "P7-2 Customer",
      trn: "100000000000099",
      force: true,
    });

    const inv = await createBooksDocument(OMAR, company.clientId, {
      docType: "sales_invoice",
      partyId: String(customer.id),
      issueDate: "2026-06-10",
      dueDate: "2026-06-20",
      periodId: jun,
      lines: [
        {
          description: "svc",
          lineKind: "revenue",
          vatCode: "SR",
          netMinor: 300_00,
          vatMinor: 15_00,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, company.clientId, String(inv.id));

    const dc = await booksHealthDebtorsCreditors(OMAR, company.clientId, jun);
    assert.equal(dc.arRows.length, 1);
    assert.equal(dc.arRows[0].amountMinor, 315_00, "incl VAT 5%");
    assert.equal(dc.arRows[0].status, "overdue");
    assert.equal(dc.paymentBehaviour.dsoDays, 31, "31500 AR × 30d ÷ 30000 rev");
    assert.equal(dc.arOutstandingMinor, 315_00);
  } finally {
    await admin.end();
  }
});

test("P7-1: hand-computed cash on hand, avg burn, runway months", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p7-1-runway");
    // Template calendar is Apr–Jun; add Mar so seed cash sits outside the trailing-3 window.
    const marIns = await admin.query(
      `INSERT INTO books_periods (id, client_id, label, period_start, period_end, status)
       VALUES (gen_random_uuid(), $1, 'Mar 2026', '2026-03-01', '2026-03-31', 'OPEN')
       RETURNING id`,
      [company.clientId],
    );
    const mar = String(marIns.rows[0].id);
    const apr = company.periods["Apr 2026"];
    const may = company.periods["May 2026"];
    const jun = company.periods["Jun 2026"];
    const bank = company.accountIdByCode["1120"];
    const rev = company.accountIdByCode["4100"];
    const expenseId = company.accountIdByCode["6100"];
    assert.ok(apr && may && jun && bank && rev && expenseId, "missing COA/periods");

    // Mar seed +1_200_000 fils (outside Jun's trailing-3 window)
    await postJv(company.clientId, {
      periodId: mar,
      entryDate: "2026-03-05",
      memo: "seed cash",
      voucherType: "Journal",
      lines: [
        { accountId: bank, debitMinor: 1_200_000, creditMinor: 0 },
        { accountId: rev, debitMinor: 0, creditMinor: 1_200_000 },
      ],
    });
    for (const [periodId, day, label] of [
      [apr, "2026-04-05", "apr burn"],
      [may, "2026-05-05", "may burn"],
      [jun, "2026-06-05", "jun burn"],
    ] as const) {
      await postJv(company.clientId, {
        periodId,
        entryDate: day,
        memo: label,
        voucherType: "Journal",
        lines: [
          { accountId: expenseId, debitMinor: 300_000, creditMinor: 0 },
          { accountId: bank, debitMinor: 0, creditMinor: 300_000 },
        ],
      });
    }

    // Cash end Jun = 1_200k − 3×300k = 300_000
    // Trailing 3 (Apr–Jun): −300k each → avg −300_000 → runway 1.000 month
    const summary = await booksHealthSummary(OMAR, company.clientId, jun);
    assert.equal(summary.cashOnHandMinor, 300_000);
    assert.equal(summary.avgNetCashFlowMinor, -300_000);
    assert.deepEqual(summary.monthlyNetCashFlowsMinor, [-300_000, -300_000, -300_000]);
    assert.equal(summary.runway.kind, "months");
    if (summary.runway.kind === "months") {
      assert.equal(summary.runway.burnMinor, 300_000);
      assert.equal(summary.runway.monthsMilli, 1000);
    }

    // May: cash 600_000; Mar/Apr/May +1_200/−300/−300 → avg +200k → cash_positive
    const maySum = await booksHealthSummary(OMAR, company.clientId, may);
    assert.equal(maySum.cashOnHandMinor, 600_000);
    assert.equal(maySum.avgNetCashFlowMinor, 200_000);
    assert.equal(maySum.runway.kind, "cash_positive");
    assert.ok(maySum.totalAssetsMinor > 0);
    assert.equal(maySum.liabilitiesAssetsRatioBps, 0);

    // vs prior: Jun cash 300k, May cash 600k → delta −300_000
    assert.equal(summary.cashOnHandChange.priorMinor, 600_000);
    assert.equal(summary.cashOnHandChange.deltaMinor, -300_000);
  } finally {
    await admin.end();
  }
});
