/**
 * P2B-6 / P2B-7: VAT 201 box mapping and draft return. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { vat201Box, type VatBoxMapRow } from "@/server/books/vat201";

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
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'books_vat_codes' AND column_name = 'vat201_output_box'`,
  );
  if (!ready.rowCount) {
    t.skip("db/54 not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("P2B-6: VAT 201 box map by direction (db/54)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const rows = await admin.query(
      `SELECT code, vat201_output_box AS "vat201OutputBox", vat201_input_box AS "vat201InputBox", vat201_box
       FROM books_vat_codes ORDER BY code`,
    );
    const map = new Map<string, VatBoxMapRow>(rows.rows.map((r) => [String(r.code), r as VatBoxMapRow]));
    const got = Object.fromEntries(
      rows.rows.map((r) => [r.code, [r.vat201OutputBox ?? null, r.vat201InputBox ?? null]]),
    );
    assert.deepEqual(got, {
      EX: ["5", null],
      NR: [null, null],
      OS: [null, null],
      RC_IN: [null, "10"],
      RC_OUT: ["3", null],
      SR: ["1", "9"],
      ZR: ["4", null],
    });
    const legacy = Object.fromEntries(rows.rows.map((r) => [r.code, r.vat201_box]));
    assert.equal(legacy.ZR, "4");
    assert.equal(legacy.EX, "5");

    // Sales SR goes to the emirate's sub-box; without an emirate it cannot be placed.
    assert.deepEqual(vat201Box(map, "SR", "output", "Dubai"), { box: "1b", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "SR", "output", "Fujairah"), { box: "1g", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "SR", "output", null), { box: null, needsEmirate: true });
    assert.deepEqual(vat201Box(map, "SR", "output", "OUTSIDE_UAE"), { box: null, needsEmirate: true });
    assert.deepEqual(vat201Box(map, "SR", "input"), { box: "9", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "ZR", "output"), { box: "4", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "EX", "output"), { box: "5", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "RC_OUT", "output"), { box: "3", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "RC_IN", "input"), { box: "10", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "NR", "input"), { box: null, needsEmirate: false });
    assert.deepEqual(vat201Box(map, "OS", "output"), { box: null, needsEmirate: false });
    assert.deepEqual(vat201Box(map, null, "output"), { box: null, needsEmirate: false });
  } finally {
    await admin.end().catch(() => undefined);
  }
});
