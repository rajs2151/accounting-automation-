/**
 * ING-1 follow-up: the control-account block on manual journals must not break the two flows that
 * legitimately move control accounts — the opening-balance import (AR/AP matched to party open
 * items) and the quarter-end VAT settlement (2210/1430 netted to 2220/1440). Trade controls stay
 * blocked everywhere else. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { vatControlMovement } from "@/server/books/close";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createOpeningImport, postOpeningImport } from "@/server/books/opening-import";
import { createTestCompany } from "@/server/books/test-company";
import { withUser } from "@/lib/db";

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

const L = (accountId: string, debitMinor: number, creditMinor: number) => ({ accountId, debitMinor, creditMinor });

test("opening balances with a customer receivable still import and post", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "ctl-ob");
    await admin.query(`UPDATE clients SET books_start_period_id = $2 WHERE id = $1`, [c.clientId, c.periods["May 2026"]]);
    const p = await admin.query(
      `INSERT INTO books_parties (client_id, party_type, name) VALUES ($1, 'customer', 'Synthetic OB Customer') RETURNING id`,
      [c.clientId],
    );
    const partyId = String(p.rows[0].id);
    const ob = await createOpeningImport(OMAR, c.clientId, {
      lines: [
        { accountCode: "1120", debitMinor: 1000 },
        { accountCode: "1210", debitMinor: 500, partyId },
        { accountCode: "3900", creditMinor: 1500 },
      ],
      partyOpenItems: [{ partyId, side: "AR", amountMinor: 500 }],
    });
    const posted = await postOpeningImport(LAYLA, c.clientId, String(ob.id));
    assert.ok(posted.entryNo);
    const open = await admin.query(
      `SELECT coalesce(sum(open_aed_minor), 0)::bigint AS n FROM books_open_items WHERE client_id = $1 AND party_id = $2`,
      [c.clientId, partyId],
    );
    assert.equal(Number(open.rows[0].n), 500, "open item matches the 1210 opening line");
  } finally {
    await admin.end();
  }
});

test("a pure VAT settlement journal may move 2210/1430; trade controls and mixed lines stay blocked", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "ctl-vat");
    const A = c.accountIdByCode as Record<string, string>;
    const base = { periodId: c.periods["May 2026"]!, entryDate: "2026-05-31", post: false };
    const ok = await createBooksJournal(OMAR, c.clientId, {
      ...base,
      memo: "VAT settlement",
      templateKey: "vat_settlement",
      lines: [L(A["2210"], 1000, 0), L(A["1430"], 0, 300), L(A["2220"], 0, 700)],
    });
    assert.ok(ok.id);
    // Posted on the quarter-end date, the settlement must not offset the close gate's VAT movement.
    const before = await withUser(LAYLA, (db) => vatControlMovement(db, c.clientId, "2026-04-01", "2026-06-30"));
    await postBooksJournal(LAYLA, c.clientId, ok.id);
    const after = await withUser(LAYLA, (db) => vatControlMovement(db, c.clientId, "2026-04-01", "2026-06-30"));
    assert.deepEqual(after, before);
    const refund = await createBooksJournal(OMAR, c.clientId, {
      ...base,
      memo: "VAT settlement (refund)",
      lines: [L(A["2210"], 200, 0), L(A["1440"], 600, 0), L(A["1430"], 0, 800)],
    });
    assert.ok(refund.id);

    const blocked = async (lines: ReturnType<typeof L>[], code: string) =>
      assert.rejects(createBooksJournal(OMAR, c.clientId, { ...base, memo: "blocked", lines }), (e: Error) => {
        assert.equal(e.message, `control_account_forbidden:${code}`);
        return true;
      });
    // VAT control with a bank or P&L line is not a settlement.
    await blocked([L(A["2210"], 500, 0), L(A["1120"], 0, 500)], "2210");
    await blocked([L(A["1430"], 500, 0), L(A["6600"], 0, 500)], "1430");
    // Trade controls are never manual.
    await blocked([L(A["1210"], 500, 0), L(A["4100"], 0, 500)], "1210");
    await blocked([L(A["2110"], 500, 0), L(A["2210"], 0, 500)], "2110");
    // VAT payable (2220) alone with bank is not a pure settlement.
    await blocked([L(A["2220"], 500, 0), L(A["1120"], 0, 500)], "2220");
  } finally {
    await admin.end();
  }
});
