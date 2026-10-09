import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { booksAdvancesPanel } from "@/server/books/advances-panel";
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

test("Phase 3 rank 6: advances panel lists 2320 subledger and detects drift", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "advances-panel");
    const party = await createBooksParty(OMAR, company.clientId, {
      name: "Advance Customer",
      partyType: "customer",
      force: true,
    });
    const periods = await admin.query(
      `SELECT id, period_end::text AS pe FROM books_periods WHERE client_id = $1 ORDER BY period_end LIMIT 1`,
      [company.clientId],
    );
    const periodId = String(periods.rows[0].id);
    const periodEnd = String(periods.rows[0].pe).slice(0, 10);
    const bank = company.accountIdByCode["1120"] || company.accountIdByCode["1110"];
    const adv = company.accountIdByCode["2320"];
    assert.ok(bank && adv);

    const draft = await createBooksJournal(OMAR, company.clientId, {
      periodId,
      entryDate: periodEnd,
      memo: "orphan 2320 (no subledger)",
      lines: [
        { accountId: bank, debitMinor: 25_000, creditMinor: 0 },
        { accountId: adv, debitMinor: 0, creditMinor: 25_000 },
      ],
      post: false,
      allowControlAccounts: true,
    });
    await postBooksJournal(LAYLA, company.clientId, draft.id);

    await admin.query(
      `INSERT INTO books_party_advances (client_id, party_id, currency, balance_original_minor, balance_aed_minor)
       VALUES ($1, $2, 'AED', 10000, 10000)`,
      [company.clientId, party.id],
    );

    const panel = await booksAdvancesPanel(OMAR, company.clientId);
    assert.equal(panel.advances.length, 1);
    assert.equal(panel.advances[0].partyName, "Advance Customer");
    assert.equal(panel.advancesTotalAedMinor, 10_000);
    assert.equal(panel.gl2320CreditMinor, 25_000);
    assert.equal(panel.drift, true);
    assert.equal(panel.driftMinor, 15_000);
  } finally {
    await admin.end();
  }
});
