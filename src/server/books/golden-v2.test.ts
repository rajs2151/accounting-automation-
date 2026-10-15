/**
 * B5 Golden v2: hand-computed bank cases (partial, 1:N, fee, transfer, card, Stripe).
 * Expected fils: fixtures/books-goldens/v2/a/expected/cases.json
 */
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import {
  linkBooksBankTransferPair,
  listBooksBankTransactions,
  markBooksBankTransactionReviewed,
  materializeBooksBankTransactions,
  postBooksBankTransaction,
  updateBooksBankTransaction,
} from "@/server/books/bank-transactions";
import { approveAndPostBooksDocument, createBooksDocument } from "@/server/books/documents";
import { BooksError } from "@/server/books/errors";
import { createBooksParty } from "@/server/books/parties";
import { createReceiptOrPayment } from "@/server/books/settlements";
import { createTestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";

const expected = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "fixtures/books-goldens/v2/a/expected/cases.json"),
    "utf8",
  ),
).cases;

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
    t.skip("books_bank_transactions missing");
    await admin.end();
    return null;
  }
  return admin;
}

async function openAed(admin: pg.Client, documentId: string) {
  const r = await admin.query(
    `SELECT open_aed_minor::bigint AS n FROM books_open_items WHERE document_id = $1`,
    [documentId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

test("B5 golden v2: partial, 1:N, fee, card, Stripe, transfer", async (t) => {
  const adminClient = await withAdmin(t);
  if (!adminClient) return;
  const admin = adminClient;
  try {
    const company = await createTestCompany(admin, `b5-v2-${Date.now()}`);
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const bank = company.accountIdByCode["1120"];
    const cash = company.accountIdByCode["1110"];
    const clearing = company.accountIdByCode["1310"];
    const fee = company.accountIdByCode["6900"];
    assert.ok(periodId && bank && cash && clearing && fee);
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'B5', iban = 'AE070331234567890123456', iban_last4 = '3456'
       WHERE id = $1`,
      [bank],
    );

    const customer = await createBooksParty(OMAR, clientId, {
      partyType: "customer",
      name: `B5 Cust ${Date.now()}`,
      force: true,
    });

    async function sale(net: number, tag: string) {
      const inv = await createBooksDocument(OMAR, clientId, {
        docType: "sales_invoice",
        partyId: String(customer.id),
        issueDate: "2026-05-05",
        periodId,
        documentNumber: `B5-${tag}-${Date.now()}`,
        lines: [{ description: tag, lineKind: "revenue", vatCode: "ZR", netMinor: net, vatMinor: 0 }],
      });
      await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));
      const oi = await admin.query(`SELECT id FROM books_open_items WHERE document_id = $1`, [inv.id]);
      return { inv, openItemId: String(oi.rows[0].id) };
    }

    // Partial payment
    const p = expected.partial_payment;
    const partial = await sale(p.invoiceNetMinor, "partial");
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: String(customer.id),
      issueDate: "2026-05-10",
      periodId,
      bankAccountId: bank,
      originalAmountMinor: p.receiptMinor,
      allocations: [{ openItemId: partial.openItemId, allocatedOriginalMinor: p.receiptMinor }],
    });
    assert.equal(await openAed(admin, String(partial.inv.id)), p.openRemainingMinor);

    // One payment / two invoices
    const two = expected.one_payment_two_invoices;
    const a = await sale(two.invoiceAMinor, "A");
    const b = await sale(two.invoiceBMinor, "B");
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: String(customer.id),
      issueDate: "2026-05-11",
      periodId,
      bankAccountId: bank,
      originalAmountMinor: two.receiptMinor,
      allocations: [
        { openItemId: a.openItemId, allocatedOriginalMinor: two.invoiceAMinor },
        { openItemId: b.openItemId, allocatedOriginalMinor: two.invoiceBMinor },
      ],
    });
    assert.equal(await openAed(admin, String(a.inv.id)), two.openRemainingA);
    assert.equal(await openAed(admin, String(b.inv.id)), two.openRemainingB);

    // Bank fee difference on receipt
    const bf = expected.bank_fee;
    const feeInv = await sale(bf.invoiceMinor, "fee");
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: String(customer.id),
      issueDate: "2026-05-12",
      periodId,
      bankAccountId: bank,
      originalAmountMinor: bf.receiptBankMinor,
      allocations: [{ openItemId: feeInv.openItemId, allocatedOriginalMinor: bf.invoiceMinor }],
      differenceLines: [
        {
          kind: "bank_fee",
          accountId: fee,
          amountOriginalMinor: bf.feeMinor,
        },
      ],
    });
    assert.equal(await openAed(admin, String(feeInv.inv.id)), bf.openRemaining);

    async function materializeLine(opts: {
      debit: number;
      credit: number;
      desc: string;
      accountId?: string;
      iban?: string;
    }) {
      const accountId = opts.accountId || bank;
      const iban = opts.iban || "AE070331234567890123456";
      const fileId = randomUUID();
      const stmtId = randomUUID();
      const lineId = randomUUID();
      await admin.query(
        `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,'application/pdf',10,$6)`,
        [fileId, clientId, `b5-${randomUUID()}`, `books/${clientId}/${fileId}/x.pdf`, `${opts.desc}.pdf`, OMAR],
      );
      await admin.query(
        `INSERT INTO books_statement_extractions (
           id, client_id, file_id, account_id, iban, period_from, period_to,
           opening_balance_minor, closing_balance_minor, status, validation_flags
         ) VALUES (
           $1,$2,$3,$4,$5,'2026-05-01','2026-05-31',
           0,$6,'ready','["balance_ok"]'::jsonb
         )`,
        [stmtId, clientId, fileId, accountId, iban, opts.credit - opts.debit],
      );
      await admin.query(
        `INSERT INTO books_statement_lines (
           id, statement_id, client_id, line_date, description,
           debit_minor, credit_minor, currency, sort_index
         ) VALUES ($1,$2,$3,'2026-05-18',$4,$5,$6,'AED',0)`,
        [lineId, stmtId, clientId, opts.desc, opts.debit, opts.credit],
      );
      await materializeBooksBankTransactions(OMAR, clientId);
      const listed = await listBooksBankTransactions(OMAR, clientId, {
        materialize: false,
        status: "needs_review",
      });
      const row = listed.find(
        (r) =>
          r.description === opts.desc &&
          r.debitMinor === opts.debit &&
          r.creditMinor === opts.credit,
      );
      assert.ok(row, `missing line ${opts.desc}`);
      return row!.id;
    }

    // Card repayment
    const cr = expected.card_repayment;
    const cardTxn = await materializeLine({ debit: cr.repayMinor, credit: 0, desc: "B5 CARD REPAY" });
    await updateBooksBankTransaction(OMAR, clientId, cardTxn, { txnType: "card_repayment" });
    await markBooksBankTransactionReviewed(OMAR, clientId, cardTxn);
    const cardPosted = await postBooksBankTransaction(LAYLA, clientId, cardTxn);
    const cardLines = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor
       FROM books_journal_lines l JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1`,
      [cardPosted.journalEntryId],
    );
    const byCard = Object.fromEntries(
      cardLines.rows.map((r) => [String(r.code), { dr: Number(r.debit_minor), cr: Number(r.credit_minor) }]),
    );
    assert.equal(byCard["2150"]?.dr, cr.drCard2150);
    assert.equal(byCard["1120"]?.cr, cr.crBank1120);

    // Stripe unbalanced
    const ub = expected.stripe_payout_unbalanced;
    const groupBad = `b5-bad-${Date.now()}`;
    const payBad = await materializeLine({ debit: 0, credit: ub.payoutCreditMinor, desc: "B5 Stripe bad" });
    const feeBad = await materializeLine({ debit: ub.feeDebitMinor, credit: 0, desc: "B5 fee bad" });
    await updateBooksBankTransaction(OMAR, clientId, payBad, {
      txnType: "gateway_payout",
      payoutGroupKey: groupBad,
    });
    await updateBooksBankTransaction(OMAR, clientId, feeBad, {
      txnType: "other_expense",
      categoryAccountId: clearing,
      payoutGroupKey: groupBad,
    });
    await markBooksBankTransactionReviewed(OMAR, clientId, payBad);
    await markBooksBankTransactionReviewed(OMAR, clientId, feeBad);
    await assert.rejects(
      () => postBooksBankTransaction(LAYLA, clientId, payBad),
      (e: unknown) => e instanceof BooksError && e.message === ub.error,
    );

    // Stripe balanced
    const ok = expected.stripe_payout_balanced;
    const groupOk = `b5-ok-${Date.now()}`;
    const payOk = await materializeLine({ debit: 0, credit: ok.payoutCreditMinor, desc: "B5 Stripe ok" });
    const clearOk = await materializeLine({
      debit: ok.clearingDebitMinor,
      credit: 0,
      desc: "B5 clear ok",
    });
    await updateBooksBankTransaction(OMAR, clientId, payOk, {
      txnType: "gateway_payout",
      payoutGroupKey: groupOk,
    });
    await updateBooksBankTransaction(OMAR, clientId, clearOk, {
      txnType: "other_expense",
      categoryAccountId: clearing,
      payoutGroupKey: groupOk,
    });
    await markBooksBankTransactionReviewed(OMAR, clientId, payOk);
    await markBooksBankTransactionReviewed(OMAR, clientId, clearOk);
    const gw = await postBooksBankTransaction(LAYLA, clientId, payOk);
    assert.ok(gw.journalEntryId);

    // Own-account transfer (bank → cash, two statements)
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'B5 Cash', iban = 'AE070331234567890123999', iban_last4 = '3999'
       WHERE id = $1`,
      [cash],
    );
    const outId = await materializeLine({ debit: 5000, credit: 0, desc: "B5 XFER OUT" });
    const inId = await materializeLine({
      debit: 0,
      credit: 5000,
      desc: "B5 XFER IN",
      accountId: cash,
      iban: "AE070331234567890123999",
    });
    await updateBooksBankTransaction(OMAR, clientId, outId, { txnType: "transfer" });
    await updateBooksBankTransaction(OMAR, clientId, inId, { txnType: "transfer" });
    await linkBooksBankTransferPair(OMAR, clientId, outId, inId);
    await markBooksBankTransactionReviewed(OMAR, clientId, outId);
    await markBooksBankTransactionReviewed(OMAR, clientId, inId);
    const xfer = await postBooksBankTransaction(LAYLA, clientId, outId);
    assert.ok(xfer.journalEntryId);
  } finally {
    await admin.end();
  }
});
