/**
 * TALLY-1: bill-wise allocation types on receipts/payments (Agst Ref / Advance / On Account),
 * mirroring what TallyPrime records on every receipt/payment line. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  approveAndPostBooksDocument,
  createBooksDocument,
  type DocLineInput,
} from "@/server/books/documents";
import { assertOpenItemsMatchRebuild, listBooksOpenItems } from "@/server/books/open-items";
import { createBooksParty } from "@/server/books/parties";
import {
  allocatePartyAdvance,
  applyPartyCredit,
  createReceiptOrPayment,
  listPartyCredits,
} from "@/server/books/settlements";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";

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
  const ready = await admin.query(`SELECT to_regclass('books_party_credits') AS t`);
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

async function makeParty(clientId: string, partyType: "customer" | "supplier", tag: string, trnSuffix: string) {
  const created = await createBooksParty(OMAR, clientId, {
    partyType,
    name: `Tally1 ${partyType} ${tag}`,
    trn: `1000000000000${trnSuffix}`,
    force: true,
  });
  assert.ok(created.id);
  return String(created.id);
}

function acct(company: TestCompany, code: string) {
  const id = company.accountIdByCode[code];
  assert.ok(id, `missing account ${code}`);
  return id;
}

/** Posted GL balance (debit − credit, AED fils) per account code for the company. */
async function glBalance(admin: pg.Client, clientId: string, code: string) {
  const r = await admin.query(
    `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::bigint AS b
     FROM books_journal_lines l
     JOIN books_journal_entries e ON e.id = l.entry_id
     JOIN books_accounts a ON a.id = l.account_id
     WHERE e.client_id = $1 AND e.status = 'posted' AND a.code = $2`,
    [clientId, code],
  );
  return Number(r.rows[0].b);
}

async function journalCodes(admin: pg.Client, entryId: string) {
  const r = await admin.query(
    `SELECT a.code, l.debit_minor, l.credit_minor FROM books_journal_lines l
     JOIN books_accounts a ON a.id = l.account_id WHERE l.entry_id = $1`,
    [entryId],
  );
  return r.rows.map((x) => ({
    code: String(x.code),
    debit: Number(x.debit_minor),
    credit: Number(x.credit_minor),
  }));
}

async function postSalesInvoice(
  clientId: string,
  periodId: string,
  partyId: string,
  documentNumber: string,
  lines: DocLineInput[],
) {
  const doc = await createBooksDocument(OMAR, clientId, {
    docType: "sales_invoice",
    partyId,
    issueDate: "2026-05-10",
    periodId,
    documentNumber,
    lines,
  });
  await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
  const items = await listBooksOpenItems(OMAR, clientId, { partyId });
  const item = items.find((x: { documentId: string }) => x.documentId === doc.id);
  assert.ok(item, "open item created");
  return { documentId: String(doc.id), openItemId: String(item!.id) };
}

async function openItem(admin: pg.Client, id: string) {
  const r = await admin.query(
    `SELECT open_original_minor, open_aed_minor, status FROM books_open_items WHERE id = $1`,
    [id],
  );
  return {
    openOriginal: Number(r.rows[0].open_original_minor),
    openAed: Number(r.rows[0].open_aed_minor),
    status: String(r.rows[0].status),
  };
}

const VAT_CODES = new Set(["2210", "1430", "2220"]);

