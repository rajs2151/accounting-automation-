import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { listBooksJournals } from "./journals";
import { booksTrialBalance } from "./trial-balance";
import { BooksError } from "./errors";

const OMAR = "55555555-5555-4555-8555-555555555555";
const AL_NOOR = "22222222-2222-4222-8222-222222222222";
const PERIOD = "e2000001-0000-4000-8000-000000000001";

test("non-synthetic client blocked on books APIs while FAIL", async (t) => {
  process.env.PORTAL_SECURITY_STATUS = "FAIL";
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
    const col = await admin.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'clients' AND column_name = 'is_synthetic'`,
    );
    if (!col.rowCount) {
      t.skip("is_synthetic missing");
      return;
    }
    await admin.query(`UPDATE clients SET is_synthetic = false WHERE id = $1`, [AL_NOOR]);
    await assert.rejects(
      () => listBooksJournals(OMAR, AL_NOOR),
      (error: unknown) => error instanceof BooksError || (error instanceof Error && error.message === "real_client_data_blocked"),
    );
    await assert.rejects(
      () => booksTrialBalance(OMAR, AL_NOOR, PERIOD),
      (error: unknown) => error instanceof Error && error.message === "real_client_data_blocked",
    );
  } finally {
    await admin.query(`UPDATE clients SET is_synthetic = true WHERE id = $1`, [AL_NOOR]).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});

test("non-synthetic client allowed on books APIs while PASS", async (t) => {
  process.env.PORTAL_SECURITY_STATUS = "PASS";
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
    const col = await admin.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'clients' AND column_name = 'is_synthetic'`,
    );
    if (!col.rowCount) {
      t.skip("is_synthetic missing");
      return;
    }
    await admin.query(`UPDATE clients SET is_synthetic = false WHERE id = $1`, [AL_NOOR]);
    const journals = await listBooksJournals(OMAR, AL_NOOR);
    assert.ok(journals != null);
    assert.doesNotThrow(() => journals);
  } finally {
    process.env.PORTAL_SECURITY_STATUS = "FAIL";
    await admin.query(`UPDATE clients SET is_synthetic = true WHERE id = $1`, [AL_NOOR]).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
