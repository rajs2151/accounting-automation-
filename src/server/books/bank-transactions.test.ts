import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  __testStatementEligible,
  excludeBooksBankTransaction,
  listBooksBankTransactions,
  markBooksBankTransactionReviewed,
  materializeBooksBankTransactions,
  updateBooksBankTransaction,
} from "@/server/books/bank-transactions";
import { BooksError } from "@/server/books/errors";
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
  const ready = await admin.query(`SELECT to_regclass('books_bank_transactions') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/35 C3 bank transactions not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("C3-1: statement eligibility helper", () => {
  assert.equal(__testStatementEligible("ready", []), true);
  assert.equal(__testStatementEligible("confirmed", ["closing_mismatch"]), true);
  assert.equal(__testStatementEligible("needs_review", ["balance_ok"]), true);
  assert.equal(
    __testStatementEligible("needs_review", ["balance_ok", "iban_account_mismatch"]),
    false,
  );
  assert.equal(__testStatementEligible("needs_review", ["closing_mismatch"]), false);
  assert.equal(__testStatementEligible("failed", ["balance_ok"]), false);
});

test("C3-1: materialize idempotent; skip ineligible; mark/exclude gates", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  try {
    const company = await createTestCompany(admin, "c3-txn");
    const clientId = company.clientId;
    const bank = (
      await admin.query(
        `SELECT id FROM books_accounts WHERE client_id = $1 AND code = '1120'`,
        [clientId],
      )
    ).rows[0];
    assert.ok(bank);
    const accountId = String(bank.id);
    const expense = (
      await admin.query(
        `SELECT id FROM books_accounts WHERE client_id = $1 AND is_postable = true
         AND code LIKE '6%' ORDER BY code LIMIT 1`,
        [clientId],
      )
    ).rows[0];
    assert.ok(expense);

    await admin.query(
      `UPDATE books_accounts SET bank_name = 'C3 Bank', iban = 'AE070331234567890123456',
         iban_last4 = '3456' WHERE id = $1`,
      [accountId],
    );

    async function insertStmt(opts: {
      status: string;
      flags: string;
      withLines: boolean;
      suffix: string;
    }) {
      const fileId = randomUUID();
      const stmtId = randomUUID();
      await admin.query(
        `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,'application/pdf',10,$6)`,
        [
          fileId,
          clientId,
          `c3-${opts.suffix}-${randomUUID()}`,
          `books/${clientId}/${fileId}/s.pdf`,
          `s-${opts.suffix}.pdf`,
          OMAR,
        ],
      );
      await admin.query(
        `INSERT INTO books_statement_extractions (
           id, client_id, file_id, account_id, iban, period_from, period_to,
           opening_balance_minor, closing_balance_minor, status, validation_flags
         ) VALUES (
           $1,$2,$3,$4,'AE070331234567890123456','2026-05-01','2026-05-31',
           0,10000,$5,$6::jsonb
         )`,
        [stmtId, clientId, fileId, accountId, opts.status, opts.flags],
      );
      if (opts.withLines) {
        const lineId = randomUUID();
        await admin.query(
          `INSERT INTO books_statement_lines (
             id, statement_id, client_id, line_date, description,
             debit_minor, credit_minor, currency, sort_index
           ) VALUES ($1,$2,$3,'2026-05-05',$4,0,5000,'AED',0)`,
          [lineId, stmtId, clientId, `Receipt ${opts.suffix}`],
        );
        return { stmtId, lineId };
      }
      return { stmtId, lineId: null as string | null };
    }

    const good = await insertStmt({
      status: "needs_review",
      flags: '["balance_ok"]',
      withLines: true,
      suffix: "ok",
    });
    await insertStmt({
      status: "needs_review",
      flags: '["closing_mismatch"]',
      withLines: true,
      suffix: "bad",
    });

    const first = await materializeBooksBankTransactions(OMAR, clientId);
    assert.equal(first.inserted, 1);
    const second = await materializeBooksBankTransactions(OMAR, clientId);
    assert.equal(second.inserted, 0);

    const listed = await listBooksBankTransactions(OMAR, clientId, { materialize: false });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.statementLineId, good.lineId);
    assert.equal(listed[0]!.creditMinor, 5000);
    assert.equal(listed[0]!.amountSignedMinor, 5000);
    assert.equal(listed[0]!.reviewStatus, "needs_review");

    const txnId = listed[0]!.id;

    await assert.rejects(
      () => markBooksBankTransactionReviewed(OMAR, clientId, txnId),
      (e: unknown) => e instanceof BooksError && e.message === "txn_type_required",
    );

    await updateBooksBankTransaction(OMAR, clientId, txnId, {
      txnType: "customer_receipt",
      categoryAccountId: String(expense.id),
    });

    await markBooksBankTransactionReviewed(OMAR, clientId, txnId);
    const ready = await listBooksBankTransactions(OMAR, clientId, {
      status: "ready",
      materialize: false,
    });
    assert.equal(ready.length, 1);
    assert.equal(ready[0]!.txnType, "customer_receipt");

    await assert.rejects(
      () => excludeBooksBankTransaction(OMAR, clientId, txnId, "  "),
      (e: unknown) => e instanceof BooksError && e.message === "exclude_reason_required",
    );

    await excludeBooksBankTransaction(OMAR, clientId, txnId, "Not a company txn");
    const excluded = await listBooksBankTransactions(OMAR, clientId, {
      status: "excluded",
      materialize: false,
    });
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0]!.excludeReason, "Not a company txn");
  } finally {
    await admin.end().catch(() => undefined);
  }
});
