/**
 * P6-4b: CT estimate exact for 300k / 375k / 500k AED; filing due = YE + 9 months.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  buildCtBanner,
  booksCtEstimateBanner,
  ctFilingDueDate,
  estimateCtPayableMinor,
} from "@/server/books/ct-estimate";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createTestCompany } from "@/server/books/test-company";
import { upsertBooksForecast } from "@/server/books/forecasts";

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

test("P6-4b: estimateCtPayableMinor hand checks (AED → fils)", () => {
  // 300,000.00 AED = 30_000_000 fils → below threshold → 0
  assert.equal(estimateCtPayableMinor(30_000_000), 0);
  // 375,000.00 AED = 37_500_000 fils → exactly at threshold → 0
  assert.equal(estimateCtPayableMinor(37_500_000), 0);
  // 500,000.00 AED = 50_000_000 fils → excess 12_500_000 × 9% = 1_125_000 fils (11,250.00 AED)
  assert.equal(estimateCtPayableMinor(50_000_000), 1_125_000);
});

test("P6-4b: filing due is 9 months after fiscal year end", () => {
  assert.equal(ctFilingDueDate("2026-12-31"), "2027-09-30");
  // Nine months after the end of the tax period: 30 Jun 2026 → 31 Mar 2027 (was asserted as 30 Mar).
  assert.equal(ctFilingDueDate("2026-06-30"), "2027-03-31");
  assert.equal(ctFilingDueDate("2027-02-28"), "2027-11-30");
});

test("P6-4b: buildCtBanner labels estimate disclaimer", () => {
  const b = buildCtBanner({
    fiscalYear: 2026,
    fiscalYearStart: "2026-01-01",
    fiscalYearEnd: "2026-12-31",
    taxableIncomeMinor: 50_000_000,
  });
  assert.equal(b.estimateMinor, 1_125_000);
  assert.equal(b.taxYearLabel, "FY2026");
  assert.match(b.disclaimer, /estimate/i);
  assert.equal(b.filingDue, "2027-09-30");
});

test("P6-4b: YTD banner from posted journals; forecasts excluded", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const probe = await admin.query(
      `SELECT to_regclass('public.books_forecasts') IS NOT NULL AS ok`,
    );
    if (!probe.rows[0]?.ok) {
      t.skip("db/61 forecasts not migrated");
      return;
    }
    const company = await createTestCompany(admin, "p6-4b-ct");
    const may = company.periods["May 2026"];
    const jun = company.periods["Jun 2026"];
    const bank = company.accountIdByCode["1120"];
    const rev = company.accountIdByCode["4100"];
    assert.ok(may && bank && rev);

    // Hand: Dr Bank 500_000.00 / Cr Revenue 500_000.00 → ebt = 50_000_000 fils
    await postJv(company.clientId, {
      periodId: may,
      entryDate: "2026-05-10",
      memo: "ct-est revenue",
      voucherType: "Journal",
      lines: [
        { accountId: bank, debitMinor: 50_000_000, creditMinor: 0 },
        { accountId: rev, debitMinor: 0, creditMinor: 50_000_000 },
      ],
    });

    // Forecast must NOT change CT estimate (separate layer).
    await upsertBooksForecast(OMAR, company.clientId, {
      accountId: rev,
      periodId: jun,
      amountMinor: 99_000_000,
      method: "override",
    });

    const banner = await booksCtEstimateBanner(OMAR, company.clientId, "2026-05-31");
    assert.equal(banner.taxableIncomeMinor, 50_000_000);
    assert.equal(banner.estimateMinor, 1_125_000);
    assert.equal(banner.fiscalYear, 2026);
    assert.equal(banner.filingDue, "2027-09-30");
    // AED 500k revenue in a period ending by 31 Dec 2026: Small Business Relief may be elected.
    assert.equal(banner.smallBusinessReliefMayApply, true);
    // Election not recorded → still show standard estimate (item 12).
    assert.equal(banner.noTaxDueRecorded, false);
    assert.equal(banner.sbrElected, null);
  } finally {
    await admin.end();
  }
});
