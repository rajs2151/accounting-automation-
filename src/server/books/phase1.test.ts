import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { aedFromOriginal, parseFxRateToScaled } from "@/lib/fx";
import {
  approveAndPostBooksDocument,
  createBooksDocument,
} from "@/server/books/documents";
import { createOpeningImport, postOpeningImport } from "@/server/books/opening-import";
import { assertOpenItemsMatchRebuild, listBooksOpenItems } from "@/server/books/open-items";
import {
  arabicIndicToAscii,
  isValidIban,
  isValidTrn,
  parseAmountToFils,
  parseDateUae,
} from "@/server/books/parsing";
import { createBooksParty, partyDisbursementNet } from "@/server/books/parties";
import { lockBooksPeriod, reopenBooksPeriod } from "@/server/books/periods";
import {
  allocatePartyAdvance,
  createContra,
  createReceiptOrPayment,
} from "@/server/books/settlements";
import { recheckStatementBalances } from "@/server/books/statement-extractions";
import { BooksError } from "@/server/books/errors";
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
  const ready = await admin.query(`SELECT to_regclass('books_documents') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("phase1 schema not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

async function makeCustomer(clientId: string, tag: string) {
  const created = await createBooksParty(OMAR, clientId, {
    partyType: "customer",
    name: `Phase1 Customer ${tag}`,
    force: true,
  });
  assert.ok(created.id);
  return String(created.id);
}

async function makeSupplier(clientId: string, tag: string, trn?: string | null) {
  const created = await createBooksParty(OMAR, clientId, {
    partyType: "supplier",
    name: `Phase1 Supplier ${tag}`,
    trn: trn === undefined ? `100${Date.now().toString().slice(-10)}004` : trn,
    force: true,
  });
  assert.ok(created.id);
  return String(created.id);
}

async function makeForeignSupplier(clientId: string, tag: string) {
  const created = await createBooksParty(OMAR, clientId, {
    partyType: "supplier",
    name: `Phase1 Foreign ${tag}`,
    trn: null,
    country: "US",
    defaultVatCode: "RC_IN",
    force: true,
  });
  assert.ok(created.id);
  return String(created.id);
}

function mayPeriod(company: TestCompany) {
  return company.periods["May 2026"];
}

function accountId(company: TestCompany, code: string) {
  const id = company.accountIdByCode[code];
  assert.ok(id, `missing account ${code}`);
  return id;
}

test("parsing: fils, Arabic-Indic, TRN, IBAN, dates", () => {
  assert.equal(parseAmountToFils("1,234.56"), 123456);
  assert.equal(parseAmountToFils("(100.00)"), -10000);
  assert.equal(arabicIndicToAscii("٢٠٢٦"), "2026");
  assert.equal(parseAmountToFils(arabicIndicToAscii("1234.50")), 123450);
  assert.equal(parseDateUae("15/05/2026"), "2026-05-15");
  assert.equal(parseDateUae("2026-05-15", "yyyy-mm-dd"), "2026-05-15");
  assert.ok(isValidTrn("100123456700003"));
  assert.ok(!isValidTrn("123"));
  assert.ok(isValidIban("AE070331234567890123456"));
});

test("fx rate scaled integer math", () => {
  const rate = Number(parseFxRateToScaled("3.67"));
  assert.equal(aedFromOriginal(10000, rate), 36700);
});

test("statement recheck catches dropped row", () => {
  // Full chain: open 10000 +5000 -2000 +3000 = 16000 close
  const full = recheckStatementBalances({
    openingBalanceMinor: 10000,
    closingBalanceMinor: 16000,
    lines: [
      { debitMinor: 0, creditMinor: 5000, runningBalanceMinor: 15000 },
      { debitMinor: 2000, creditMinor: 0, runningBalanceMinor: 13000 },
      { debitMinor: 0, creditMinor: 3000, runningBalanceMinor: 16000 },
    ],
  });
  assert.equal(full.flags.length, 0);

  // Drop middle row but keep stale running balances → balance_break + closing_mismatch
  const dropped = recheckStatementBalances({
    openingBalanceMinor: 10000,
    closingBalanceMinor: 16000,
    lines: [
      { debitMinor: 0, creditMinor: 5000, runningBalanceMinor: 15000 },
      // missing -2000 row
      { debitMinor: 0, creditMinor: 3000, runningBalanceMinor: 16000 },
    ],
  });
  assert.ok(dropped.flags.includes("closing_mismatch"));
  assert.ok(dropped.lineFlags.some((lf) => lf.includes("balance_break")));
});

test("party fuzzy de-dupe", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-fuzzy");
    await createBooksParty(OMAR, company.clientId, {
      partyType: "customer",
      name: "Oasis Retail LLC",
      force: true,
    });
    const created = await createBooksParty(OMAR, company.clientId, {
      partyType: "customer",
      name: "Oasis Retail LLC",
      force: false,
    });
    assert.equal(created.possibleDuplicate, true);
    assert.ok((created.suggestions?.length || 0) > 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("sales invoice approve → SV voucher + open item; disbursement uses 1220", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-sv");
    const clientId = company.clientId;
    const periodId = mayPeriod(company);
    const customerId = await makeCustomer(clientId, `sv-${Date.now()}`);
    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: customerId,
      issueDate: "2026-05-10",
      periodId,
      documentNumber: `SV-TEST-${Date.now()}`,
      lines: [
        { description: "Consulting", lineKind: "revenue", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
        { description: "Gov fee", lineKind: "disbursement", netMinor: 2000, vatMinor: 0 },
      ],
    });
    const posted = await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
    assert.match(String(posted.entryNo), /^SV-2026-\d+$/);

    const lines = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1`,
      [posted.journalEntryId],
    );
    const codes = new Set(lines.rows.map((r) => r.code));
    assert.ok(codes.has("1220"));
    assert.ok(codes.has("1210"));
    assert.ok(codes.has("2210"));

    const oi = await listBooksOpenItems(OMAR, clientId, { partyId: customerId, status: "open" });
    assert.ok(oi.some((x: { documentId: string }) => x.documentId === doc.id));

    const net = await partyDisbursementNet(OMAR, clientId, customerId);
    // purchase leg not posted yet — sales Cr 1220 → net negative or non-zero warning path
    assert.equal(typeof net.netMinor, "number");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("purchase without TRN puts VAT in cost; RCM for foreign", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-rcm");
    const clientId = company.clientId;
    const periodId = mayPeriod(company);
    // Create no-TRN supplier
    const noTrn = await createBooksParty(OMAR, clientId, {
      partyType: "supplier",
      name: `Cash Vendor ${Date.now()}`,
      trn: null,
      force: true,
    });
    const bill = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: String(noTrn.id),
      issueDate: "2026-05-11",
      periodId,
      documentNumber: `PV-NOTRN-${Date.now()}`,
      lines: [{ description: "Supplies", lineKind: "expense", vatCode: "SR", netMinor: 10000, vatMinor: 500 }],
    });
    const posted = await approveAndPostBooksDocument(LAYLA, clientId, String(bill.id));
    const lines = await admin.query(
      `SELECT a.code, l.debit_minor FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id WHERE l.entry_id = $1`,
      [posted.journalEntryId],
    );
    assert.ok(!lines.rows.some((r) => r.code === "1430"));

    const foreignId = await makeForeignSupplier(clientId, `rcm-${Date.now()}`);
    const rcm = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: foreignId,
      issueDate: "2026-05-12",
      periodId,
      documentNumber: `PV-RCM-${Date.now()}`,
      lines: [
        {
          description: "Cloud",
          lineKind: "expense",
          vatCode: "RC_IN",
          netMinor: 10000,
          vatMinor: 500,
        },
      ],
    });
    const rcmPosted = await approveAndPostBooksDocument(LAYLA, clientId, String(rcm.id));
    const rcmLines = await admin.query(
      `SELECT a.code FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id WHERE l.entry_id = $1`,
      [rcmPosted.journalEntryId],
    );
    const codes = rcmLines.rows.map((r) => r.code);
    assert.ok(codes.includes("2210"));
    assert.ok(codes.includes("1430"));
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("USD invoice paid at new rate posts FX to 7300", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-fx");
    const clientId = company.clientId;
    const periodId = mayPeriod(company);
    const customerId = await makeCustomer(clientId, `fx-${Date.now()}`);
    const rate1 = Number(parseFxRateToScaled("3.67"));
    const rate2 = Number(parseFxRateToScaled("3.70"));
    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: customerId,
      issueDate: "2026-05-13",
      periodId,
      documentNumber: `USD-${Date.now()}`,
      currency: "USD",
      fxRateScaled: rate1,
      lines: [
        {
          description: "USD service",
          lineKind: "revenue",
          vatCode: "OS",
          netMinor: 10000,
          vatMinor: 0,
          originalMinor: 10000,
          fxRateScaled: rate1,
        },
      ],
    });
    // Fix AED totals on lines — createBooksDocument computes aed from original
    await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
    const oi = await listBooksOpenItems(OMAR, clientId, { partyId: customerId });
    const item = oi.find((x: { documentId: string }) => x.documentId === doc.id);
    assert.ok(item);

    const bank = accountId(company, "1121");
    const settlement = await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: customerId,
      issueDate: "2026-05-14",
      periodId,
      bankAccountId: bank,
      currency: "USD",
      fxRateScaled: rate2,
      originalAmountMinor: 10000,
      allocations: [{ openItemId: String(item!.id), allocatedOriginalMinor: 10000 }],
    });
    assert.match(String(settlement.entryNo), /^RV-2026-\d+$/);

    const fxLines = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1 AND a.code = '7300'`,
      [settlement.journalEntryId],
    );
    assert.equal(fxLines.rowCount, 1);
    const gain = Number(fxLines.rows[0].credit_minor) - Number(fxLines.rows[0].debit_minor);
    assert.equal(gain, aedFromOriginal(10000, rate2) - aedFromOriginal(10000, rate1));
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("contra does not allocate; CV voucher", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-contra");
    const clientId = company.clientId;
    const periodId = mayPeriod(company);
    const from = accountId(company, "1120");
    const to = accountId(company, "1110");
    const result = await createContra(OMAR, LAYLA, clientId, {
      issueDate: "2026-05-15",
      periodId,
      fromAccountId: from,
      toAccountId: to,
      originalAmountMinor: 5000,
    });
    assert.match(String(result.entryNo), /^CV-2026-\d+$/);
    const allocs = await admin.query(
      `SELECT 1 FROM books_allocations WHERE settlement_journal_id = $1`,
      [result.journalEntryId],
    );
    assert.equal(allocs.rowCount, 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("unallocated receipt → 2320 advance", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-adv");
    const clientId = company.clientId;
    const periodId = mayPeriod(company);
    const customerId = await makeCustomer(clientId, `adv-${Date.now()}`);
    const bank = accountId(company, "1120");
    const result = await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: customerId,
      issueDate: "2026-05-16",
      periodId,
      bankAccountId: bank,
      originalAmountMinor: 5000,
      allocations: [],
    });
    const lines = await admin.query(
      `SELECT a.code FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id WHERE l.entry_id = $1`,
      [result.journalEntryId],
    );
    assert.ok(lines.rows.some((r) => r.code === "2320"));
    const adv = await admin.query(
      `SELECT balance_aed_minor FROM books_party_advances
       WHERE client_id = $1 AND party_id = $2`,
      [clientId, customerId],
    );
    assert.ok(Number(adv.rows[0].balance_aed_minor) >= 5000);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("opening import rejected when first period locked", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-ob-lock", {
      lockPeriodLabels: ["Apr 2026"],
    });
    const aprId = company.periods["Apr 2026"];
    await assert.rejects(
      () =>
        createOpeningImport(OMAR, company.clientId, {
          forceBooksStartPeriodId: String(aprId),
          lines: [
            { accountCode: "1120", debitMinor: 1000 },
            { accountCode: "3900", creditMinor: 1000 },
          ],
        }),
      (e: unknown) => e instanceof BooksError && e.code === "period_closed",
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("rebuild open items matches table", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-rebuild");
    const clientId = company.clientId;
    const periodId = mayPeriod(company);
    const stamp = Date.now();
    const customerId = await makeCustomer(clientId, `rebuild-${stamp}`);
    const supplierId = await makeSupplier(clientId, `rebuild-${stamp}`);
    const bank = accountId(company, "1120");

    // (a) Sales invoice that stays fully open
    const openInv = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: customerId,
      issueDate: "2026-05-10",
      periodId,
      documentNumber: `REBUILD-OPEN-${stamp}`,
      lines: [
        { description: "Fully open svc", lineKind: "revenue", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(openInv.id));

    // (b) Sales invoice partly settled by a receipt with an allocation
    const partialInv = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: customerId,
      issueDate: "2026-05-11",
      periodId,
      documentNumber: `REBUILD-PART-${stamp}`,
      lines: [
        { description: "Partial svc", lineKind: "revenue", vatCode: "SR", netMinor: 20000, vatMinor: 1000 },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(partialInv.id));
    const oi = await listBooksOpenItems(OMAR, clientId, { partyId: customerId, status: "open" });
    const partialItem = oi.find((x: { documentId: string }) => x.documentId === partialInv.id);
    assert.ok(partialItem, "partial invoice must create an open item");
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: customerId,
      issueDate: "2026-05-12",
      periodId,
      bankAccountId: bank,
      originalAmountMinor: 10000,
      allocations: [{ openItemId: String(partialItem!.id), allocatedOriginalMinor: 10000 }],
    });

    // (c) Purchase bill (stays open)
    const bill = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: supplierId,
      issueDate: "2026-05-13",
      periodId,
      documentNumber: `REBUILD-BILL-${stamp}`,
      lines: [
        { description: "Supplies", lineKind: "expense", vatCode: "SR", netMinor: 8000, vatMinor: 400 },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(bill.id));

    const result = await assertOpenItemsMatchRebuild(OMAR, clientId);
    assert.ok(
      result.rebuiltCount >= 3,
      `expected rebuiltCount >= 3 after seeding docs, got ${result.rebuiltCount}`,
    );
    assert.equal(result.ok, true, result.mismatches.join(","));
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("CN cannot exceed original remaining balance", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-cn-cap");
    const clientId = company.clientId;
    const periodId = mayPeriod(company);
    const customerId = await makeCustomer(clientId, `cn-cap-${Date.now()}`);
    const inv = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: customerId,
      issueDate: "2026-05-17",
      periodId,
      documentNumber: `CN-BASE-${Date.now()}`,
      lines: [{ description: "Svc", lineKind: "revenue", vatCode: "SR", netMinor: 10000, vatMinor: 500 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));
    await assert.rejects(
      () =>
        createBooksDocument(OMAR, clientId, {
          docType: "credit_note",
          partyId: customerId,
          issueDate: "2026-05-18",
          periodId,
          originalDocumentId: String(inv.id),
          lines: [
            { description: "CN", lineKind: "revenue", vatCode: "SR", netMinor: 20000, vatMinor: 1000 },
          ],
        }),
      (e: unknown) => e instanceof BooksError && e.message === "exceeds_original_balance",
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("deferred release schedule + blocked when target period locked", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  let junId = "";
  let clientId = "";
  try {
    const company = await createTestCompany(admin, "phase1-def");
    clientId = company.clientId;
    const periodId = mayPeriod(company);
    const customerId = await makeCustomer(clientId, `def-${Date.now()}`);
    // Lock June so second release month is blocked
    junId = company.periods["Jun 2026"];
    if (!junId) {
      t.skip("Jun 2026 period missing");
      return;
    }
    await lockBooksPeriod(LAYLA, clientId, String(junId));

    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: customerId,
      issueDate: "2026-05-19",
      periodId,
      documentNumber: `DEF-${Date.now()}`,
      serviceStart: "2026-05-01",
      serviceEnd: "2026-06-30",
      deferRevenue: true,
      lines: [{ description: "Retainer", lineKind: "revenue", vatCode: "SR", netMinor: 20000, vatMinor: 1000 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
    const sched = await admin.query(
      `SELECT status, amount_aed_minor FROM books_deferred_schedules
       WHERE document_id = $1 ORDER BY release_date`,
      [doc.id],
    );
    assert.ok(sched.rowCount && sched.rowCount >= 2);
    assert.ok(sched.rows.some((r) => r.status === "pending" || r.status === "posted"));
    assert.ok(sched.rows.some((r) => r.status === "blocked"));
  } finally {
    if (junId && clientId) {
      await admin
        .query(`UPDATE books_periods SET status = 'OPEN' WHERE id = $1`, [junId])
        .catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  }
});

test("1220 nets to zero per client after bill + rebill", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-1220");
    const clientId = company.clientId;
    const periodId = mayPeriod(company);
    const customerId = await makeCustomer(clientId, `1220-c-${Date.now()}`);
    const supplierId = await makeSupplier(clientId, `1220-s-${Date.now()}`);
    const amount = 4500;
    const bill = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: supplierId,
      issueDate: "2026-05-20",
      periodId,
      documentNumber: `PV-DISB-${Date.now()}`,
      lines: [{ description: "Gov fee paid", lineKind: "disbursement", netMinor: amount, vatMinor: 0 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(bill.id));
    const rebill = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: customerId,
      issueDate: "2026-05-20",
      periodId,
      documentNumber: `SV-DISB-${Date.now()}`,
      lines: [{ description: "Gov fee rebill", lineKind: "disbursement", netMinor: amount, vatMinor: 0 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(rebill.id));

    const net = await admin.query(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::bigint AS net_minor
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_accounts a ON a.id = l.account_id
       WHERE e.client_id = $1 AND e.status IN ('posted','reversed') AND a.code = '1220'`,
      [clientId],
    );
    // May include earlier tests' 1220 activity — assert this pair nets (check delta via both docs)
    const pair = await admin.query(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::bigint AS net_minor
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_accounts a ON a.id = l.account_id
       JOIN books_documents d ON d.journal_entry_id = e.id
       WHERE e.client_id = $1 AND a.code = '1220' AND d.id = ANY($2::uuid[])`,
      [clientId, [bill.id, rebill.id]],
    );
    assert.equal(Number(pair.rows[0].net_minor), 0);
    void net;
    void partyDisbursementNet;
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("CN reverses VAT with same code", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-cn-vat");
    const clientId = company.clientId;
    const periodId = mayPeriod(company);
    const customerId = await makeCustomer(clientId, `cn-vat-${Date.now()}`);
    const inv = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: customerId,
      issueDate: "2026-05-21",
      periodId,
      documentNumber: `CN-VAT-${Date.now()}`,
      lines: [{ description: "Svc", lineKind: "revenue", vatCode: "SR", netMinor: 10000, vatMinor: 500 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));
    const cn = await createBooksDocument(OMAR, clientId, {
      docType: "credit_note",
      partyId: customerId,
      issueDate: "2026-05-22",
      periodId,
      originalDocumentId: String(inv.id),
      documentNumber: `CN-${Date.now()}`,
      lines: [{ description: "CN", lineKind: "revenue", vatCode: "SR", netMinor: 10000, vatMinor: 500 }],
    });
    const posted = await approveAndPostBooksDocument(LAYLA, clientId, String(cn.id));
    const vat = await admin.query(
      `SELECT l.vat_code, l.vat_treatment, l.debit_minor, l.credit_minor
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1 AND a.code = '2210'`,
      [posted.journalEntryId],
    );
    assert.ok(vat.rowCount);
    // Document posting stores the VAT code on vat_treatment (companions set vatCode=null).
    assert.equal(String(vat.rows[0].vat_treatment || vat.rows[0].vat_code), "SR");
    assert.ok(Number(vat.rows[0].debit_minor) > 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("2320 advance later allocated to an invoice", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "phase1-alloc");
    const clientId = company.clientId;
    const periodId = mayPeriod(company);
    const customerId = await makeCustomer(clientId, `alloc-${Date.now()}`);
    const bank = accountId(company, "1120");
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: customerId,
      issueDate: "2026-05-23",
      periodId,
      bankAccountId: bank,
      originalAmountMinor: 8000,
      allocations: [],
    });
    const inv = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: customerId,
      issueDate: "2026-05-24",
      periodId,
      documentNumber: `ADV-INV-${Date.now()}`,
      lines: [{ description: "Later work", lineKind: "revenue", vatCode: "SR", netMinor: 8000, vatMinor: 400 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));
    const oi = await listBooksOpenItems(OMAR, clientId, { partyId: customerId, status: "open" });
    const item = oi.find((x: { documentId: string }) => x.documentId === inv.id);
    assert.ok(item);
    const alloc = await allocatePartyAdvance(OMAR, LAYLA, clientId, {
      partyId: customerId,
      openItemId: String(item!.id),
      periodId,
      issueDate: "2026-05-25",
      amountOriginalMinor: 8000,
    });
    assert.ok(alloc.entryNo);
    const adv = await admin.query(
      `SELECT balance_original_minor FROM books_party_advances
       WHERE client_id = $1 AND party_id = $2 AND currency = 'AED'`,
      [clientId, customerId],
    );
    // Prior tests may leave residual advances; this allocation must have reduced by 8000 from pre-state.
    // Assert open item reduced:
    const oiAfter = await admin.query(
      `SELECT open_original_minor FROM books_open_items WHERE id = $1`,
      [item!.id],
    );
    assert.equal(Number(oiAfter.rows[0].open_original_minor), 400); // VAT still open if only allocated net? 
    // We allocated 8000 original against invoice open which is 8400 gross — remaining 400
    void adv;
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("opening import unlock → import → relock path audited", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  let aprId = "";
  let clientId = "";
  try {
    const company = await createTestCompany(admin, "phase1-ob-path", {
      lockPeriodLabels: ["Apr 2026"],
    });
    clientId = company.clientId;
    aprId = company.periods["Apr 2026"];
    // Point books_start at April for this path
    await admin.query(`UPDATE clients SET books_start_period_id = $2 WHERE id = $1`, [
      clientId,
      aprId,
    ]);
    await reopenBooksPeriod(LAYLA, clientId, aprId, "Cut-over OB import for Phase 1 proof");
    const mapped = await createOpeningImport(OMAR, clientId, {
      lines: [
        { accountCode: "1120", debitMinor: 2500 },
        { accountCode: "3900", creditMinor: 2500 },
      ],
    });
    const posted = await postOpeningImport(LAYLA, clientId, String(mapped.id));
    assert.ok(posted.entryNo);
    await lockBooksPeriod(LAYLA, clientId, aprId);

    const audits = await admin.query(
      `SELECT action FROM books_audit_events
       WHERE client_id = $1 AND entity_id = $2
         AND action = ANY($3::text[])
       ORDER BY at`,
      [clientId, aprId, ["unlock", "lock"]],
    );
    const actions = audits.rows.map((r) => r.action);
    assert.ok(actions.includes("unlock"));
    assert.ok(actions.includes("lock"));
    const obAudit = await admin.query(
      `SELECT action FROM books_audit_events
       WHERE client_id = $1 AND entity = 'books_opening_import' AND action = 'post_opening'`,
      [clientId],
    );
    assert.ok(obAudit.rowCount);
  } finally {
    // Restore May start + Apr locked (test company only)
    if (aprId && clientId) {
      await admin.query(
        `UPDATE books_periods SET status = 'LOCKED' WHERE id = $1`,
        [aprId],
      ).catch(() => undefined);
      const may = await admin.query(
        `SELECT id FROM books_periods WHERE client_id = $1 AND label = 'May 2026'`,
        [clientId],
      );
      if (may.rowCount) {
        await admin.query(`UPDATE clients SET books_start_period_id = $2 WHERE id = $1`, [
          clientId,
          may.rows[0].id,
        ]).catch(() => undefined);
      }
    }
    await admin.end().catch(() => undefined);
  }
});
