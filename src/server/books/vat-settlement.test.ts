/**
 * D3: VAT 201 settlement line builder + prepare draft (idempotent per tax window).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  approveAndPostBooksDocument,
  createBooksDocument,
} from "@/server/books/documents";
import { BooksError } from "@/server/books/errors";
import { createBooksParty } from "@/server/books/parties";
import { createTestCompany } from "@/server/books/test-company";
import {
  buildVat201SettlementLines,
  getVat201Settlement,
  prepareVat201Settlement,
} from "@/server/books/vat-settlement";

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
  const ready = await admin.query(`SELECT to_regclass('books_vat201_settlements') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/69 vat201 settlements not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("D3: buildVat201SettlementLines — payable, reclaim, and net-zero", () => {
  const payable = buildVat201SettlementLines({
    outputAccountId: "out",
    inputAccountId: "inp",
    payableAccountId: "pay",
    outputNetMinor: 10_000,
    inputNetMinor: 3_000,
  });
  assert.equal(payable.payableMinor, 7_000);
  assert.equal(payable.lines.length, 3);
  assert.equal(payable.lines[0].debitMinor, 10_000);
  assert.equal(payable.lines[1].creditMinor, 3_000);
  assert.equal(payable.lines[2].creditMinor, 7_000);
  assert.equal(payable.lines[2].accountId, "pay");

  const reclaim = buildVat201SettlementLines({
    outputAccountId: "out",
    inputAccountId: "inp",
    payableAccountId: "pay",
    outputNetMinor: 2_000,
    inputNetMinor: 8_000,
  });
  assert.equal(reclaim.payableMinor, -6_000);
  assert.equal(reclaim.lines[2].debitMinor, 6_000);
  assert.equal(reclaim.lines[2].creditMinor, 0);

  const flat = buildVat201SettlementLines({
    outputAccountId: "out",
    inputAccountId: "inp",
    payableAccountId: "pay",
    outputNetMinor: 5_000,
    inputNetMinor: 5_000,
  });
  assert.equal(flat.payableMinor, 0);
  assert.equal(flat.lines.length, 2);

  const empty = buildVat201SettlementLines({
    outputAccountId: "out",
    inputAccountId: "inp",
    payableAccountId: "pay",
    outputNetMinor: 0,
    inputNetMinor: 0,
  });
  assert.deepEqual(empty.lines, []);
});

test("D3: prepare settlement draft nets 2210/1430 into 2220; second call is idempotent", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "d3-vat201-settle");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    assert.ok(periodId);
    await admin.query(
      `UPDATE clients
       SET establishment_emirate = 'Dubai',
           vat_return_frequency = 'monthly',
           vat_period_end_month = NULL
       WHERE id = $1`,
      [clientId],
    );

    const customer = await createBooksParty(OMAR, clientId, {
      partyType: "customer",
      name: `D3 Cust ${Date.now()}`,
      trn: `100${String(Date.now()).slice(-10)}03`,
      country: "AE",
      zone: "mainland",
      force: true,
    });
    const inv = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: customer.id,
      issueDate: "2026-05-12",
      periodId,
      documentNumber: `D3-${Date.now()}`,
      lines: [
        {
          description: "Advisory",
          lineKind: "revenue",
          vatCode: "SR",
          netMinor: 100_000,
          vatMinor: 5_000,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));

    assert.equal(await getVat201Settlement(OMAR, clientId, { monthEnd: "2026-05-31" }), null);

    const first = await prepareVat201Settlement(OMAR, clientId, { monthEnd: "2026-05-31" });
    assert.equal(first.alreadyPrepared, false);
    assert.equal(first.journalStatus, "draft");
    assert.equal(first.periodFrom, "2026-05-01");
    assert.equal(first.periodTo, "2026-05-31");
    assert.equal(first.outputNetMinor, 5_000);
    assert.equal(first.inputNetMinor, 0);
    assert.equal(first.payableMinor, 5_000);

    const lines = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1
       ORDER BY a.code`,
      [first.journalEntryId],
    );
    const by = Object.fromEntries(
      lines.rows.map((r) => [
        String(r.code),
        { dr: Number(r.debit_minor), cr: Number(r.credit_minor) },
      ]),
    );
    assert.deepEqual(by["2210"], { dr: 5_000, cr: 0 });
    assert.deepEqual(by["2220"], { dr: 0, cr: 5_000 });

    const second = await prepareVat201Settlement(OMAR, clientId, { monthEnd: "2026-05-31" });
    assert.equal(second.alreadyPrepared, true);
    assert.equal(second.journalEntryId, first.journalEntryId);

    const audit = await admin.query(
      `SELECT action FROM books_audit_events
       WHERE client_id = $1 AND entity_id = $2 AND action = 'vat201_settlement'`,
      [clientId, first.id],
    );
    assert.ok(audit.rowCount);

    await assert.rejects(
      () => prepareVat201Settlement(OMAR, clientId, { monthEnd: "2026-04-30" }),
      (e: unknown) => e instanceof BooksError && e.message === "vat201_nothing_to_settle",
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});
