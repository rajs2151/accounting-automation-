import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { createBadDebtWriteOff } from "@/server/books/bad-debt";
import {
  approveAndPostBooksDocument,
  createBooksDocument,
} from "@/server/books/documents";
import { listBooksOpenItems } from "@/server/books/open-items";
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

test("Phase 3 rank 7: bad debt write-off clears AR open item", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "bad-debt-r7");
    const party = await createBooksParty(OMAR, company.clientId, {
      partyType: "customer",
      name: "Bad Debt Customer",
      force: true,
    });
    const periods = await admin.query(
      `SELECT id, period_end::text AS pe FROM books_periods WHERE client_id = $1 ORDER BY period_end LIMIT 1`,
      [company.clientId],
    );
    const periodId = String(periods.rows[0].id);
    const issueDate = String(periods.rows[0].pe).slice(0, 10);

    const doc = await createBooksDocument(OMAR, company.clientId, {
      docType: "sales_invoice",
      partyId: party.id,
      issueDate,
      periodId,
      documentNumber: `INV-BD-${Date.now()}`,
      currency: "AED",
      lines: [
        {
          description: "Uncollectible fee",
          lineKind: "revenue",
          vatCode: "EX",
          netMinor: 10_000,
          vatMinor: 0,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, company.clientId, doc.id);

    const open = await listBooksOpenItems(OMAR, company.clientId, { side: "AR" });
    const item = open.find((r) => r.partyId === party.id && Number(r.openOriginalMinor) > 0);
    assert.ok(item);
    assert.equal(item!.openOriginalMinor, 10_000);

    const result = await createBadDebtWriteOff(OMAR, LAYLA, company.clientId, {
      openItemId: item!.id,
      periodId,
      entryDate: issueDate,
    });
    assert.ok(result.entryNo);
    assert.equal(result.amountAedMinor, 10_000);

    const after = await listBooksOpenItems(OMAR, company.clientId, { side: "AR" });
    const closed = after.find((r) => r.id === item!.id);
    assert.ok(closed);
    assert.equal(closed!.openOriginalMinor, 0);
    assert.equal(closed!.status, "closed");
  } finally {
    await admin.end();
  }
});
