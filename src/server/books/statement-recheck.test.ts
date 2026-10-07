/**
 * A statement that re-checks clean must be able to produce bank transactions (it showed "Balanced" but
 * the import requires the balance_ok flag, which the re-check never recorded). Synthetic data only.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { materializeBooksBankTransactions } from "@/server/books/bank-transactions";
import { updateStatementLines } from "@/server/books/statement-extractions";
import { createTestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";

test("re-checking a balanced statement makes its lines importable", async (t) => {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const admin = new pg.Client({
    connectionString: process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:"),
  });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return;
  }
  try {
    const company = await createTestCompany(admin, "stmt-recheck");
    const c = company.clientId;
    const bank = company.accountIdByCode["1120"]!;
    const iban = "AE070331234567890199999";
    await admin.query(`UPDATE books_accounts SET iban = $2, bank_name = 'Synthetic Bank' WHERE id = $1`, [bank, iban]);
    const fileId = randomUUID();
    const stmtId = randomUUID();
    await admin.query(
      `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
       VALUES ($1,$2,$3,$4,'stmt.csv','text/csv',10,$5)`,
      [fileId, c, `recheck-${randomUUID()}`, `books/${c}/${fileId}/s.csv`, OMAR],
    );
    // Like a seeded / CSV statement: finished, but its balance never verified (no flags).
    await admin.query(
      `INSERT INTO books_statement_extractions (
         id, client_id, file_id, account_id, iban, currency, period_from, period_to,
         opening_balance_minor, closing_balance_minor, status, validation_flags
       ) VALUES ($1,$2,$3,$4,$5,'AED','2026-05-01','2026-05-31',100000,130000,'needs_review','[]'::jsonb)`,
      [stmtId, c, fileId, bank, iban],
    );
    assert.equal((await materializeBooksBankTransactions(OMAR, c)).inserted ?? 0, 0, "unverified statement is not imported");

    await updateStatementLines(OMAR, c, stmtId, {
      lines: [
        { lineDate: "2026-05-05", description: "Customer receipt", creditMinor: 40000 },
        { lineDate: "2026-05-09", description: "Rent", debitMinor: 10000 },
      ],
    });
    const flags = await admin.query(`SELECT validation_flags, status FROM books_statement_extractions WHERE id = $1`, [stmtId]);
    assert.deepEqual(flags.rows[0].validation_flags, ["balance_ok"]);
    const res = await materializeBooksBankTransactions(OMAR, c);
    assert.equal(res.inserted, 2);
  } finally {
    await admin.end();
  }
});
