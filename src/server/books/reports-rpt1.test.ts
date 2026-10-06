/**
 * RPT-1: Day Book + AP/AR Ageing (read-only reports). Synthetic data only; every DB test uses its own
 * createTestCompany and asserts exact fils.
 */
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { ageingBucket, booksAgeing, overdueDays } from "@/server/books/ageing";
import {
  listBooksBankTransactions,
  markBooksBankTransactionReviewed,
  materializeBooksBankTransactions,
  postBooksBankTransaction,
  setBooksBankTxnAllocations,
  updateBooksBankTransaction,
} from "@/server/books/bank-transactions";
import { booksDayBook, dayBookType } from "@/server/books/day-book";
import {
  approveAndPostBooksDocument,
  createBooksDocument,
  voidBooksDocument,
} from "@/server/books/documents";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createBooksParty } from "@/server/books/parties";
import { createReceiptOrPayment } from "@/server/books/settlements";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";
import { booksEntrySource, booksLedgerReport } from "@/server/books/ledger-report";
import { booksTrialBalance } from "@/server/books/trial-balance";
import { differenceRow, tbToReportTree } from "@/lib/report-table";

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
  const ready = await admin.query(`SELECT to_regclass('books_bank_txn_allocations') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/38 not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test("RPT-1: ageing buckets at the boundaries", () => {
  assert.equal(overdueDays("2026-05-31", "2026-05-01"), 30);
  assert.equal(overdueDays("2026-05-01", "2026-05-31"), -30);
  const cases: Array<[number, string]> = [
    [-1, "not_due"],
    [-30, "not_due"],
    [0, "0-30"],
    [30, "0-30"],
    [31, "31-60"],
    [60, "31-60"],
    [61, "61-90"],
    [90, "61-90"],
    [91, "90+"],
    [400, "90+"],
  ];
  for (const [days, bucket] of cases) assert.equal(ageingBucket(days), bucket, `${days} days`);
});

test("RPT-1: Day Book type mapping", () => {
  assert.equal(dayBookType("Sales"), "Sales");
  assert.equal(dayBookType("Purchase"), "Purchase");
  assert.equal(dayBookType("Receipt"), "Receipt");
  assert.equal(dayBookType("Payment"), "Payment");
  assert.equal(dayBookType("Contra"), "Contra");
  assert.equal(dayBookType("Credit Note"), "Credit Note");
  assert.equal(dayBookType("Debit Note"), "Debit Note");
  assert.equal(dayBookType("Journal", "reversal"), "Reversal");
  assert.equal(dayBookType(null), "Journal");
  assert.equal(dayBookType("Something else"), "Journal");
});

async function party(company: TestCompany, partyType: "customer" | "supplier", name: string, trn: string) {
  const p = await createBooksParty(OMAR, company.clientId, {
    partyType,
    name: `RPT1 ${name} ${stamp()}`,
    trn,
    force: true,
  });
  return { id: String(p.id) };
}

async function postDoc(
  company: TestCompany,
  body: {
    docType: "sales_invoice" | "purchase_bill" | "credit_note";
    partyId: string;
    issueDate: string;
    dueDate?: string;
    net: number;
    vat: number;
    originalDocumentId?: string;
    period: string;
  },
) {
  const d = await createBooksDocument(OMAR, company.clientId, {
    docType: body.docType,
    partyId: body.partyId,
    issueDate: body.issueDate,
    dueDate: body.dueDate ?? null,
    periodId: company.periods[body.period],
    documentNumber: `RPT1-${stamp()}`,
    originalDocumentId: body.originalDocumentId,
    lines: [
      {
        description: "Line",
        lineKind: body.docType === "purchase_bill" ? "expense" : "revenue",
        vatCode: "SR",
        netMinor: body.net,
        vatMinor: body.vat,
      },
    ],
  });
  const posted = await approveAndPostBooksDocument(LAYLA, company.clientId, String(d.id));
  return { id: String(d.id), number: String(d.document_number ?? ""), journalEntryId: String(posted.journalEntryId) };
}

async function openItemId(admin: pg.Client, documentId: string) {
  const r = await admin.query(`SELECT id FROM books_open_items WHERE document_id = $1`, [documentId]);
  return String(r.rows[0].id);
}

/** A posted customer receipt via stream A's bank-line flow, typed entirely as on-account. */
async function onAccountReceipt(admin: pg.Client, company: TestCompany, partyId: string, amount: number, date: string) {
  const clientId = company.clientId;
  const bank = company.accountIdByCode["1120"];
  await admin.query(
    `UPDATE books_accounts SET bank_name = 'RPT1', iban = 'AE070331234567890123456' WHERE id = $1`,
    [bank],
  );
  const fileId = randomUUID();
  const stmtId = randomUUID();
  await admin.query(
    `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
     VALUES ($1,$2,$3,$4,'s.pdf','application/pdf',10,$5)`,
    [fileId, clientId, `rpt1-${randomUUID()}`, `books/${clientId}/${fileId}/s.pdf`, OMAR],
  );
  await admin.query(
    `INSERT INTO books_statement_extractions (
       id, client_id, file_id, account_id, iban, period_from, period_to,
       opening_balance_minor, closing_balance_minor, status, validation_flags
     ) VALUES ($1,$2,$3,$4,'AE070331234567890123456','2026-05-01','2026-05-31',0,$5,'ready','["balance_ok"]'::jsonb)`,
    [stmtId, clientId, fileId, bank, amount],
  );
  await admin.query(
    `INSERT INTO books_statement_lines (id, statement_id, client_id, line_date, description, credit_minor, currency, sort_index)
     VALUES ($1,$2,$3,$4,'Unreferenced transfer',$5,'AED',0)`,
    [randomUUID(), stmtId, clientId, date, amount],
  );
  await materializeBooksBankTransactions(OMAR, clientId);
  const txn = (await listBooksBankTransactions(OMAR, clientId, { materialize: false, status: "needs_review" })).find(
    (r) => r.description === "Unreferenced transfer",
  );
  assert.ok(txn);
  await updateBooksBankTransaction(OMAR, clientId, txn.id, {
    txnType: "customer_receipt",
    categoryAccountId: company.accountIdByCode["1210"],
  });
  await setBooksBankTxnAllocations(OMAR, clientId, txn.id, [
    { allocKind: "on_account", partyId, amountOriginalMinor: amount },
  ]);
  await markBooksBankTransactionReviewed(OMAR, clientId, txn.id);
  return postBooksBankTransaction(LAYLA, clientId, txn.id);
}

test("RPT-1: AR ageing as of a date — buckets, notes, partial receipt, on-account row, per-party totals", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "rpt1-ageing-ar");
    const clientId = company.clientId;
    const a = await party(company, "customer", "Alpha", "100000000000081");
    const b = await party(company, "customer", "Beta", "100000000000082");

    // Alpha: invoice due 15 Apr (46 days late on 31 May), less a 210.00 credit note.
    const invA = await postDoc(company, {
      docType: "sales_invoice", partyId: a.id, issueDate: "2026-04-01", dueDate: "2026-04-15",
      net: 100000, vat: 5000, period: "Apr 2026",
    });
    await postDoc(company, {
      docType: "credit_note", partyId: a.id, issueDate: "2026-05-10", net: 20000, vat: 1000,
      originalDocumentId: invA.id, period: "May 2026",
    });
    // Beta: 2,100.00 due 31 May (0 days) partly paid 1,000.00 on 20 May; another due 24 Jun (not due).
    const invB = await postDoc(company, {
      docType: "sales_invoice", partyId: b.id, issueDate: "2026-05-01", dueDate: "2026-05-31",
      net: 200000, vat: 10000, period: "May 2026",
    });
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt", partyId: b.id, issueDate: "2026-05-20", periodId: company.periods["May 2026"],
      bankAccountId: company.accountIdByCode["1120"], originalAmountMinor: 100000,
      allocations: [{ openItemId: await openItemId(admin, invB.id), allocatedOriginalMinor: 100000 }],
    });
    await postDoc(company, {
      docType: "sales_invoice", partyId: b.id, issueDate: "2026-05-25", dueDate: "2026-06-24",
      net: 30000, vat: 1500, period: "May 2026",
    });
    // Beta pays 300.00 with no reference — typed On account on the bank line (stream A, db/38).
    await onAccountReceipt(admin, company, b.id, 30000, "2026-05-21");
    // Not in ageing: a draft, and a voided invoice.
    await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice", partyId: a.id, issueDate: "2026-05-02", periodId: company.periods["May 2026"],
      documentNumber: `RPT1-DRAFT-${stamp()}`,
      lines: [{ description: "Draft", lineKind: "revenue", vatCode: "SR", netMinor: 999900, vatMinor: 49995 }],
    });
    const voided = await postDoc(company, {
      docType: "sales_invoice", partyId: a.id, issueDate: "2026-05-03", net: 77700, vat: 3885, period: "May 2026",
    });
    await voidBooksDocument(LAYLA, clientId, voided.id, { reason: "Duplicate" });

    const r = await booksAgeing(OMAR, clientId, { side: "AR", asOf: "2026-05-31" });
    assert.deepEqual(
      r.rows.map((x) => [x.partyId === a.id ? "A" : "B", x.kind, x.date, x.pendingMinor, x.overdueDays, x.bucket]),
      [
        ["A", "item", "2026-04-01", 84000, 46, "31-60"],
        ["B", "item", "2026-05-01", 110000, 0, "0-30"],
        ["B", "on_account", "2026-05-21", -30000, 10, "0-30"],
        ["B", "item", "2026-05-25", 31500, -24, "not_due"],
      ],
    );
    const pa = r.parties.find((p) => p.partyId === a.id)!;
    const pb = r.parties.find((p) => p.partyId === b.id)!;
    assert.equal(pa.totals.total, 84000);
    assert.equal(pa.totals["31-60"], 84000);
    assert.deepEqual([pb.totals["0-30"], pb.totals.not_due, pb.totals.total], [80000, 31500, 111500]);
    assert.deepEqual(r.totals, {
      not_due: 31500, "0-30": 80000, "31-60": 84000, "61-90": 0, "90+": 0, total: 195500,
    });

    // As of 15 May: after the 10 May credit note, before the receipt, the on-account money and the
    // later invoice — amounts are rebuilt for that date, not taken from today's open balance.
    const early = await booksAgeing(OMAR, clientId, { side: "AR", asOf: "2026-05-15" });
    assert.deepEqual(
      early.rows.map((x) => [x.partyId === a.id ? "A" : "B", x.kind, x.pendingMinor, x.overdueDays, x.bucket]),
      [
        ["A", "item", 84000, 30, "0-30"],
        ["B", "item", 210000, -16, "not_due"],
      ],
    );
    // Before anything was issued: empty, totals zero.
    const none = await booksAgeing(OMAR, clientId, { side: "AR", asOf: "2026-03-31" });
    assert.deepEqual(none.rows, []);
    assert.equal(none.totals.total, 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("RPT-1: AP ageing 90 / 91 day boundary; invalid input rejected", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "rpt1-ageing-ap");
    const clientId = company.clientId;
    const s = await party(company, "supplier", "Gamma", "100000000000083");
    await postDoc(company, {
      docType: "purchase_bill", partyId: s.id, issueDate: "2026-04-01", dueDate: "2026-04-01",
      net: 40000, vat: 2000, period: "Apr 2026",
    });
    const at90 = await booksAgeing(OMAR, clientId, { side: "AP", asOf: "2026-06-30" });
    assert.deepEqual(at90.rows.map((x) => [x.pendingMinor, x.overdueDays, x.bucket]), [[42000, 90, "61-90"]]);
    const at91 = await booksAgeing(OMAR, clientId, { side: "AP", asOf: "2026-07-01" });
    assert.deepEqual(at91.rows.map((x) => [x.pendingMinor, x.overdueDays, x.bucket]), [[42000, 91, "90+"]]);
    // AR side sees nothing of a supplier bill.
    assert.deepEqual((await booksAgeing(OMAR, clientId, { side: "AR", asOf: "2026-07-01" })).rows, []);
    await assert.rejects(booksAgeing(OMAR, clientId, { side: "XX" as "AR", asOf: "2026-07-01" }), /invalid_side/);
    await assert.rejects(booksAgeing(OMAR, clientId, { side: "AP", asOf: "31/05/2026" }), /invalid_date/);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("RPT-1: Day Book lists posted vouchers with type, particulars, side; filter by type", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "rpt1-daybook");
    const clientId = company.clientId;
    const c = await party(company, "customer", "Delta", "100000000000084");
    const s = await party(company, "supplier", "Epsilon", "100000000000085");
    const cName = (await admin.query(`SELECT name FROM books_parties WHERE id = $1`, [c.id])).rows[0].name;
    const sName = (await admin.query(`SELECT name FROM books_parties WHERE id = $1`, [s.id])).rows[0].name;

    const inv = await postDoc(company, {
      docType: "sales_invoice", partyId: c.id, issueDate: "2026-05-02", net: 100000, vat: 5000, period: "May 2026",
    });
    await postDoc(company, {
      docType: "purchase_bill", partyId: s.id, issueDate: "2026-05-03", net: 20000, vat: 1000, period: "May 2026",
    });
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt", partyId: c.id, issueDate: "2026-05-04", periodId: company.periods["May 2026"],
      bankAccountId: company.accountIdByCode["1120"], originalAmountMinor: 105000,
      allocations: [{ openItemId: await openItemId(admin, inv.id), allocatedOriginalMinor: 105000 }],
    });
    const jv = await createBooksJournal(OMAR, clientId, {
      periodId: company.periods["May 2026"], entryDate: "2026-05-05", memo: "Bank charge",
      lines: [
        { accountId: company.accountIdByCode["6900"], debitMinor: 1500 },
        { accountId: company.accountIdByCode["1120"], creditMinor: 1500 },
      ],
    });
    await postBooksJournal(LAYLA, clientId, jv.id);
    const toVoid = await postDoc(company, {
      docType: "sales_invoice", partyId: c.id, issueDate: "2026-05-06", net: 10000, vat: 500, period: "May 2026",
    });
    await voidBooksDocument(LAYLA, clientId, toVoid.id, { reason: "Wrong" });
    // Outside the range.
    await postDoc(company, {
      docType: "sales_invoice", partyId: c.id, issueDate: "2026-06-01", net: 300, vat: 15, period: "Jun 2026",
    });
    // Draft journal never appears.
    await createBooksJournal(OMAR, clientId, {
      periodId: company.periods["May 2026"], entryDate: "2026-05-07", memo: "Draft",
      lines: [
        { accountId: company.accountIdByCode["6900"], debitMinor: 999 },
        { accountId: company.accountIdByCode["1120"], creditMinor: 999 },
      ],
    });

    const book = await booksDayBook(OMAR, clientId, { from: "2026-05-01", to: "2026-05-31" });
    assert.deepEqual(
      book.rows.map((r) => [r.date, r.type, r.particulars, r.debitMinor, r.creditMinor]),
      [
        ["2026-05-02", "Sales", cName, 105000, 0],
        ["2026-05-03", "Purchase", sName, 0, 21000],
        ["2026-05-04", "Receipt", cName, 0, 105000],
        ["2026-05-05", "Journal", "Bank charges", 1500, 0],
        ["2026-05-06", "Sales", cName, 10500, 0],
        ["2026-05-06", "Reversal", cName, 0, 10500],
      ],
    );
    assert.ok(book.rows.every((r) => r.number), "every posted voucher has its number");
    assert.equal(book.rows[5].documentId, toVoid.id, "reversal drills to the voided document");
    assert.equal(book.totalDebitMinor, 117000);
    assert.equal(book.totalCreditMinor, 136500);

    const sales = await booksDayBook(OMAR, clientId, { from: "2026-05-01", to: "2026-05-31", type: "Sales" });
    assert.deepEqual(sales.rows.map((r) => [r.date, r.debitMinor]), [["2026-05-02", 105000], ["2026-05-06", 10500]]);
    assert.ok(sales.rows.every((r) => r.documentId), "sales rows link to their document");

    await assert.rejects(booksDayBook(OMAR, clientId, { from: "2026-05-31", to: "2026-05-01" }), /invalid_date_range/);
    await assert.rejects(
      booksDayBook(OMAR, clientId, { from: "2026-05-01", to: "2026-05-31", type: "Bogus" }),
      /invalid_day_book_type/,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("RPT-1: ReportTable tree from booksTrialBalance keeps every number (accounts, groups, totals)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "rpt1-tb");
    const clientId = company.clientId;
    const c = await party(company, "customer", "Zeta", "100000000000086");
    await postDoc(company, {
      docType: "sales_invoice", partyId: c.id, issueDate: "2026-04-20", net: 100000, vat: 5000, period: "Apr 2026",
    });
    await postDoc(company, {
      docType: "sales_invoice", partyId: c.id, issueDate: "2026-05-20", net: 40000, vat: 2000, period: "May 2026",
    });
    const tb = await booksTrialBalance(OMAR, clientId, company.periods["May 2026"]);
    const { rows, totals } = tbToReportTree(tb);
    for (const g of tb.groups) {
      const r = rows.find((x) => x.id === `group:${g.key}`)!;
      assert.equal(r.values.closingDebit, g.subtotalClosingDebitMinor, g.key);
      assert.equal(r.values.closingCredit, g.subtotalClosingCreditMinor, g.key);
      for (const a of g.accounts) {
        const leaf = r.children!.find((x) => x.code === a.code)!;
        assert.equal(leaf.values.openingDebit, a.openingDebitMinor);
        assert.equal(leaf.values.periodDebit, a.periodDebitMinor);
        assert.equal(leaf.values.closingDebit, a.closingDebitMinor);
        assert.equal(leaf.values.closingCredit, a.closingCreditMinor);
      }
    }
    assert.equal(totals.closingDebit, tb.totalClosingDebit);
    assert.equal(totals.closingCredit, tb.totalClosingCredit);
    // Exact figures for this company: 1210 = 1,050 + 420 debit; 4100 = 1,400 credit; 2210 = 70 credit.
    assert.equal(tb.accounts["1210"].closingDebitMinor, 147000);
    assert.equal(tb.accounts["4100"].closingCreditMinor, 140000);
    assert.equal(tb.accounts["2210"].closingCreditMinor, 7000);
    assert.equal(totals.closingDebit, 147000);
    assert.equal(differenceRow(totals.closingDebit, totals.closingCredit), null, "balanced → no Difference row");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("RPT-1: Account Ledger report — opening / current / closing equal the TB; entry → source document", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "rpt1-ledger");
    const clientId = company.clientId;
    const bank = company.accountIdByCode["1120"];
    const capital = company.accountIdByCode["3100"];
    const jv = async (period: string, date: string, amt: number) => {
      const j = await createBooksJournal(OMAR, clientId, {
        periodId: company.periods[period], entryDate: date, memo: `Capital ${date}`,
        lines: [{ accountId: bank, debitMinor: amt }, { accountId: capital, creditMinor: amt }],
      });
      await postBooksJournal(LAYLA, clientId, j.id);
      return j.id;
    };
    const aprJv = await jv("Apr 2026", "2026-04-10", 100000);
    await jv("May 2026", "2026-05-10", 50000);
    await jv("May 2026", "2026-05-20", 25000);
    await jv("Jun 2026", "2026-06-01", 7000);

    const may = company.periods["May 2026"];
    const r = await booksLedgerReport(OMAR, clientId, { periodId: may, accountId: bank });
    assert.deepEqual(r.opening, { debitMinor: 100000, creditMinor: 0, balanceMinor: 100000 });
    assert.deepEqual(
      r.lines.map((l) => [l.date, l.debitMinor, l.creditMinor, l.balanceMinor]),
      [
        ["2026-05-10", 50000, 0, 150000],
        ["2026-05-20", 25000, 0, 175000],
      ],
      "only May lines; April sits in the opening once",
    );
    assert.deepEqual(r.currentTotal, { debitMinor: 75000, creditMinor: 0 });
    assert.deepEqual(r.closing, { debitMinor: 175000, creditMinor: 0, balanceMinor: 175000 });
    const tb = await booksTrialBalance(OMAR, clientId, may);
    assert.equal(r.closing.balanceMinor, tb.accounts["1120"].closingDebitMinor - tb.accounts["1120"].closingCreditMinor);

    // Credit-normal account runs positive in its own direction.
    const cap = await booksLedgerReport(OMAR, clientId, { periodId: may, accountId: capital });
    assert.equal(cap.account.normalBalance, "credit");
    assert.deepEqual(cap.lines.map((l) => l.balanceMinor), [150000, 175000]);
    assert.equal(cap.closing.balanceMinor, tb.accounts["3100"].closingCreditMinor);

    await assert.rejects(booksLedgerReport(OMAR, clientId, { periodId: may, accountId: may }), /account_not_found/);

    // Entry → source: manual JV has none; an invoice and its void reversal both resolve to the invoice.
    assert.equal((await booksEntrySource(OMAR, clientId, aprJv)).source, null);
    const c = await party(company, "customer", "Eta", "100000000000087");
    const inv = await postDoc(company, {
      docType: "sales_invoice", partyId: c.id, issueDate: "2026-05-12", net: 10000, vat: 500, period: "May 2026",
    });
    const src = await booksEntrySource(OMAR, clientId, inv.journalEntryId);
    assert.equal(src.source?.documentId, inv.id);
    assert.equal(src.source?.docType, "sales_invoice");
    assert.equal(src.source?.grossMinor, 10500);
    assert.equal(src.source?.inboxItemId, null, "typed in, not uploaded");
    const v = await voidBooksDocument(LAYLA, clientId, inv.id, { reason: "Test" });
    assert.equal((await booksEntrySource(OMAR, clientId, v.reversalJournalId)).source?.documentId, inv.id);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
