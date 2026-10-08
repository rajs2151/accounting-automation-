/**
 * B6: receipt → match unmatched bank line or create expense draft.
 */
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  listBooksBankTransactions,
  materializeBooksBankTransactions,
} from "@/server/books/bank-transactions";
import { addTransactionFromReceipt } from "@/server/books/receipt-to-txn";
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
  const ready = await admin.query(`SELECT to_regclass('books_expenses') AS e, to_regclass('books_bank_transactions') AS b`);
  if (!ready.rows[0]?.e || !ready.rows[0]?.b) {
    t.skip("expenses or bank txns missing");
    await admin.end();
    return null;
  }
  return admin;
}

test("B6: no bank match → expense draft; exact amount match → linked", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, `b6-rtt-${Date.now()}`);
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const bank = company.accountIdByCode["1120"];
    const opex = company.accountIdByCode["6600"];
    assert.ok(periodId && bank && opex);

    const draftOnly = await addTransactionFromReceipt(OMAR, clientId, {
      expenseDate: "2026-05-20",
      periodId,
      description: "Taxi receipt",
      vendorName: "Careem",
      amountMinor: 12_50,
      expenseAccountId: opex,
      forceExpenseDraft: true,
    });
    assert.equal(draftOnly.kind, "expense_draft");
    assert.ok(draftOnly.expenseId);

    const fileId = randomUUID();
    const stmtId = randomUUID();
    const lineId = randomUUID();
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'B6', iban = 'AE070331234567890123456', iban_last4 = '3456' WHERE id = $1`,
      [bank],
    );
    await admin.query(
      `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
       VALUES ($1,$2,$3,$4,'b6.pdf','application/pdf',10,$5)`,
      [fileId, clientId, `b6-${randomUUID()}`, `books/${clientId}/${fileId}/b6.pdf`, OMAR],
    );
    await admin.query(
      `INSERT INTO books_statement_extractions (
         id, client_id, file_id, account_id, iban, period_from, period_to,
         opening_balance_minor, closing_balance_minor, status, validation_flags
       ) VALUES (
         $1,$2,$3,$4,'AE070331234567890123456','2026-05-01','2026-05-31',
         0,-1250,'ready','["balance_ok"]'::jsonb
       )`,
      [stmtId, clientId, fileId, bank],
    );
    await admin.query(
      `INSERT INTO books_statement_lines (
         id, statement_id, client_id, line_date, description,
         debit_minor, credit_minor, currency, sort_index
       ) VALUES ($1,$2,$3,'2026-05-20','CAREEM RIDE',1250,0,'AED',0)`,
      [lineId, stmtId, clientId],
    );
    await materializeBooksBankTransactions(OMAR, clientId);
    const listed = await listBooksBankTransactions(OMAR, clientId, {
      materialize: false,
      status: "needs_review",
    });
    assert.ok(listed.some((r) => r.debitMinor === 1250));

    const matched = await addTransactionFromReceipt(OMAR, clientId, {
      expenseDate: "2026-05-20",
      periodId,
      description: "Careem ride",
      amountMinor: 12_50,
      expenseAccountId: opex,
      paidFromAccountId: bank,
    });
    assert.equal(matched.kind, "matched_bank");
    if (matched.kind === "matched_bank") {
      assert.ok(matched.bankTxnId);
      assert.ok(matched.expenseId);
      const linked = await admin.query(
        `SELECT bank_txn_id FROM books_expenses WHERE id = $1`,
        [matched.expenseId],
      );
      assert.equal(String(linked.rows[0].bank_txn_id), matched.bankTxnId);
    }
  } finally {
    await admin.end();
  }
});
