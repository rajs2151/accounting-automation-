/**
 * C polish: non-UAE purchase VAT is never recoverable (stays in cost).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { approveAndPostBooksDocument, createBooksDocument } from "@/server/books/documents";
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

test("non-UAE supplier: input VAT posts to expense cost, not 1430", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, `non-uae-vat-${Date.now()}`);
    const may = company.periods["May 2026"];
    assert.ok(may);
    const supplier = await createBooksParty(OMAR, company.clientId, {
      partyType: "supplier",
      name: `Foreign Supp ${Date.now()}`,
      trn: "100999999900003",
      country: "US",
      force: true,
    });
    const bill = await createBooksDocument(OMAR, company.clientId, {
      docType: "purchase_bill",
      partyId: String(supplier.id),
      issueDate: "2026-05-18",
      periodId: may,
      documentNumber: `NUAE-${Date.now()}`,
      lines: [
        {
          description: "Foreign SaaS",
          lineKind: "expense",
          vatCode: "SR",
          netMinor: 100_00,
          vatMinor: 5_00,
        },
      ],
    });
    const posted = await approveAndPostBooksDocument(LAYLA, company.clientId, String(bill.id));
    const lines = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor, l.line_memo
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1
       ORDER BY a.code`,
      [posted.journalEntryId],
    );
    const by = Object.fromEntries(
      lines.rows.map((r) => [
        String(r.code),
        { dr: Number(r.debit_minor), cr: Number(r.credit_minor), memo: String(r.line_memo || "") },
      ]),
    );
    assert.equal(by["1430"], undefined, "no input VAT control for non-UAE");
    assert.ok(by["6600"]?.dr === 105_00 || Object.values(by).some((v) => v.dr === 105_00));
  } finally {
    await admin.end();
  }
});
