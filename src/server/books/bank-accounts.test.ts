import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  listBooksBankAccounts,
  updateBooksBankAccountSetup,
} from "@/server/books/bank-accounts";
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
  const col = await admin.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'books_accounts' AND column_name = 'iban'`,
  );
  if (!col.rowCount) {
    t.skip("db/33 C2 bank accounts not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("C2: listBooksBankAccounts marks unset banks Not set up; setup + IBAN link", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c2-bank");
    const clientId = company.clientId;

    const bank = await admin.query(
      `SELECT id, code FROM books_accounts
       WHERE client_id = $1 AND is_postable = true
         AND (is_bank = true OR COALESCE(sub_type,'') = 'bank')
         AND COALESCE(sub_type,'') <> 'cash'
       ORDER BY code LIMIT 1`,
      [clientId],
    );
    assert.ok(bank.rowCount, "seeded bank account");
    const accountId = String(bank.rows[0].id);
    const code = String(bank.rows[0].code);
    // Ensure clean slate for setup gate (seeds may already set IBAN later).
    await admin.query(
      `UPDATE books_accounts SET bank_name = NULL, iban = NULL, iban_last4 = NULL
       WHERE id = $1 AND client_id = $2`,
      [accountId, clientId],
    );

    let rows = await listBooksBankAccounts(OMAR, clientId);
    const before = rows.find((r) => r.id === accountId);
    assert.ok(before);
    assert.equal(before.instrumentType, "bank");
    assert.equal(before.setupOk, false);

    await updateBooksBankAccountSetup(OMAR, clientId, accountId, {
      bankName: "Test Bank UAE",
      iban: "AE070331234567890123456",
    });

    const fileId = randomUUID();
    const stmtId = randomUUID();
    await admin.query(
      `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
       VALUES ($1,$2,$3,$4,'stmt.pdf','application/pdf',10,$5)`,
      [fileId, clientId, `c2-${randomUUID()}`, `books/${clientId}/${fileId}/stmt.pdf`, OMAR],
    );
    await admin.query(
      `INSERT INTO books_statement_extractions (
         id, client_id, file_id, iban, bank_name, period_from, period_to,
         opening_balance_minor, closing_balance_minor, status
       ) VALUES (
         $1,$2,$3,'AE07 0331 2345 6789 0123 456','Test Bank UAE',
         '2026-04-01','2026-04-30',0,10000,'needs_review'
       )`,
      [stmtId, clientId, fileId],
    );
    // Second statement with a gap in May
    const stmt2 = randomUUID();
    const file2 = randomUUID();
    await admin.query(
      `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
       VALUES ($1,$2,$3,$4,'stmt2.pdf','application/pdf',10,$5)`,
      [file2, clientId, `c2b-${randomUUID()}`, `books/${clientId}/${file2}/stmt2.pdf`, OMAR],
    );
    await admin.query(
      `INSERT INTO books_statement_extractions (
         id, client_id, file_id, iban, period_from, period_to,
         opening_balance_minor, closing_balance_minor, status, account_id
       ) VALUES (
         $1,$2,$3,'AE070331234567890123456','2026-06-01','2026-06-30',0,20000,'needs_review',$4
       )`,
      [stmt2, clientId, file2, accountId],
    );

    // Link first statement via setup IBAN match (update already ran — re-run link)
    await updateBooksBankAccountSetup(OMAR, clientId, accountId, {
      bankName: "Test Bank UAE",
      iban: "AE070331234567890123456",
    });

    rows = await listBooksBankAccounts(OMAR, clientId);
    const after = rows.find((r) => r.id === accountId);
    assert.ok(after);
    assert.equal(after.setupOk, true);
    assert.equal(after.code, code);
    assert.equal(after.coverageFrom, "2026-04-01");
    assert.equal(after.coverageTo, "2026-06-30");
    assert.ok(after.gaps.some((g) => g.from === "2026-05-01" && g.to === "2026-05-31"));
    assert.equal(after.lastClosingMinor, 20000);
    assert.ok(after.statementCount >= 2);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
