/**
 * P5-4 Golden v5: one synthetic month with sales, purchase, bank receipt/payment,
 * depreciation, FX reval, accrual — TB must match hand-computed expected.
 *
 * Arithmetic (May 2026, fils):
 *  Sales INV: net 10_000 SR + VAT 500 → Dr 1210 10_500 / Cr 4100 10_000 / Cr 2210 500
 *  Purchase BILL: net 2_000 SR + VAT 100 (supplier TRN) → Dr 6200 2_000 / Dr 1430 100 / Cr 2110 2_100
 *  Bank receipt (full AR): Dr 1120 10_500 / Cr 1210 10_500
 *  Bank payment (full AP): Dr 2110 2_100 / Cr 1120 2_100
 *  FA cost 36_000.00 life 36 → depr May 1_000.00: Dr 6800 100_000 / Cr 1690 100_000
 *  Accrual (P4 template shape): Dr 6100 3_000 / Cr 2150 3_000 (salaries accrued)
 *  USD bank 1,000.00 @ 3.6725 carried 367_250 / period-end 3.6730 → gain 50:
 *    funding Dr 1121 367_250 / Cr 3100 367_250; reval Dr 1121 50 / Cr 7310 50
 *
 * Expected closing TB (net sides) for key codes — see EXPECTED below.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { parseFxRateToScaled } from "@/lib/fx";
import {
  approveAndPostBooksDocument,
  createBooksDocument,
} from "@/server/books/documents";
import { registerBooksFixedAsset, runBooksDepreciation } from "@/server/books/fixed-assets";
import { runBooksFxRevaluation, upsertBooksFxRate } from "@/server/books/fx-revaluation";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createBooksParty } from "@/server/books/parties";
import { createTestCompany } from "@/server/books/test-company";
import { booksTrialBalance } from "@/server/books/trial-balance";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";

/** Hand-computed closing TB (debit/credit sides after netting). */
const EXPECTED: Record<string, { d: number; c: number }> = {
  // 1120: +10500 receipt −2100 payment = +8400 Dr
  "1120": { d: 8400, c: 0 },
  // 1121: 367_250 + 50 reval = 367_300 Dr
  "1121": { d: 367_300, c: 0 },
  "1430": { d: 100, c: 0 },
  "1690": { d: 0, c: 100_000 },
  "2110": { d: 0, c: 0 },
  "2150": { d: 0, c: 3000 },
  "2210": { d: 0, c: 500 },
  "3100": { d: 0, c: 367_250 },
  "4100": { d: 0, c: 10_000 },
  "6100": { d: 3000, c: 0 },
  "6200": { d: 2000, c: 0 },
  "6800": { d: 100_000, c: 0 },
  "7310": { d: 0, c: 50 },
};

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
  const ready = await admin.query(
    `SELECT to_regclass('books_fixed_assets') AS fa, to_regclass('books_fx_rates') AS fx`,
  );
  if (!ready.rows[0]?.fa || !ready.rows[0]?.fx) {
    t.skip("P5-2/P5-3 migrations missing");
    await admin.end();
    return null;
  }
  return admin;
}

async function postJv(clientId: string, body: Parameters<typeof createBooksJournal>[2]) {
  const d = await createBooksJournal(OMAR, clientId, { ...body, post: false });
  await postBooksJournal(LAYLA, clientId, d.id);
  return d.id;
}

