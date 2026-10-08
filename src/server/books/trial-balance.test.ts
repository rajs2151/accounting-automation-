import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { booksTrialBalance } from "./trial-balance";

const OMAR = "55555555-5555-4555-8555-555555555555";
const DESERT = "e1000001-0000-4000-8000-000000000001";
const PERIOD_JUN = "e2000001-0000-4000-8000-000000000013";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("Desert Falcon Jun TB matches hand-computed golden", async (t) => {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const adminUrl = process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return;
  }
  try {
    const ready = await admin.query(`SELECT 1 FROM books_periods WHERE id = $1`, [PERIOD_JUN]);
    if (!ready.rowCount) {
      t.skip("books monthly periods not migrated (22)");
      return;
    }
    const tb = await booksTrialBalance(OMAR, DESERT, PERIOD_JUN);
    const tbAll = await booksTrialBalance(OMAR, DESERT, PERIOD_JUN, { includeZeroBalances: true });
    const golden = JSON.parse(
      readFileSync(path.join(ROOT, "fixtures/books-goldens/a/expected/tb.json"), "utf8"),
    ) as {
      balanced: boolean;
      accounts: Record<string, { debitMinor: number; creditMinor: number }>;
    };
    // Golden period movement includes settled VAT (2210); compare with zeros included.
    assert.equal(tbAll.balanced, golden.balanced);
    assert.equal(tbAll.totalClosingDebit, tbAll.totalClosingCredit);
    for (const [code, expected] of Object.entries(golden.accounts)) {
      assert.ok(tbAll.accounts[code], `missing account ${code}`);
      const row = tbAll.accounts[code];
      assert.equal(row.periodDebitMinor, expected.debitMinor, `${code} period debit`);
      assert.equal(row.periodCreditMinor, expected.creditMinor, `${code} period credit`);
    }
    // Hide-zero = hide zero *closing* balances: settled VAT control (2210) drops out.
    assert.equal(tb.accounts["2210"], undefined, "2210 closing 0 hidden when includeZero false");
    const vat = tbAll.accounts["2210"];
    assert.ok(vat, "2210 present when includeZero true");
    assert.equal(vat.periodDebitMinor, 1500);
    assert.equal(vat.closingDebitMinor, 0);
    assert.equal(vat.closingCreditMinor, 0);
    const rent = tb.accounts["6200"];
    assert.ok(rent);
    assert.equal(rent.periodDebitMinor, 8000, "June rent only in Jun period");
    assert.ok(tb.accounts["2220"] || tbAll.accounts["2220"], "VAT payable from settlement");
    assert.equal(
      (tb.accounts["1430"] || tbAll.accounts["1430"])?.periodCreditMinor,
      100,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});
