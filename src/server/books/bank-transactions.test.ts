import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { bankTxnUnallocatedMinor } from "@/lib/bank-txn-alloc";
import {
  __testStatementEligible,
  excludeBooksBankTransaction,
  linkBooksBankTransferPair,
  listBooksBankTxnMatchCandidates,
  listBooksBankTransactions,
  markBooksBankTransactionReviewed,
  matchBooksBankTransaction,
  materializeBooksBankTransactions,
  postBooksBankTransaction,
  rejectBooksBankTxnMatchSuggestion,
  setBooksBankTxnAllocations,
  updateBooksBankTransaction,
} from "@/server/books/bank-transactions";
import { approveAndPostBooksDocument, createBooksDocument } from "@/server/books/documents";
import { BooksError } from "@/server/books/errors";
import { createBooksParty } from "@/server/books/parties";
import { createTestCompany } from "@/server/books/test-company";

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
  const ready = await admin.query(`SELECT to_regclass('books_bank_transactions') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/35 C3 bank transactions not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("P2A-1: unallocated helper — fee and 1:N", () => {
  assert.equal(
    bankTxnUnallocatedMinor(
      99500,
      [
        { allocKind: "against_item", amountOriginalMinor: 100000 },
        { allocKind: "bank_fee", amountOriginalMinor: 500 },
      ],
      "receipt",
    ),
    0,
  );
  assert.equal(
    bankTxnUnallocatedMinor(
      150000,
      [
        { allocKind: "against_item", amountOriginalMinor: 100000 },
        { allocKind: "against_item", amountOriginalMinor: 50000 },
      ],
      "receipt",
    ),
    0,
  );
  assert.equal(
    bankTxnUnallocatedMinor(
      40000,
      [{ allocKind: "against_item", amountOriginalMinor: 100000 }],
      "receipt",
    ),
    -60000,
  );
  assert.equal(
    bankTxnUnallocatedMinor(
      10500,
      [
        { allocKind: "against_item", amountOriginalMinor: 10000 },
        { allocKind: "bank_fee", amountOriginalMinor: 500 },
      ],
      "payment",
    ),
    0,
  );
});

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

test("C3-2: match AR open item + dual-control post receipt", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  const matchCol = await admin.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'books_bank_transactions' AND column_name = 'open_item_id'`,
  );
  if (!matchCol.rowCount) {
    t.skip("db/36 match columns not migrated");
    await admin.end();
    return;
  }
  try {
    const company = await createTestCompany(admin, "c3-post");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    assert.ok(periodId);
    const bank = (
      await admin.query(
        `SELECT id FROM books_accounts WHERE client_id = $1 AND code = '1120'`,
        [clientId],
      )
    ).rows[0];
    const ar = (
      await admin.query(
        `SELECT id FROM books_accounts WHERE client_id = $1 AND code = '1210'`,
        [clientId],
      )
    ).rows[0];
    assert.ok(bank && ar);
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'C3 Bank', iban = 'AE070331234567890123456',
         iban_last4 = '3456' WHERE id = $1`,
      [bank.id],
    );

    const customer = await createBooksParty(OMAR, clientId, {
      partyType: "customer",
      name: `C3 Cust ${Date.now()}`,
      force: true,
    });
    const inv = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: String(customer.id),
      issueDate: "2026-05-01",
      periodId,
      documentNumber: `C3-INV-${Date.now()}`,
      lines: [
        {
          description: "Svc",
          lineKind: "revenue",
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));
    const oi = await admin.query(
      `SELECT id, open_original_minor FROM books_open_items WHERE document_id = $1`,
      [inv.id],
    );
    assert.equal(Number(oi.rows[0].open_original_minor), 10500);

    const fileId = randomUUID();
    const stmtId = randomUUID();
    const lineId = randomUUID();
    await admin.query(
      `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
       VALUES ($1,$2,$3,$4,'r.pdf','application/pdf',10,$5)`,
      [fileId, clientId, `c3p-${randomUUID()}`, `books/${clientId}/${fileId}/r.pdf`, OMAR],
    );
    await admin.query(
      `INSERT INTO books_statement_extractions (
         id, client_id, file_id, account_id, iban, period_from, period_to,
         opening_balance_minor, closing_balance_minor, status, validation_flags
       ) VALUES (
         $1,$2,$3,$4,'AE070331234567890123456','2026-05-01','2026-05-31',
         0,10500,'ready','["balance_ok"]'::jsonb
       )`,
      [stmtId, clientId, fileId, bank.id],
    );
    await admin.query(
      `INSERT INTO books_statement_lines (
         id, statement_id, client_id, line_date, description,
         debit_minor, credit_minor, currency, sort_index
       ) VALUES ($1,$2,$3,'2026-05-08','Customer receipt',0,10500,'AED',0)`,
      [lineId, stmtId, clientId],
    );

    await materializeBooksBankTransactions(OMAR, clientId);
    const listed = await listBooksBankTransactions(OMAR, clientId, {
      materialize: false,
      status: "needs_review",
    });
    assert.equal(listed.length, 1);
    const txnId = listed[0]!.id;

    await updateBooksBankTransaction(OMAR, clientId, txnId, {
      txnType: "customer_receipt",
      categoryAccountId: String(ar.id),
    });
    await markBooksBankTransactionReviewed(OMAR, clientId, txnId);
    await matchBooksBankTransaction(OMAR, clientId, txnId, String(oi.rows[0].id));

    // Omar is preparer (accountant) — cannot post.
    await assert.rejects(
      () => postBooksBankTransaction(OMAR, clientId, txnId),
      (e: unknown) =>
        e instanceof BooksError &&
        (e.message === "post_requires_approver" || e.message === "post_preparer_cannot_approve"),
    );

    const posted = await postBooksBankTransaction(LAYLA, clientId, txnId);
    assert.ok(posted.entryNo);
    assert.ok(posted.journalEntryId);

    const after = await listBooksBankTransactions(OMAR, clientId, {
      status: "posted",
      materialize: false,
    });
    assert.equal(after.length, 1);
    assert.equal(after[0]!.openItemId, String(oi.rows[0].id));

    const oiAfter = await admin.query(
      `SELECT open_original_minor, status FROM books_open_items WHERE id = $1`,
      [oi.rows[0].id],
    );
    assert.equal(Number(oiAfter.rows[0].open_original_minor), 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C3-3: transfer pair posts one Contra CV", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  const linkCol = await admin.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'books_bank_transactions' AND column_name = 'linked_txn_id'`,
  );
  if (!linkCol.rowCount) {
    t.skip("db/37 transfer link not migrated");
    await admin.end();
    return;
  }
  try {
    const company = await createTestCompany(admin, "c3-xfer");
    const clientId = company.clientId;
    const fromBank = company.accountIdByCode["1120"];
    const toBank = company.accountIdByCode["1110"];
    assert.ok(fromBank && toBank);

    await admin.query(
      `UPDATE books_accounts SET bank_name = 'AED Bank', iban = 'AE070331234567890123456',
         iban_last4 = '3456' WHERE id = $1`,
      [fromBank],
    );
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'Cash', iban = NULL, iban_last4 = NULL WHERE id = $1`,
      [toBank],
    );

    async function stmtWithLine(opts: {
      accountId: string;
      iban: string | null;
      debit: number;
      credit: number;
      desc: string;
    }) {
      const fileId = randomUUID();
      const stmtId = randomUUID();
      const lineId = randomUUID();
      await admin.query(
        `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,'application/pdf',10,$6)`,
        [
          fileId,
          clientId,
          `xf-${randomUUID()}`,
          `books/${clientId}/${fileId}/x.pdf`,
          `${opts.desc}.pdf`,
          OMAR,
        ],
      );
      await admin.query(
        `INSERT INTO books_statement_extractions (
           id, client_id, file_id, account_id, iban, period_from, period_to,
           opening_balance_minor, closing_balance_minor, status, validation_flags
         ) VALUES (
           $1,$2,$3,$4,$5,'2026-05-01','2026-05-31',
           0,$6,'ready','["balance_ok"]'::jsonb
         )`,
        [
          stmtId,
          clientId,
          fileId,
          opts.accountId,
          opts.iban,
          opts.credit - opts.debit,
        ],
      );
      await admin.query(
        `INSERT INTO books_statement_lines (
           id, statement_id, client_id, line_date, description,
           debit_minor, credit_minor, currency, sort_index
         ) VALUES ($1,$2,$3,'2026-05-12',$4,$5,$6,'AED',0)`,
        [lineId, stmtId, clientId, opts.desc, opts.debit, opts.credit],
      );
    }

    await stmtWithLine({
      accountId: fromBank,
      iban: "AE070331234567890123456",
      debit: 7500,
      credit: 0,
      desc: "Transfer out to cash",
    });
    await stmtWithLine({
      accountId: toBank,
      iban: null,
      debit: 0,
      credit: 7500,
      desc: "Transfer in from bank",
    });

    await materializeBooksBankTransactions(OMAR, clientId);
    const listed = await listBooksBankTransactions(OMAR, clientId, {
      materialize: false,
      status: "needs_review",
    });
    assert.equal(listed.length, 2);
    const out = listed.find((r) => r.debitMinor === 7500);
    const inn = listed.find((r) => r.creditMinor === 7500);
    assert.ok(out && inn);

    await updateBooksBankTransaction(OMAR, clientId, out.id, { txnType: "transfer" });
    await updateBooksBankTransaction(OMAR, clientId, inn.id, { txnType: "transfer" });

    await assert.rejects(
      () => linkBooksBankTransferPair(OMAR, clientId, out.id, out.id),
      (e: unknown) => e instanceof BooksError && e.message === "transfer_same_txn",
    );

    await linkBooksBankTransferPair(OMAR, clientId, out.id, inn.id);
    await markBooksBankTransactionReviewed(OMAR, clientId, out.id);
    await markBooksBankTransactionReviewed(OMAR, clientId, inn.id);

    await assert.rejects(
      () => postBooksBankTransaction(OMAR, clientId, out.id),
      (e: unknown) =>
        e instanceof BooksError &&
        (e.message === "post_requires_approver" || e.message === "post_preparer_cannot_approve"),
    );

    const posted = await postBooksBankTransaction(LAYLA, clientId, out.id);
    assert.match(String(posted.entryNo), /^CV-2026-\d+$/);
    assert.equal(posted.pairedTxnId, inn.id);

    const after = await listBooksBankTransactions(OMAR, clientId, {
      status: "posted",
      materialize: false,
    });
    assert.equal(after.length, 2);
    assert.equal(after[0]!.journalEntryId, after[1]!.journalEntryId);
    assert.equal(after[0]!.journalEntryId, posted.journalEntryId);

    const allocs = await admin.query(
      `SELECT 1 FROM books_allocations WHERE settlement_journal_id = $1`,
      [posted.journalEntryId],
    );
    assert.equal(allocs.rowCount, 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2A-1: 1:N split + bank fee; unallocated gate; N:1 partial", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  const allocTbl = await admin.query(`SELECT to_regclass('books_bank_txn_allocations') AS t`);
  if (!allocTbl.rows[0]?.t) {
    t.skip("db/38 allocations not migrated");
    await admin.end();
    return;
  }
  try {
    const company = await createTestCompany(admin, "p2a1-split");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    assert.ok(periodId);
    const bank = company.accountIdByCode["1120"];
    const feeAcct = company.accountIdByCode["6900"];
    const ar = company.accountIdByCode["1210"];
    assert.ok(bank && feeAcct && ar);
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'P2A Bank', iban = 'AE070331234567890123456',
         iban_last4 = '3456' WHERE id = $1`,
      [bank],
    );

    const customer = await createBooksParty(OMAR, clientId, {
      partyType: "customer",
      name: `P2A Cust ${Date.now()}`,
      force: true,
    });

    async function postInvoice(net: number, vat: number, docNo: string) {
      const inv = await createBooksDocument(OMAR, clientId, {
        docType: "sales_invoice",
        partyId: String(customer.id),
        issueDate: "2026-05-01",
        periodId,
        documentNumber: docNo,
        lines: [
          {
            description: "Svc",
            lineKind: "revenue",
            vatCode: "SR",
            netMinor: net,
            vatMinor: vat,
          },
        ],
      });
      await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));
      const oi = await admin.query(
        `SELECT id, open_original_minor FROM books_open_items WHERE document_id = $1`,
        [inv.id],
      );
      return { invId: String(inv.id), oiId: String(oi.rows[0].id), open: Number(oi.rows[0].open_original_minor) };
    }

    const invA = await postInvoice(10000, 500, `P2A-A-${Date.now()}`);
    const invB = await postInvoice(5000, 250, `P2A-B-${Date.now()}`);
    assert.equal(invA.open, 10500);
    assert.equal(invB.open, 5250);

    async function materializeCredit(credit: number, desc: string) {
      const fileId = randomUUID();
      const stmtId = randomUUID();
      const lineId = randomUUID();
      await admin.query(
        `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,'application/pdf',10,$6)`,
        [fileId, clientId, `p2a-${randomUUID()}`, `books/${clientId}/${fileId}/x.pdf`, `${desc}.pdf`, OMAR],
      );
      await admin.query(
        `INSERT INTO books_statement_extractions (
           id, client_id, file_id, account_id, iban, period_from, period_to,
           opening_balance_minor, closing_balance_minor, status, validation_flags
         ) VALUES (
           $1,$2,$3,$4,'AE070331234567890123456','2026-05-01','2026-05-31',
           0,$5,'ready','["balance_ok"]'::jsonb
         )`,
        [stmtId, clientId, fileId, bank, credit],
      );
      await admin.query(
        `INSERT INTO books_statement_lines (
           id, statement_id, client_id, line_date, description,
           debit_minor, credit_minor, currency, sort_index
         ) VALUES ($1,$2,$3,'2026-05-20',$4,0,$5,'AED',0)`,
        [lineId, stmtId, clientId, desc, credit],
      );
      await materializeBooksBankTransactions(OMAR, clientId);
      const listed = await listBooksBankTransactions(OMAR, clientId, {
        materialize: false,
        status: "needs_review",
      });
      const row = listed.find((r) => r.creditMinor === credit && r.description === desc);
      assert.ok(row);
      return row.id;
    }

    // 1:N + fee: bank 15500 = invA 10500 + invB 5250 - wait that's 15750.
    // bank 15700 with fee 50: against 10500+5250, fee 50 → explained 15750-50=15700.
    const txn1 = await materializeCredit(15700, "Combo receipt");
    await updateBooksBankTransaction(OMAR, clientId, txn1, {
      txnType: "customer_receipt",
      categoryAccountId: ar,
    });
    // Partial plan → unallocated ≠ 0 → cannot mark Ready.
    await setBooksBankTxnAllocations(OMAR, clientId, txn1, [
      { allocKind: "against_item", openItemId: invA.oiId, amountOriginalMinor: 10500 },
    ]);
    await assert.rejects(
      () => markBooksBankTransactionReviewed(OMAR, clientId, txn1),
      (e: unknown) => e instanceof BooksError && e.message === "settlement_unallocated_nonzero",
    );
    await setBooksBankTxnAllocations(OMAR, clientId, txn1, [
      { allocKind: "against_item", openItemId: invA.oiId, amountOriginalMinor: 10500 },
      { allocKind: "against_item", openItemId: invB.oiId, amountOriginalMinor: 5250 },
      { allocKind: "bank_fee", accountId: feeAcct, amountOriginalMinor: 50 },
    ]);
    await markBooksBankTransactionReviewed(OMAR, clientId, txn1);
    const posted1 = await postBooksBankTransaction(LAYLA, clientId, txn1);
    assert.match(String(posted1.entryNo), /^RV-2026-\d+$/);

    const oiA = await admin.query(
      `SELECT open_original_minor, status FROM books_open_items WHERE id = $1`,
      [invA.oiId],
    );
    const oiB = await admin.query(
      `SELECT open_original_minor, status FROM books_open_items WHERE id = $1`,
      [invB.oiId],
    );
    assert.equal(Number(oiA.rows[0].open_original_minor), 0);
    assert.equal(Number(oiB.rows[0].open_original_minor), 0);

    // N:1 partial: two bank lines against one new invoice
    const invC = await postInvoice(20000, 1000, `P2A-C-${Date.now()}`);
    assert.equal(invC.open, 21000);
    const txn2 = await materializeCredit(10000, "Partial 1");
    const txn3 = await materializeCredit(11000, "Partial 2");
    await updateBooksBankTransaction(OMAR, clientId, txn2, {
      txnType: "customer_receipt",
      categoryAccountId: ar,
    });
    await updateBooksBankTransaction(OMAR, clientId, txn3, {
      txnType: "customer_receipt",
      categoryAccountId: ar,
    });
    await setBooksBankTxnAllocations(OMAR, clientId, txn2, [
      { allocKind: "against_item", openItemId: invC.oiId, amountOriginalMinor: 10000 },
    ]);
    await setBooksBankTxnAllocations(OMAR, clientId, txn3, [
      { allocKind: "against_item", openItemId: invC.oiId, amountOriginalMinor: 11000 },
    ]);
    await markBooksBankTransactionReviewed(OMAR, clientId, txn2);
    await markBooksBankTransactionReviewed(OMAR, clientId, txn3);
    await postBooksBankTransaction(LAYLA, clientId, txn2);
    await postBooksBankTransaction(LAYLA, clientId, txn3);
    const oiC = await admin.query(
      `SELECT open_original_minor, status FROM books_open_items WHERE id = $1`,
      [invC.oiId],
    );
    assert.equal(Number(oiC.rows[0].open_original_minor), 0);
    assert.equal(String(oiC.rows[0].status), "closed");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2A-2: scored candidates; reject remembered", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  const rej = await admin.query(`SELECT to_regclass('books_bank_txn_rejected_matches') AS t`);
  if (!rej.rows[0]?.t) {
    t.skip("db/39 match suggestions not migrated");
    await admin.end();
    return;
  }
  try {
    const company = await createTestCompany(admin, "p2a2-score");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const bank = company.accountIdByCode["1120"];
    const ar = company.accountIdByCode["1210"];
    assert.ok(periodId && bank && ar);
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'P2A2', iban = 'AE070331234567890123456',
         iban_last4 = '3456' WHERE id = $1`,
      [bank],
    );
    const partyName = `Score Co ${Date.now()}`;
    const customer = await createBooksParty(OMAR, clientId, {
      partyType: "customer",
      name: partyName,
      force: true,
    });
    const docNo = `SCR-${Date.now()}`;
    const inv = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: String(customer.id),
      issueDate: "2026-05-01",
      periodId,
      documentNumber: docNo,
      lines: [
        {
          description: "Svc",
          lineKind: "revenue",
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));
    const oi = await admin.query(
      `SELECT id FROM books_open_items WHERE document_id = $1`,
      [inv.id],
    );
    const fileId = randomUUID();
    const stmtId = randomUUID();
    const lineId = randomUUID();
    await admin.query(
      `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
       VALUES ($1,$2,$3,$4,'s.pdf','application/pdf',10,$5)`,
      [fileId, clientId, `sc-${randomUUID()}`, `books/${clientId}/${fileId}/s.pdf`, OMAR],
    );
    await admin.query(
      `INSERT INTO books_statement_extractions (
         id, client_id, file_id, account_id, iban, period_from, period_to,
         opening_balance_minor, closing_balance_minor, status, validation_flags
       ) VALUES (
         $1,$2,$3,$4,'AE070331234567890123456','2026-05-01','2026-05-31',
         0,10500,'ready','["balance_ok"]'::jsonb
       )`,
      [stmtId, clientId, fileId, bank],
    );
    await admin.query(
      `INSERT INTO books_statement_lines (
         id, statement_id, client_id, line_date, description, reference,
         debit_minor, credit_minor, currency, sort_index
       ) VALUES ($1,$2,$3,'2026-05-03',$4,$5,0,10500,'AED',0)`,
      [lineId, stmtId, clientId, `${partyName} payment`, docNo],
    );
    await materializeBooksBankTransactions(OMAR, clientId);
    const listed = await listBooksBankTransactions(OMAR, clientId, {
      materialize: false,
      status: "needs_review",
    });
    const txnId = listed[0]!.id;
    await updateBooksBankTransaction(OMAR, clientId, txnId, {
      txnType: "customer_receipt",
      categoryAccountId: ar,
    });
    const before = await listBooksBankTxnMatchCandidates(OMAR, clientId, txnId);
    assert.ok(before.candidates.length >= 1);
    assert.ok(before.candidates[0]!.score >= 0.5);
    assert.ok(before.candidates[0]!.breakdown);
    await rejectBooksBankTxnMatchSuggestion(OMAR, clientId, txnId, String(oi.rows[0].id));
    const after = await listBooksBankTxnMatchCandidates(OMAR, clientId, txnId);
    assert.equal(
      after.candidates.some((c) => c.openItemId === String(oi.rows[0].id)),
      false,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});