test("P5-4 Golden v5: May TB matches hand-computed fixture", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "golden-v5");
    const periodId = company.periods["May 2026"];
    const bank = company.accountIdByCode["1120"];
    const usdBank = company.accountIdByCode["1121"];
    const ar = company.accountIdByCode["1210"];
    const ap = company.accountIdByCode["2110"];
    const rent = company.accountIdByCode["6200"];
    const salaries = company.accountIdByCode["6100"];
    const accrLiab = company.accountIdByCode["2150"] || company.accountIdByCode["2190"];
    const equity = company.accountIdByCode["3100"];
    assert.ok(periodId && bank && usdBank && ar && ap && rent && salaries && accrLiab && equity);

    await admin.query(`UPDATE books_accounts SET currency = 'USD' WHERE id = $1`, [usdBank]);

    const customer = await createBooksParty(OMAR, company.clientId, {
      partyType: "customer",
      name: `G5 Cust ${Date.now()}`,
      country: "AE",
      emirate: "dubai",
    });
    const supplier = await createBooksParty(OMAR, company.clientId, {
      partyType: "supplier",
      name: `G5 Supp ${Date.now()}`,
      country: "AE",
      emirate: "dubai",
      trn: `9${String(Date.now()).slice(-14)}`.slice(0, 15),
    });
    assert.ok(customer.id && supplier.id);

    const sales = await createBooksDocument(OMAR, company.clientId, {
      docType: "sales_invoice",
      partyId: String(customer.id),
      issueDate: "2026-05-05",
      periodId,
      documentNumber: `G5-S-${Date.now()}`,
      currency: "AED",
      lines: [
        {
          description: "Service",
          lineKind: "revenue",
          vatCode: "SR",
          netMinor: 10_000,
          vatMinor: 500,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, company.clientId, String(sales.id));

    const bill = await createBooksDocument(OMAR, company.clientId, {
      docType: "purchase_bill",
      partyId: String(supplier.id),
      issueDate: "2026-05-06",
      periodId,
      documentNumber: `G5-B-${Date.now()}`,
      currency: "AED",
      lines: [
        {
          description: "Rent",
          lineKind: "expense",
          accountId: rent,
          vatCode: "SR",
          netMinor: 2_000,
          vatMinor: 100,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, company.clientId, String(bill.id));

    // Bank receipt settles AR; payment settles AP (manual JVs — match engine optional for TB).
    await postJv(company.clientId, {
      periodId,
      entryDate: "2026-05-20",
      memo: "G5 receipt",
      voucherType: "Receipt",
      lines: [
        { accountId: bank, debitMinor: 10_500, creditMinor: 0 },
        { accountId: ar, debitMinor: 0, creditMinor: 10_500 },
      ],
    });
    await postJv(company.clientId, {
      periodId,
      entryDate: "2026-05-21",
      memo: "G5 payment",
      voucherType: "Payment",
      lines: [
        { accountId: ap, debitMinor: 2_100, creditMinor: 0 },
        { accountId: bank, debitMinor: 0, creditMinor: 2_100 },
      ],
    });

    await registerBooksFixedAsset(OMAR, company.clientId, {
      name: "G5 Laptop",
      costMinor: 3_600_000,
      residualMinor: 0,
      inServiceDate: "2026-05-01",
      lifeMonths: 36,
    });
    const depr = await runBooksDepreciation(OMAR, company.clientId, periodId);
    assert.ok(depr.journalEntryId);
    await postBooksJournal(LAYLA, company.clientId, depr.journalEntryId!);

    // Accrual (P4-3 shape)
    await postJv(company.clientId, {
      periodId,
      entryDate: "2026-05-31",
      memo: "May payroll accrual",
      templateKey: "accrual",
      autoReverseNextPeriod: true,
      lines: [
        { accountId: salaries, debitMinor: 3000, creditMinor: 0 },
        { accountId: accrLiab, debitMinor: 0, creditMinor: 3000 },
      ],
    });

    // FX: USD 1,000.00 @ 3.6725 → 367_250; rate 3.6730 → 367_300; gain 50
    const rateCarry = Number(parseFxRateToScaled("3.6725"));
    await postJv(company.clientId, {
      periodId,
      entryDate: "2026-05-08",
      memo: "USD funding",
      lines: [
        {
          accountId: usdBank,
          debitMinor: 367_250,
          creditMinor: 0,
          currency: "USD",
          originalMinor: 100_000,
          fxRateScaled: rateCarry,
          aedMinor: 367_250,
        },
        { accountId: equity, debitMinor: 0, creditMinor: 367_250 },
      ],
    });
    await upsertBooksFxRate(OMAR, company.clientId, {
      currency: "USD",
      rateDate: "2026-05-31",
      rate: "3.6730",
    });
    const fx = await runBooksFxRevaluation(OMAR, company.clientId, periodId);
    assert.ok(fx.journalEntryId);
    await postBooksJournal(LAYLA, company.clientId, fx.journalEntryId!);

    const tb = await booksTrialBalance(OMAR, company.clientId, periodId, {
      includeZeroBalances: true,
    });
    assert.equal(tb.balanced, true);

    for (const [code, exp] of Object.entries(EXPECTED)) {
      const row = tb.accounts[code];
      if (exp.d === 0 && exp.c === 0) {
        if (row) {
          assert.equal(row.closingDebitMinor, 0, `${code} Dr`);
          assert.equal(row.closingCreditMinor, 0, `${code} Cr`);
        }
        continue;
      }
      assert.ok(row, `missing TB row ${code}`);
      assert.equal(row.closingDebitMinor, exp.d, `${code} closing Dr`);
      assert.equal(row.closingCreditMinor, exp.c, `${code} closing Cr`);
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
});