test("TALLY-1: partial receipt leaves the bill open with the remainder (Tally INV-002: 1,525 − 1,000 = 525)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "tally1-partial");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const s = stamp();
    const customer = await makeParty(clientId, "customer", s, "01");
    // Government fee rebilled (no VAT, 1220) + service charge 500 + 5% VAT = 1,525.00
    const inv = await postSalesInvoice(clientId, periodId, customer, `INV-002-${s}`, [
      { description: "Gov fee rebill", lineKind: "disbursement", netMinor: 100000, vatMinor: 0 },
      { description: "Service charge", lineKind: "revenue", vatCode: "SR", netMinor: 50000, vatMinor: 2500 },
    ]);
    assert.equal((await openItem(admin, inv.openItemId)).openOriginal, 152500);

    const rv = await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: customer,
      issueDate: "2026-05-20",
      periodId,
      bankAccountId: acct(company, "1120"),
      originalAmountMinor: 100000,
      allocations: [{ type: "agst_ref", openItemId: inv.openItemId, allocatedOriginalMinor: 100000 }],
    });
    assert.deepEqual(rv.partyCreditIds, []);

    const oi = await openItem(admin, inv.openItemId);
    assert.equal(oi.openOriginal, 52500);
    assert.equal(oi.openAed, 52500);
    assert.equal(oi.status, "partial");

    const alloc = await admin.query(
      `SELECT allocation_type, party_credit_id, allocated_original_minor
       FROM books_allocations WHERE settlement_document_id = $1`,
      [rv.documentId],
    );
    assert.equal(alloc.rowCount, 1);
    assert.equal(alloc.rows[0].allocation_type, "agst_ref");
    assert.equal(alloc.rows[0].party_credit_id, null);
    assert.equal(Number(alloc.rows[0].allocated_original_minor), 100000);

    const lines = await journalCodes(admin, rv.journalEntryId);
    assert.ok(!lines.some((l) => VAT_CODES.has(l.code)), "receipt posts no VAT");
    assert.equal(await glBalance(admin, clientId, "1210"), 52500);

    const rebuilt = await assertOpenItemsMatchRebuild(OMAR, clientId);
    assert.deepEqual(rebuilt.mismatches, []);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("TALLY-1: on-account receipt sits in 1210 unmatched, later applied to an invoice", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "tally1-onacct");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const s = stamp();
    const customer = await makeParty(clientId, "customer", s, "02");
    const inv = await postSalesInvoice(clientId, periodId, customer, `OA-INV-${s}`, [
      { description: "Bookkeeping", lineKind: "revenue", vatCode: "SR", netMinor: 200000, vatMinor: 10000 },
    ]);

    // Customer pays 1,500.00 without saying which bill.
    const rv = await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: customer,
      issueDate: "2026-05-12",
      periodId,
      bankAccountId: acct(company, "1120"),
      originalAmountMinor: 150000,
      allocations: [{ type: "on_account", allocatedOriginalMinor: 150000 }],
    });
    assert.equal(rv.partyCreditIds.length, 1);
    const lines = await journalCodes(admin, rv.journalEntryId);
    assert.deepEqual(
      lines.map((l) => [l.code, l.debit, l.credit]).sort(),
      [
        ["1120", 150000, 0],
        ["1210", 0, 150000],
      ],
    );
    // Bill itself untouched until matched; GL 1210 already net of the payment.
    assert.equal((await openItem(admin, inv.openItemId)).openOriginal, 210000);
    assert.equal(await glBalance(admin, clientId, "1210"), 60000);

    const credits = await listPartyCredits(OMAR, clientId, { partyId: customer, openOnly: true });
    assert.equal(credits.length, 1);
    assert.equal(credits[0].creditType, "on_account");
    assert.equal(credits[0].settlementDocumentId, rv.documentId);
    assert.equal(credits[0].openOriginalMinor, 150000);
    assert.equal(credits[0].vatPolicyPending, false);

    // Dual control: preparer cannot approve their own application.
    await assert.rejects(
      applyPartyCredit(LAYLA, LAYLA, clientId, {
        partyCreditId: credits[0].id,
        openItemId: inv.openItemId,
        periodId,
        issueDate: "2026-05-21",
        amountOriginalMinor: 150000,
      }),
      /preparer_cannot_approve/,
    );

    const applied = await applyPartyCredit(OMAR, LAYLA, clientId, {
      partyCreditId: credits[0].id,
      openItemId: inv.openItemId,
      periodId,
      issueDate: "2026-05-21",
      amountOriginalMinor: 150000,
    });
    // AED → no GL movement needed, so no reclass journal.
    assert.equal(applied.journalEntryId, null);

    const oi = await openItem(admin, inv.openItemId);
    assert.equal(oi.openOriginal, 60000);
    assert.equal(oi.status, "partial");
    const after = await listPartyCredits(OMAR, clientId, { partyId: customer });
    assert.equal(after[0].openOriginalMinor, 0);
    assert.equal(after[0].status, "closed");

    const app = await admin.query(
      `SELECT allocation_type, settlement_document_id, open_item_id
       FROM books_allocations WHERE party_credit_id = $1 AND open_item_id IS NOT NULL`,
      [credits[0].id],
    );
    assert.equal(app.rowCount, 1);
    assert.equal(app.rows[0].allocation_type, "on_account");
    // Traceable to the original receipt.
    assert.equal(String(app.rows[0].settlement_document_id), rv.documentId);

    // Subledger (open items − unmatched credits) == GL 1210.
    assert.equal(await glBalance(admin, clientId, "1210"), oi.openAed);
    assert.deepEqual((await assertOpenItemsMatchRebuild(OMAR, clientId)).mismatches, []);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("TALLY-1: advance (no VAT line, flagged) applied to a later invoice in two parts", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "tally1-adv");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const s = stamp();
    const customer = await makeParty(clientId, "customer", s, "03");

    const rv = await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: customer,
      issueDate: "2026-05-05",
      periodId,
      bankAccountId: acct(company, "1120"),
      originalAmountMinor: 300000,
      allocations: [{ type: "advance", allocatedOriginalMinor: 300000 }],
    });
    const rvLines = await journalCodes(admin, rv.journalEntryId);
    // TODO(owner): VAT on customer advances undecided — assert nothing VAT-related is posted.
    assert.ok(!rvLines.some((l) => VAT_CODES.has(l.code)), "no VAT on advance");
    const vatTagged = await admin.query(
      `SELECT 1 FROM books_journal_lines
       WHERE entry_id = $1 AND (vat_code IS NOT NULL OR vat_amount_minor <> 0)`,
      [rv.journalEntryId],
    );
    assert.equal(vatTagged.rowCount, 0);
    assert.deepEqual(
      rvLines.map((l) => [l.code, l.debit, l.credit]).sort(),
      [
        ["1120", 300000, 0],
        ["2320", 0, 300000],
      ],
    );
    const [credit] = await listPartyCredits(OMAR, clientId, { partyId: customer });
    assert.equal(credit.creditType, "advance");
    assert.equal(credit.vatPolicyPending, true);

    const inv = await postSalesInvoice(clientId, periodId, customer, `ADV-INV-${s}`, [
      { description: "Annual retainer", lineKind: "revenue", vatCode: "SR", netMinor: 400000, vatMinor: 20000 },
    ]);

    const first = await applyPartyCredit(OMAR, LAYLA, clientId, {
      partyCreditId: credit.id,
      openItemId: inv.openItemId,
      periodId,
      issueDate: "2026-05-15",
      amountOriginalMinor: 100000,
    });
    assert.ok(first.journalEntryId);
    const firstLines = await journalCodes(admin, first.journalEntryId!);
    assert.deepEqual(
      firstLines.map((l) => [l.code, l.debit, l.credit]).sort(),
      [
        ["1210", 0, 100000],
        ["2320", 100000, 0],
      ],
    );
    assert.ok(!firstLines.some((l) => VAT_CODES.has(l.code)));
    let c = (await listPartyCredits(OMAR, clientId, { partyId: customer }))[0];
    assert.equal(c.openOriginalMinor, 200000);
    assert.equal(c.status, "partial");

    // Second part through the legacy entry point (FIFO over per-receipt credits).
    await allocatePartyAdvance(OMAR, LAYLA, clientId, {
      partyId: customer,
      openItemId: inv.openItemId,
      periodId,
      issueDate: "2026-05-16",
      amountOriginalMinor: 200000,
    });
    c = (await listPartyCredits(OMAR, clientId, { partyId: customer }))[0];
    assert.equal(c.openOriginalMinor, 0);
    assert.equal(c.status, "closed");
    const oi = await openItem(admin, inv.openItemId);
    assert.equal(oi.openOriginal, 120000);
    assert.equal(oi.status, "partial");

    const bal = await admin.query(
      `SELECT balance_original_minor FROM books_party_advances
       WHERE client_id = $1 AND party_id = $2 AND currency = 'AED'`,
      [clientId, customer],
    );
    assert.equal(Number(bal.rows[0].balance_original_minor), 0);

    const apps = await admin.query(
      `SELECT allocation_type FROM books_allocations
       WHERE party_credit_id = $1 AND open_item_id IS NOT NULL`,
      [credit.id],
    );
    assert.deepEqual(apps.rows.map((r) => r.allocation_type), ["advance", "advance"]);

    assert.equal(await glBalance(admin, clientId, "2320"), 0);
    assert.equal(await glBalance(admin, clientId, "1210"), 120000);
    // VAT output only from the invoice itself (5% of 4,000.00), nothing from the advance.
    assert.equal(await glBalance(admin, clientId, "2210"), -20000);
    assert.deepEqual((await assertOpenItemsMatchRebuild(OMAR, clientId)).mismatches, []);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("TALLY-1: mixed receipt (Agst Ref + Advance + On Account + remainder) and payment side reconcile with journals", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "tally1-mixed");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const s = stamp();
    const customer = await makeParty(clientId, "customer", s, "04");
    const supplier = await makeParty(clientId, "supplier", s, "05");
    const bank = acct(company, "1120");

    const inv = await postSalesInvoice(clientId, periodId, customer, `MIX-INV-${s}`, [
      { description: "Payroll service", lineKind: "revenue", vatCode: "SR", netMinor: 100000, vatMinor: 5000 },
    ]);
    // 2,000.00 received: 1,050 against the bill, 400 advance, 300 on account, 250 untyped remainder.
    const rv = await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: customer,
      issueDate: "2026-05-18",
      periodId,
      bankAccountId: bank,
      originalAmountMinor: 200000,
      allocations: [
        { openItemId: inv.openItemId, allocatedOriginalMinor: 105000 },
        { type: "advance", allocatedOriginalMinor: 40000 },
        { type: "on_account", allocatedOriginalMinor: 30000 },
      ],
    });
    assert.equal((await openItem(admin, inv.openItemId)).status, "closed");
    const perReceipt = await admin.query(
      `SELECT allocation_type, SUM(allocated_original_minor)::bigint AS amt
       FROM books_allocations WHERE settlement_document_id = $1
       GROUP BY allocation_type ORDER BY allocation_type`,
      [rv.documentId],
    );
    assert.deepEqual(
      perReceipt.rows.map((r) => [r.allocation_type, Number(r.amt)]),
      [
        ["advance", 65000], // 400 explicit + 250 remainder
        ["agst_ref", 105000],
        ["on_account", 30000],
      ],
    );
    const sumParts = perReceipt.rows.reduce((acc, r) => acc + Number(r.amt), 0);
    assert.equal(sumParts, 200000, "every fils of the receipt is typed");
    const creditsForReceipt = await admin.query(
      `SELECT credit_type, original_minor FROM books_party_credits
       WHERE settlement_document_id = $1 ORDER BY original_minor`,
      [rv.documentId],
    );
    assert.deepEqual(
      creditsForReceipt.rows.map((r) => [r.credit_type, Number(r.original_minor)]),
      [
        ["advance", 25000],
        ["on_account", 30000],
        ["advance", 40000],
      ],
    );

    // Supplier: bill 1,050; payment 1,600 = 1,050 against bill + 500 advance + 50 on account.
    const bill = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: supplier,
      issueDate: "2026-05-11",
      periodId,
      documentNumber: `MIX-BILL-${s}`,
      lines: [{ description: "Office rent", lineKind: "expense", vatCode: "SR", netMinor: 100000, vatMinor: 5000 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(bill.id));
    const billItem = (await listBooksOpenItems(OMAR, clientId, { partyId: supplier })).find(
      (x: { documentId: string }) => x.documentId === bill.id,
    );
    assert.ok(billItem);
    const py = await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "payment",
      partyId: supplier,
      issueDate: "2026-05-19",
      periodId,
      bankAccountId: bank,
      originalAmountMinor: 160000,
      allocations: [
        { openItemId: String(billItem!.id), allocatedOriginalMinor: 105000 },
        { type: "advance", allocatedOriginalMinor: 50000 },
        { type: "on_account", allocatedOriginalMinor: 5000 },
      ],
    });
    const pyLines = await journalCodes(admin, py.journalEntryId);
    assert.ok(pyLines.some((l) => l.code === "1250" && l.debit === 50000), "supplier advance → 1250");
    assert.ok(!pyLines.some((l) => VAT_CODES.has(l.code)));

    // Untyped payment remainder is still rejected (payments must be typed).
    await assert.rejects(
      createReceiptOrPayment(OMAR, LAYLA, clientId, {
        docType: "payment",
        partyId: supplier,
        issueDate: "2026-05-19",
        periodId,
        bankAccountId: bank,
        originalAmountMinor: 1000,
        allocations: [],
      }),
      /unallocated_payment_not_supported/,
    );

    // Second bill, cleared by the supplier advance.
    const bill2 = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: supplier,
      issueDate: "2026-05-25",
      periodId,
      documentNumber: `MIX-BILL2-${s}`,
      lines: [{ description: "Office rent June", lineKind: "expense", vatCode: "SR", netMinor: 40000, vatMinor: 2000 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(bill2.id));
    const bill2Item = (await listBooksOpenItems(OMAR, clientId, { partyId: supplier })).find(
      (x: { documentId: string }) => x.documentId === bill2.id,
    );
    const supAdv = (await listPartyCredits(OMAR, clientId, { partyId: supplier, creditType: "advance" }))[0];
    const supApplied = await applyPartyCredit(OMAR, LAYLA, clientId, {
      partyCreditId: supAdv.id,
      openItemId: String(bill2Item!.id),
      periodId,
      issueDate: "2026-05-26",
      amountOriginalMinor: 42000,
    });
    const supLines = await journalCodes(admin, supApplied.journalEntryId!);
    assert.deepEqual(
      supLines.map((l) => [l.code, l.debit, l.credit]).sort(),
      [
        ["1250", 0, 42000],
        ["2110", 42000, 0],
      ],
    );
    assert.equal((await openItem(admin, String(bill2Item!.id))).status, "closed");

    // Over-application is rejected.
    await assert.rejects(
      applyPartyCredit(OMAR, LAYLA, clientId, {
        partyCreditId: supAdv.id,
        openItemId: String(bill2Item!.id),
        periodId,
        issueDate: "2026-05-26",
        amountOriginalMinor: 9000,
      }),
      /credit_insufficient/,
    );

    // ---- Reconcile subledgers with the GL (integer fils everywhere) ----
    const sums = await admin.query(
      `SELECT
         (SELECT COALESCE(SUM(open_aed_minor),0) FROM books_open_items WHERE client_id = $1 AND side = 'AR')::bigint AS ar_open,
         (SELECT COALESCE(SUM(open_aed_minor),0) FROM books_open_items WHERE client_id = $1 AND side = 'AP')::bigint AS ap_open,
         (SELECT COALESCE(SUM(open_aed_minor),0) FROM books_party_credits WHERE client_id = $1 AND side = 'AR' AND credit_type = 'on_account')::bigint AS ar_oa,
         (SELECT COALESCE(SUM(open_aed_minor),0) FROM books_party_credits WHERE client_id = $1 AND side = 'AR' AND credit_type = 'advance')::bigint AS ar_adv,
         (SELECT COALESCE(SUM(open_aed_minor),0) FROM books_party_credits WHERE client_id = $1 AND side = 'AP' AND credit_type = 'on_account')::bigint AS ap_oa,
         (SELECT COALESCE(SUM(open_aed_minor),0) FROM books_party_credits WHERE client_id = $1 AND side = 'AP' AND credit_type = 'advance')::bigint AS ap_adv`,
      [clientId],
    );
    const r = sums.rows[0];
    for (const v of Object.values(r)) assert.ok(Number.isSafeInteger(Number(v)) && String(v) === String(Number(v)));
    assert.equal(await glBalance(admin, clientId, "1210"), Number(r.ar_open) - Number(r.ar_oa));
    assert.equal(await glBalance(admin, clientId, "2320"), -Number(r.ar_adv));
    assert.equal(await glBalance(admin, clientId, "2110"), -(Number(r.ap_open) - Number(r.ap_oa)));
    assert.equal(await glBalance(admin, clientId, "1250"), Number(r.ap_adv));
    assert.equal(Number(r.ar_adv), 65000);
    assert.equal(Number(r.ap_adv), 8000);
    assert.equal(await glBalance(admin, clientId, "1120"), 200000 - 160000);

    // All allocation money columns are whole fils.
    const nonInt = await admin.query(
      `SELECT pg_typeof(allocated_original_minor)::text AS t FROM books_allocations WHERE client_id = $1 LIMIT 1`,
      [clientId],
    );
    assert.equal(nonInt.rows[0].t, "bigint");
    assert.deepEqual((await assertOpenItemsMatchRebuild(OMAR, clientId)).mismatches, []);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("TALLY-1: input validation — typed parts need/forbid open items; fractional fils rejected", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "tally1-validate");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const s = stamp();
    const customer = await makeParty(clientId, "customer", s, "06");
    const inv = await postSalesInvoice(clientId, periodId, customer, `VAL-INV-${s}`, [
      { description: "Svc", lineKind: "revenue", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
    ]);
    const base = {
      docType: "receipt" as const,
      partyId: customer,
      issueDate: "2026-05-20",
      periodId,
      bankAccountId: acct(company, "1120"),
      originalAmountMinor: 10000,
    };
    await assert.rejects(
      createReceiptOrPayment(OMAR, LAYLA, clientId, {
        ...base,
        allocations: [{ type: "agst_ref", allocatedOriginalMinor: 10000 }],
      }),
      /open_item_required/,
    );
    await assert.rejects(
      createReceiptOrPayment(OMAR, LAYLA, clientId, {
        ...base,
        allocations: [{ type: "advance", openItemId: inv.openItemId, allocatedOriginalMinor: 10000 }],
      }),
      /allocation_type_takes_no_open_item/,
    );
    await assert.rejects(
      createReceiptOrPayment(OMAR, LAYLA, clientId, {
        ...base,
        allocations: [{ type: "on_account", allocatedOriginalMinor: 100.5 }],
      }),
      /invalid_allocation_amount/,
    );
    await assert.rejects(
      createReceiptOrPayment(OMAR, LAYLA, clientId, {
        ...base,
        allocations: [{ type: "bogus" as never, allocatedOriginalMinor: 100 }],
      }),
      /invalid_allocation_type/,
    );
    await assert.rejects(
      createReceiptOrPayment(OMAR, LAYLA, clientId, {
        ...base,
        allocations: [
          { type: "advance", allocatedOriginalMinor: 6000 },
          { type: "on_account", allocatedOriginalMinor: 6000 },
        ],
      }),
      /allocations_exceed_payment/,
    );
    // Nothing was written by the rejected attempts.
    const n = await admin.query(`SELECT COUNT(*)::int AS n FROM books_party_credits WHERE client_id = $1`, [
      clientId,
    ]);
    assert.equal(n.rows[0].n, 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
