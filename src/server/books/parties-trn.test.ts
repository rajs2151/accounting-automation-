import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { createBooksParty, listBooksParties } from "@/server/books/parties";
import { createTestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";

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

test("createBooksParty rejects invalid TRN", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, `party-trn-bad-${Date.now()}`);
    await assert.rejects(
      () =>
        createBooksParty(OMAR, company.clientId, {
          partyType: "customer",
          name: `TRN bad ${Date.now()}`,
          trn: "123",
        }),
      /invalid_trn/,
    );
  } finally {
    await admin.end();
  }
});

test("createBooksParty accepts empty or valid UAE TRN and lists balance", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, `party-trn-ok-${Date.now()}`);
    const a = await createBooksParty(OMAR, company.clientId, {
      partyType: "customer",
      name: `No TRN ${Date.now()}`,
      zone: "mainland",
      defaultVatCode: "SR",
      paymentTermsDays: 14,
    });
    assert.ok(a.id);
    const b = await createBooksParty(OMAR, company.clientId, {
      partyType: "supplier",
      name: `Valid TRN ${Date.now()}`,
      trn: "100123456700003",
      zone: "free_zone",
      defaultVatCode: "ZR",
      paymentTermsDays: 7,
      force: true,
    });
    assert.ok(b.id);
    const list = await listBooksParties(OMAR, company.clientId, { partyType: "supplier" });
    const row = list.find((p: { id: string }) => p.id === b.id) as { balanceMinor?: number };
    assert.ok(row);
    assert.equal(Number(row.balanceMinor || 0), 0);
  } finally {
    await admin.end();
  }
});
