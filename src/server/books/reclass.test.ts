/**
 * P6-2: reclass draft — exact lines, locked period refused, preparer cannot post own.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { createBooksJournal, getBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createBooksReclassDraft } from "@/server/books/reclass";
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

test("P6-2: reclass draft lines; locked refused; preparer cannot post own", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p6-2-reclass", {
      lockPeriodLabels: ["Apr 2026"],
    });
    const may = company.periods["May 2026"];
    const apr = company.periods["Apr 2026"];
    const rent = company.accountIdByCode["6200"];
    const utilities = company.accountIdByCode["6210"];
    const bank = company.accountIdByCode["1120"];
    assert.ok(may && apr && rent && utilities && bank);

    const draft = await createBooksJournal(OMAR, company.clientId, {
      periodId: may,
      entryDate: "2026-05-10",
      memo: "Rent to reclass",
      post: false,
      lines: [
        { accountId: rent, debitMinor: 5_000, creditMinor: 0 },
        { accountId: bank, debitMinor: 0, creditMinor: 5_000 },
      ],
    });
    await postBooksJournal(LAYLA, company.clientId, draft.id);

    const reclass = await createBooksReclassDraft(OMAR, company.clientId, {
      periodId: may,
      entryDate: "2026-05-12",
      fromAccountId: rent,
      toAccountId: utilities,
      amountMinor: 5_000,
      sourceEntryId: draft.id,
    });
    assert.equal(reclass.status, "draft");
    const full = await getBooksJournal(OMAR, company.clientId, reclass.id);
    assert.equal(full.templateKey, "reclassification");
    const byAcct = new Map(
      full.lines.map((l: { accountId: string; debitMinor: number; creditMinor: number }) => [
        l.accountId,
        { debitMinor: l.debitMinor, creditMinor: l.creditMinor },
      ]),
    );
    assert.deepEqual(byAcct.get(utilities), { debitMinor: 5_000, creditMinor: 0 });
    assert.deepEqual(byAcct.get(rent), { debitMinor: 0, creditMinor: 5_000 });
    assert.match(String(full.memo), /Reclass from/);

    await assert.rejects(
      () =>
        createBooksReclassDraft(OMAR, company.clientId, {
          periodId: apr,
          entryDate: "2026-04-15",
          fromAccountId: rent,
          toAccountId: utilities,
          amountMinor: 100,
          sourceEntryId: draft.id,
        }),
      /period_locked/,
    );

    await assert.rejects(
      () => postBooksJournal(OMAR, company.clientId, reclass.id),
      /post_requires_approver|post_preparer_cannot_approve/,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});
