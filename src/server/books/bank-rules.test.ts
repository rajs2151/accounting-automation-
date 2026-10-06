import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  applyBooksBankRuleSuggestions,
  createBooksBankRule,
  previewBooksBankRule,
} from "@/server/books/bank-rules";
import {
  listBooksBankTransactions,
  materializeBooksBankTransactions,
} from "@/server/books/bank-transactions";
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
  const ready = await admin.query(`SELECT to_regclass('books_bank_rules') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/40 bank rules not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("P2A-3: rule suggests type; preview counts history", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  try {
    const company = await createTestCompany(admin, "p2a3-rules");
    const clientId = company.clientId;
    const bank = company.accountIdByCode["1120"];
    const fee = company.accountIdByCode["6900"];
    assert.ok(bank && fee);
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'R', iban = 'AE070331234567890123456',
         iban_last4 = '3456' WHERE id = $1`,
      [bank],
    );
    const fileId = randomUUID();
    const stmtId = randomUUID();
    const lineId = randomUUID();
    await admin.query(
      `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
       VALUES ($1,$2,$3,$4,'r.pdf','application/pdf',10,$5)`,
      [fileId, clientId, `rl-${randomUUID()}`, `books/${clientId}/${fileId}/r.pdf`, OMAR],
    );
    await admin.query(
      `INSERT INTO books_statement_extractions (
         id, client_id, file_id, account_id, iban, period_from, period_to,
         opening_balance_minor, closing_balance_minor, status, validation_flags
       ) VALUES (
         $1,$2,$3,$4,'AE070331234567890123456','2026-05-01','2026-05-31',
         0,-250,'ready','["balance_ok"]'::jsonb
       )`,
      [stmtId, clientId, fileId, bank],
    );
    await admin.query(
      `INSERT INTO books_statement_lines (
         id, statement_id, client_id, line_date, description,
         debit_minor, credit_minor, currency, sort_index
       ) VALUES ($1,$2,$3,'2026-05-04','Monthly bank fee ENBD',250,0,'AED',0)`,
      [lineId, stmtId, clientId],
    );
    await materializeBooksBankTransactions(OMAR, clientId);

    const rule = await createBooksBankRule(OMAR, clientId, {
      name: "ENBD fee",
      priority: 10,
      counterpartyContains: "bank fee",
      direction: "out",
      setTxnType: "bank_charge",
      setCategoryAccountId: fee,
    });
    const applied = await applyBooksBankRuleSuggestions(OMAR, clientId);
    assert.ok(applied.updated >= 1);
    const listed = await listBooksBankTransactions(OMAR, clientId, {
      materialize: false,
      status: "needs_review",
    });
    const row = listed.find((r) => r.description.includes("bank fee"));
    assert.ok(row);
    assert.equal(row!.txnType, "bank_charge");
    assert.equal(row!.categoryAccountId, fee);
    assert.match(String(row!.suggestionSource || ""), /^Rule: ENBD fee/);

    const preview = await previewBooksBankRule(OMAR, clientId, rule.id);
    assert.ok(preview.matchCount >= 1);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
