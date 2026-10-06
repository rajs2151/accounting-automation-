/**
 * P2B-3: bank reconciliation check — ledger balance at period end vs statement balance, with an
 * unreconciled list that explains the difference. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { listBooksBankAccounts } from "@/server/books/bank-accounts";
import { getBankReconciliation, listBankReconciliations } from "@/server/books/bank-recon";
import {
  excludeBooksBankTransaction,
  listBooksBankTransactions,
  markBooksBankTransactionReviewed,
  matchBooksBankTransaction,
  materializeBooksBankTransactions,
  postBooksBankTransaction,
  updateBooksBankTransaction,
} from "@/server/books/bank-transactions";
import { approveAndPostBooksDocument, createBooksDocument } from "@/server/books/documents";
import { createBooksJournal, postBooksJournal, reverseBooksJournal } from "@/server/books/journals";
import { listBooksOpenItems } from "@/server/books/open-items";
import { createBooksParty } from "@/server/books/parties";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const IBAN_AED = "AE070331234567890123456";
const IBAN_USD = "AE460330000010123456789";

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
    t.skip("C3 bank transactions not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

async function insertStatement(
  admin: pg.Client,
  company: TestCompany,
  opts: {
    accountId: string;
    iban: string;
    from: string;
    to: string;
    opening: number;
    closing: number;
    currency?: string;
    lines: Array<{ date: string; desc: string; debit?: number; credit?: number }>;
  },
) {
  const fileId = randomUUID();
  const stmtId = randomUUID();
  await admin.query(
    `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
     VALUES ($1,$2,$3,$4,'stmt.csv','text/csv',10,$5)`,
    [fileId, company.clientId, `p2b3-${randomUUID()}`, `books/${company.clientId}/${fileId}/s.csv`, OMAR],
  );
  await admin.query(
    `INSERT INTO books_statement_extractions (
       id, client_id, file_id, account_id, iban, currency, period_from, period_to,
       opening_balance_minor, closing_balance_minor, status, validation_flags
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready','["balance_ok"]'::jsonb)`,
    [
      stmtId,
      company.clientId,
      fileId,
      opts.accountId,
      opts.iban,
      opts.currency || "AED",
      opts.from,
      opts.to,
      opts.opening,
      opts.closing,
    ],
  );
  let i = 0;
  for (const l of opts.lines) {
    await admin.query(
      `INSERT INTO books_statement_lines (
         id, statement_id, client_id, line_date, description, debit_minor, credit_minor, currency, sort_index
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        stmtId,
        company.clientId,
        l.date,
        l.desc,
        l.debit || 0,
        l.credit || 0,
        opts.currency || "AED",
        i++,
      ],
    );
  }
  return stmtId;
}

async function manualJournal(
  company: TestCompany,
  period: string,
  date: string,
  memo: string,
  lines: Parameters<typeof createBooksJournal>[2]["lines"],
) {
  const created = await createBooksJournal(OMAR, company.clientId, {
    periodId: company.periods[period],
    entryDate: date,
    memo,
    voucherType: "Journal",
    lines,
    post: false,
  });
  await postBooksJournal(LAYLA, company.clientId, created.id);
  return created.id;
}

async function txnByDesc(clientId: string, desc: string) {
  const all = await listBooksBankTransactions(OMAR, clientId, { materialize: false });
  const t = all.find((x: { description: string }) => x.description === desc);
  assert.ok(t, `txn ${desc}`);
  return t!.id as string;
}

test("P2B-3: AED account — difference explained by statement-only and ledger-only items", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2b3-aed");
    const clientId = company.clientId;
    const bank = company.accountIdByCode["1120"];
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'P2B3 Bank', iban = $2, iban_last4 = '3456' WHERE id = $1`,
      [bank, IBAN_AED],
    );

    // Opening balance 1,000.00 posted before the first statement (30 Apr).
    await manualJournal(company, "Apr 2026", "2026-04-30", "Opening bank", [
      { accountId: bank, debitMinor: 100000 },
      { accountId: company.accountIdByCode["3900"], creditMinor: 100000 },
    ]);

    // Invoice 525.00 paid via the bank line (posted through C3 match).
    const customer = await createBooksParty(OMAR, clientId, {
      partyType: "customer",
      name: `P2B3 Customer ${Date.now()}`,
      trn: "100000000000031",
      force: true,
    });
    const inv = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: String(customer.id),
      issueDate: "2026-05-02",
      periodId: company.periods["May 2026"],
      documentNumber: `P2B3-INV-${Date.now()}`,
      lines: [{ description: "Svc", lineKind: "revenue", vatCode: "SR", netMinor: 50000, vatMinor: 2500 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));
    const oi = (await listBooksOpenItems(OMAR, clientId, { partyId: String(customer.id) }))[0];

    await insertStatement(admin, company, {
      accountId: bank,
      iban: IBAN_AED,
      from: "2026-05-01",
      to: "2026-05-31",
      opening: 100000,
      closing: 160000,
      lines: [
        { date: "2026-05-05", desc: "Customer receipt INV", credit: 52500 },
        { date: "2026-05-10", desc: "Monthly fee", debit: 2500 },
        { date: "2026-05-20", desc: "Cash deposit (duplicate)", credit: 10000 },
      ],
    });
    await materializeBooksBankTransactions(OMAR, clientId);
    const rcpt = await txnByDesc(clientId, "Customer receipt INV");
    await updateBooksBankTransaction(OMAR, clientId, rcpt, {
      txnType: "customer_receipt",
      categoryAccountId: company.accountIdByCode["1210"],
    });
    await markBooksBankTransactionReviewed(OMAR, clientId, rcpt);
    await matchBooksBankTransaction(OMAR, clientId, rcpt, String(oi.id));
    await postBooksBankTransaction(LAYLA, clientId, rcpt);
    await excludeBooksBankTransaction(OMAR, clientId, await txnByDesc(clientId, "Cash deposit (duplicate)"), "Duplicate line");

    // Cheque written on 25 May, not yet on the statement.
    const chequeId = await manualJournal(company, "May 2026", "2026-05-25", "Cheque 000123", [
      { accountId: company.accountIdByCode["6900"], debitMinor: 300 },
      { accountId: bank, creditMinor: 300 },
    ]);

    const may = company.periods["May 2026"];
    const r = await getBankReconciliation(OMAR, clientId, { accountId: bank, periodId: may });
    assert.equal(r.asOf, "2026-05-31");
    assert.equal(r.ledgerBalanceMinor, 152200);
    assert.equal(r.statementBalanceMinor, 160000);
    assert.equal(r.differenceMinor, 7800);
    assert.equal(r.status, "difference");
    assert.equal(r.statementOnlyCount, 2);
    assert.equal(r.statementOnlyNetMinor, 7500);
    assert.equal(r.ledgerOnlyCount, 1, "opening (before first statement) is not listed");
    assert.equal(r.ledgerOnlyNetMinor, -300);
    assert.equal(r.unexplainedMinor, 0, "every fils of the difference is explained");
    assert.deepEqual(
      r.items.map((i) => [i.kind, i.state, i.amountMinor]),
      [
        ["statement_only", "needs_review", -2500],
        ["statement_only", "excluded", 10000],
        ["ledger_only", "journal", -300],
      ],
    );

    // No statement covers 30 Apr → no_statement; never a false "reconciled".
    const apr = await getBankReconciliation(OMAR, clientId, {
      accountId: bank,
      periodId: company.periods["Apr 2026"],
    });
    assert.equal(apr.status, "no_statement");
    assert.equal(apr.differenceMinor, null);
    assert.equal(apr.ledgerBalanceMinor, 100000);

    // Reversing the cheque: reversed original + reversal both count (ledger back to 152,500).
    await reverseBooksJournal(LAYLA, clientId, chequeId, "2026-05-25");
    const afterRev = await getBankReconciliation(OMAR, clientId, { accountId: bank, periodId: may });
    assert.equal(afterRev.ledgerBalanceMinor, 152500);
    assert.equal(afterRev.differenceMinor, 7500);
    assert.equal(afterRev.ledgerOnlyCount, 2);
    assert.equal(afterRev.ledgerOnlyNetMinor, 0);
    assert.equal(afterRev.unexplainedMinor, 0);
    const banking = await listBooksBankAccounts(OMAR, clientId);
    assert.equal(banking.find((b) => b.id === bank)!.ledgerBalanceMinor, 152500, "Banking list agrees");

    // Summary for all accounts carries the same numbers, without items.
    const all = await listBankReconciliations(OMAR, clientId, { periodId: may });
    const row = all.find((x) => x.accountId === bank)!;
    assert.equal(row.differenceMinor, 7500);
    assert.equal("items" in row, false);
    for (const x of all) assert.ok(Number.isSafeInteger(x.ledgerBalanceMinor));
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2B-3: USD account compares original currency; statement running past period end", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2b3-usd");
    const clientId = company.clientId;
    const usd = company.accountIdByCode["1121"];
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'P2B3 USD', iban = $2, iban_last4 = '6789', currency = 'USD'
       WHERE id = $1`,
      [usd, IBAN_USD],
    );
    // Statement 1 May – 15 Jun; balance on 31 May = 0 + 1,000.00.
    await insertStatement(admin, company, {
      accountId: usd,
      iban: IBAN_USD,
      currency: "USD",
      from: "2026-05-01",
      to: "2026-06-15",
      opening: 0,
      closing: 150000,
      lines: [
        { date: "2026-05-20", desc: "Wire in", credit: 100000 },
        { date: "2026-06-05", desc: "Wire in 2", credit: 50000 },
      ],
    });
    // Booked by hand at 3.6725: USD 1,000.00 = AED 3,672.50.
    await manualJournal(company, "May 2026", "2026-05-20", "USD receipt", [
      {
        accountId: usd,
        debitMinor: 367250,
        currency: "USD",
        originalMinor: 100000,
        fxRateScaled: 367250000,
        aedMinor: 367250,
      },
      { accountId: company.accountIdByCode["7200"], creditMinor: 367250 },
    ]);

    const r = await getBankReconciliation(OMAR, clientId, {
      accountId: usd,
      periodId: company.periods["May 2026"],
    });
    assert.equal(r.currency, "USD");
    assert.equal(r.statementBalanceMinor, 100000, "opening + lines to 31 May, not the 15 Jun closing");
    assert.equal(r.ledgerBalanceMinor, 100000, "USD original amount, not AED 3,672.50");
    assert.equal(r.differenceMinor, 0);
    assert.equal(r.status, "reconciled");
    // The wire is both statement-only (not posted via Transactions) and ledger-only (manual JV) — they offset.
    assert.equal(r.statementOnlyNetMinor, 100000);
    assert.equal(r.ledgerOnlyNetMinor, 100000);
    assert.equal(r.unexplainedMinor, 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
