/**
 * Ingestion-review §5.1 money correctness — hand-computed fils.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { aedFromOriginal } from "@/lib/fx";
import { approveAndPostBooksDocument, createBooksDocument } from "@/server/books/documents";
import { listBooksIssues } from "@/server/books/dashboard";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createBooksParty } from "@/server/books/parties";
import { createTestCompany } from "@/server/books/test-company";
import { generateVat201Draft } from "@/server/books/vat201";

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

async function rejects(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (e: Error & { code?: string }) => {
    assert.match(String(e.message || e.code || e), new RegExp(code));
    return true;
  });
}

test("MONEY-1: reverse-charge open item matches AP net (not gross)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "money-rc");
    const may = company.periods["May 2026"];
    const supplier = await createBooksParty(OMAR, company.clientId, {
      partyType: "supplier",
      name: "Foreign RC Co",
      trn: null,
      force: true,
    });
    const bill = await createBooksDocument(OMAR, company.clientId, {
      docType: "purchase_bill",
      partyId: String(supplier.id),
      issueDate: "2026-05-10",
      periodId: may,
      lines: [
        {
          description: "Overseas service",
          lineKind: "expense",
          vatCode: "RC_IN",
          netMinor: 100_00,
          vatMinor: 5_00,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, company.clientId, String(bill.id));
    const oi = await admin.query(
      `SELECT open_original_minor, open_aed_minor, original_minor, aed_original_minor
       FROM books_open_items WHERE document_id = $1`,
      [bill.id],
    );
    assert.equal(Number(oi.rows[0].open_aed_minor), 100_00, "AP open = net");
    assert.equal(Number(oi.rows[0].open_original_minor), 100_00);
    assert.notEqual(Number(oi.rows[0].open_aed_minor), 105_00, "must not be gross");
  } finally {
    await admin.end();
  }
});

test("MONEY-2: manual journal cannot post to AR/AP/VAT controls", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "money-ctrl");
    const may = company.periods["May 2026"];
    const ar = company.accountIdByCode["1210"];
    const bank = company.accountIdByCode["1120"];
    assert.ok(ar && bank && may);
    await rejects(
      () =>
        createBooksJournal(OMAR, company.clientId, {
          periodId: may,
          entryDate: "2026-05-05",
          memo: "bad AR",
          lines: [
            { accountId: ar, debitMinor: 1000, aedMinor: 1000 },
            { accountId: bank, creditMinor: 1000, aedMinor: 1000 },
          ],
        }),
      "control_account_forbidden",
    );
  } finally {
    await admin.end();
  }
});

test("MONEY-3: FX rate scales bank category AED (USD × 3.6725)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "money-fx");
    const may = company.periods["May 2026"];
    const bank = company.accountIdByCode["1120"];
    const expense = company.accountIdByCode["5107"] || company.accountIdByCode["6100"];
    assert.ok(may && bank && expense);
    // 3.6725 AED/USD → scaled 367_250_000
    await admin.query(
      `INSERT INTO books_fx_rates (id, client_id, currency, rate_date, rate_scaled, source, entered_by)
       VALUES (gen_random_uuid(), $1, 'USD', '2026-05-01', 367250000, 'manual', $2)
       ON CONFLICT (client_id, currency, rate_date) DO NOTHING`,
      [company.clientId, OMAR],
    );
    const rate = 367_250_000;
    const usd = 100_00; // $100.00
    const aed = aedFromOriginal(usd, rate);
    assert.equal(aed, 367_25);

    const created = await createBooksJournal(OMAR, company.clientId, {
      periodId: may,
      entryDate: "2026-05-05",
      memo: "USD expense",
      lines: [
        {
          accountId: expense,
          debitMinor: aed,
          aedMinor: aed,
          currency: "USD",
          originalMinor: usd,
          fxRateScaled: rate,
        },
        {
          accountId: bank,
          creditMinor: aed,
          aedMinor: aed,
          currency: "USD",
          originalMinor: usd,
          fxRateScaled: rate,
        },
      ],
    });
    await postBooksJournal(LAYLA, company.clientId, created.id);
    const lines = await admin.query(
      `SELECT aed_minor, original_minor, fx_rate_scaled FROM books_journal_lines WHERE entry_id = $1`,
      [created.id],
    );
    for (const r of lines.rows) {
      assert.equal(Number(r.aed_minor), 367_25);
      assert.equal(Number(r.original_minor), 100_00);
      assert.equal(Number(r.fx_rate_scaled), rate);
    }
  } finally {
    await admin.end();
  }
});

test("MONEY-4: VAT 201 unlinked warning ignores settlements that debit 2210", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "money-vat");
    const may = company.periods["May 2026"];
    const vatOut = company.accountIdByCode["2210"];
    const bank = company.accountIdByCode["1120"];
    const rev = company.accountIdByCode["4100"];
    assert.ok(may && vatOut && bank && rev);

    // Unlinked output VAT (bank-categorised style): Cr 2210
    const orphan = await createBooksJournal(OMAR, company.clientId, {
      periodId: may,
      entryDate: "2026-05-08",
      memo: "orphan output vat",
      allowControlAccounts: true,
      lines: [
        { accountId: bank, debitMinor: 500, aedMinor: 500 },
        { accountId: vatOut, creditMinor: 500, aedMinor: 500 },
      ],
    });
    await postBooksJournal(LAYLA, company.clientId, orphan.id);

    // VAT settlement: Dr 2210 / Cr bank — must not wipe the warning
    const settle = await createBooksJournal(OMAR, company.clientId, {
      periodId: may,
      entryDate: "2026-05-20",
      memo: "pay FTA",
      allowControlAccounts: true,
      lines: [
        { accountId: vatOut, debitMinor: 500, aedMinor: 500 },
        { accountId: bank, creditMinor: 500, aedMinor: 500 },
      ],
    });
    await postBooksJournal(LAYLA, company.clientId, settle.id);

    const draft = await generateVat201Draft(OMAR, company.clientId, {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    assert.equal(draft.unlinked.outputVatMinor, 500);
    assert.ok(draft.unlinked.lineCount >= 1);
  } finally {
    await admin.end();
  }
});

test("MONEY-5: issues flag AR control ≠ open items", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "money-drift");
    const may = company.periods["May 2026"];
    const ar = company.accountIdByCode["1210"];
    const rev = company.accountIdByCode["4100"];
    assert.ok(may && ar && rev);
    const j = await createBooksJournal(OMAR, company.clientId, {
      periodId: may,
      entryDate: "2026-05-12",
      memo: "seed-style AR without open item",
      allowControlAccounts: true,
      lines: [
        { accountId: ar, debitMinor: 210_00, aedMinor: 210_00 },
        { accountId: rev, creditMinor: 210_00, aedMinor: 210_00 },
      ],
    });
    await postBooksJournal(LAYLA, company.clientId, j.id);
    const issues = await listBooksIssues(OMAR, company.clientId, { periodId: may });
    assert.ok(
      issues.some((i) => i.kind === "ar_control_vs_open_items"),
      JSON.stringify(issues.map((i) => i.kind)),
    );
  } finally {
    await admin.end();
  }
});
