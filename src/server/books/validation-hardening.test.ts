/**
 * Validation hardening (QA walkthrough): bad input is a 400/409 BooksError with a readable code —
 * never a raw Postgres error (HTTP 500) — plus period overlap, company-settings admin rule, users
 * list, AR/AP KPI due dates, Day Book totals / party side / Expense type, and the close drafts gate.
 * Synthetic data only; every DB test uses its own createTestCompany.
 *
 * Status mapping (route.ts fail()): code "invalid" → 400, "conflict" → 409, "forbidden" → 403,
 * "not_found" → 404; anything that is not a BooksError/LedgerError → 500. So each case below asserts
 * the error is a BooksError with the expected message and code.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { apiErrorMessage } from "@/lib/api-error";
import { createBooksAccount, listBooksUsers, updateBooksCompanyProfile } from "@/server/books/accounts";
import { getBooksCloseChecklist, waiveBooksCloseGate } from "@/server/books/close";
import { booksDayBook, DAY_BOOK_TYPES, dayBookType } from "@/server/books/day-book";
import { approveAndPostBooksDocument, createBooksDocument } from "@/server/books/documents";
import { BooksError } from "@/server/books/errors";
import { upsertBooksFxRate } from "@/server/books/fx-revaluation";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { getBooksOpenItemKpis, parseOpenItemKpiSide } from "@/server/books/open-items";
import { createBooksParty } from "@/server/books/parties";
import { createBooksPeriod } from "@/server/books/periods";
import { createReceiptOrPayment } from "@/server/books/settlements";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";
import { booksAccountLedger, booksTrialBalance } from "@/server/books/trial-balance";
import { VOUCHER_TYPES } from "@/server/books/vouchers";

const OMAR = "55555555-5555-4555-8555-555555555555"; // accountant
const LAYLA = "44444444-4444-4444-8444-444444444444"; // approver
const RAJ = "77777777-7777-4777-8777-777777777777"; // admin

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
  const ready = await admin.query(`SELECT to_regclass('books_close_waivers') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/57 close not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Rejects with a BooksError whose message matches and whose code maps to the expected status. */
async function rejectsBooks(p: Promise<unknown>, message: RegExp, code: "invalid" | "conflict" | "forbidden") {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof BooksError, `expected a BooksError (4xx), got ${String((err as Error)?.stack || err)}`);
    assert.match(err.message, message);
    assert.equal(err.code, code);
    return true;
  });
}

async function customer(company: TestCompany, name: string, paymentTermsDays?: number) {
  const p = await createBooksParty(OMAR, company.clientId, {
    partyType: "customer",
    name: `VH ${name} ${stamp()}`,
    trn: `1000000000${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`,
    paymentTermsDays,
    force: true,
  });
  return String(p.id);
}

function invoiceBody(company: TestCompany, partyId: string, number: string, issueDate = "2026-05-02") {
  return {
    docType: "sales_invoice" as const,
    partyId,
    issueDate,
    dueDate: null,
    periodId: company.periods["May 2026"],
    documentNumber: number,
    lines: [{ description: "Line", lineKind: "revenue" as const, vatCode: "SR", netMinor: 20000, vatMinor: 1000 }],
  };
}

// ---------------------------------------------------------------- 1. 500 → 400/409

test("VH-1: trial balance / account ledger refuse a non-uuid id with 400 invalid_period_id", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "vh-tb");
    await rejectsBooks(booksTrialBalance(OMAR, company.clientId, "not-a-uuid"), /^invalid_period_id$/, "invalid");
    await rejectsBooks(
      booksAccountLedger(OMAR, company.clientId, company.periods["May 2026"], "nope"),
      /^invalid_account_id$/,
      "invalid",
    );
    // A well-formed id still works.
    const tb = await booksTrialBalance(OMAR, company.clientId, company.periods["May 2026"]);
    assert.ok(tb);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("VH-1: create account — duplicate code 409, bad type 400, bad parent 400", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "vh-acct");
    assert.ok(company.accountIdByCode["6600"], "seed COA has 6600");
    await rejectsBooks(
      createBooksAccount(OMAR, company.clientId, { code: "6600", name: "Dup", accountType: "expense" }),
      /^account_code_exists$/,
      "conflict",
    );
    await rejectsBooks(
      createBooksAccount(OMAR, company.clientId, { code: "6991", name: "Fruit", accountType: "banana" }),
      /^invalid_account_type$/,
      "invalid",
    );
    await rejectsBooks(
      createBooksAccount(OMAR, company.clientId, {
        code: "6992",
        name: "Child",
        accountType: "expense",
        parentId: "not-a-uuid",
      }),
      /^invalid_parent_account$/,
      "invalid",
    );
    const ok = await createBooksAccount(OMAR, company.clientId, { code: "6993", name: "New exp", accountType: "expense" });
    assert.equal(ok.code, "6993");
    assert.equal(apiErrorMessage({ error: "account_code_exists" }), "An account with that code already exists. Use a different code.");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("VH-1: FX rate — negative, zero and malformed rates are 400 invalid_fx_rate", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "vh-fx");
    for (const rate of ["-3.6725", "0", "0.00000000", "abc", -3.6725, 0]) {
      await rejectsBooks(
        upsertBooksFxRate(OMAR, company.clientId, { currency: "USD", rateDate: "2026-05-31", rate }),
        /^invalid_fx_rate$/,
        "invalid",
      );
    }
    await rejectsBooks(
      upsertBooksFxRate(OMAR, company.clientId, { currency: "USD", rateDate: "2026-05-31", rateScaled: -1 }),
      /^invalid_fx_rate$/,
      "invalid",
    );
    await rejectsBooks(
      upsertBooksFxRate(OMAR, company.clientId, { currency: "USD", rateDate: "2026-02-30", rate: "3.6725" }),
      /^invalid_date$/,
      "invalid",
    );
    const n = await admin.query(`SELECT COUNT(*)::int AS n FROM books_fx_rates WHERE client_id = $1`, [company.clientId]);
    assert.equal(n.rows[0].n, 0, "nothing stored");
    const ok = await upsertBooksFxRate(OMAR, company.clientId, { currency: "USD", rateDate: "2026-05-31", rate: "3.6725" });
    assert.equal(ok.rateScaled, 367250000);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// ---------------------------------------------------------------- 2. duplicate document race

test("VH-2: concurrent duplicate documents — the loser gets 409 duplicate_document, not a 500", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "vh-dup");
    const partyId = await customer(company, "Dup");
    const number = `VH-DUP-${stamp()}`;
    // Double-click: two saves at once.
    const results = await Promise.allSettled([
      createBooksDocument(OMAR, company.clientId, invoiceBody(company, partyId, number)),
      createBooksDocument(OMAR, company.clientId, invoiceBody(company, partyId, number)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one draft saved");
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(lost.reason instanceof BooksError, `loser is a BooksError, got ${String(lost.reason?.stack || lost.reason)}`);
    assert.equal(lost.reason.message, "duplicate_document");
    assert.equal(lost.reason.code, "conflict");

    // Deterministic form of the same race: the pre-check is skipped (as when both requests passed it),
    // so the unique index is what stops the insert — still duplicate_document.
    await rejectsBooks(
      createBooksDocument(OMAR, company.clientId, { ...invoiceBody(company, partyId, number), forceDuplicate: true }),
      /^duplicate_document$/,
      "conflict",
    );
    const n = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_documents WHERE client_id = $1 AND document_number = $2`,
      [company.clientId, number],
    );
    assert.equal(n.rows[0].n, 1);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// ---------------------------------------------------------------- 3. periods

test("VH-3: periods — overlap refused (409 period_overlaps), bad / reversed dates 400", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "vh-per");
    await rejectsBooks(
      createBooksPeriod(OMAR, company.clientId, { label: "Jun dup", periodStart: "2026-06-15", periodEnd: "2026-07-15" }),
      /^period_overlaps:Jun 2026$/,
      "conflict",
    );
    await rejectsBooks(
      createBooksPeriod(OMAR, company.clientId, { label: "Inside", periodStart: "2026-05-10", periodEnd: "2026-05-12" }),
      /^period_overlaps:May 2026$/,
      "conflict",
    );
    await rejectsBooks(
      createBooksPeriod(OMAR, company.clientId, { label: "Backwards", periodStart: "2027-02-28", periodEnd: "2027-02-01" }),
      /^invalid_date_range$/,
      "invalid",
    );
    await rejectsBooks(
      createBooksPeriod(OMAR, company.clientId, { label: "Bad", periodStart: "2027-02-30", periodEnd: "2027-03-31" }),
      /^invalid_date$/,
      "invalid",
    );
    await rejectsBooks(
      createBooksPeriod(OMAR, company.clientId, { label: "Junk", periodStart: "soon", periodEnd: "later" }),
      /^invalid_date$/,
      "invalid",
    );
    await rejectsBooks(
      createBooksPeriod(OMAR, company.clientId, { label: "May 2026", periodStart: "2027-05-01", periodEnd: "2027-05-31" }),
      /^period_label_exists$/,
      "conflict",
    );
    const n = await admin.query(`SELECT COUNT(*)::int AS n FROM books_periods WHERE client_id = $1`, [company.clientId]);
    assert.equal(n.rows[0].n, Object.keys(company.periods).length, "no period created");

    // Adjacent (no shared day) is fine; then the same range again overlaps it.
    const jul = await createBooksPeriod(OMAR, company.clientId, {
      label: "Jul 2026",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
    assert.equal(jul.status, "OPEN");
    await rejectsBooks(
      createBooksPeriod(OMAR, company.clientId, { label: "Jul again", periodStart: "2026-07-31", periodEnd: "2026-08-31" }),
      /^period_overlaps:Jul 2026$/,
      "conflict",
    );
    assert.equal(
      apiErrorMessage({ error: "period_overlaps:Jun 2026" }),
      "Those dates overlap an existing period: Jun 2026.",
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// ---------------------------------------------------------------- 4. company settings

test("VH-4: company profile — admin only; TRN 15 digits; AED only; month 1–12 never clamped", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "vh-co");
    await admin.query(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      RAJ,
      company.clientId,
    ]);
    const before = (
      await admin.query(`SELECT trn, default_currency, fiscal_year_start_month FROM clients WHERE id = $1`, [company.clientId])
    ).rows[0];

    // Accountant (Omar) and approver (Layla) are refused, even with valid values.
    await rejectsBooks(
      updateBooksCompanyProfile(OMAR, company.clientId, { trn: "12AB", defaultCurrency: "XYZ" }),
      /^invalid_company_trn$/,
      "invalid",
    );
    await rejectsBooks(
      updateBooksCompanyProfile(OMAR, company.clientId, { fiscalYearStartMonth: 4 }),
      /^company_settings_require_admin$/,
      "forbidden",
    );
    await rejectsBooks(
      updateBooksCompanyProfile(LAYLA, company.clientId, { name: "Renamed" }),
      /^company_settings_require_admin$/,
      "forbidden",
    );

    // Admin: invalid values are errors.
    for (const trn of ["12AB", "12345678901234", "1234567890123456", "10000000000000X"]) {
      await rejectsBooks(updateBooksCompanyProfile(RAJ, company.clientId, { trn }), /^invalid_company_trn$/, "invalid");
    }
    await rejectsBooks(
      updateBooksCompanyProfile(RAJ, company.clientId, { defaultCurrency: "XYZ" }),
      /^base_currency_fixed$/,
      "invalid",
    );
    for (const c of ["aed", "AE", "AEDX", "12A"]) {
      await rejectsBooks(
        updateBooksCompanyProfile(RAJ, company.clientId, { defaultCurrency: c }),
        /^invalid_currency_code$/,
        "invalid",
      );
    }
    for (const m of [13, 0, -1, 1.5, Number.NaN]) {
      await rejectsBooks(
        updateBooksCompanyProfile(RAJ, company.clientId, { fiscalYearStartMonth: m }),
        /^invalid_fiscal_year_start_month$/,
        "invalid",
      );
    }
    const unchanged = (
      await admin.query(`SELECT trn, default_currency, fiscal_year_start_month FROM clients WHERE id = $1`, [company.clientId])
    ).rows[0];
    assert.deepEqual(unchanged, before, "nothing saved by refused requests");

    // Valid admin update; empty TRN clears it.
    const ok = await updateBooksCompanyProfile(RAJ, company.clientId, {
      trn: "100123456700003",
      defaultCurrency: "AED",
      fiscalYearStartMonth: 4,
    });
    assert.equal(ok.trn, "100123456700003");
    assert.equal(ok.fiscalYearStartMonth, 4);
    const cleared = await updateBooksCompanyProfile(RAJ, company.clientId, { trn: "" });
    assert.equal(cleared.trn, null);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// ---------------------------------------------------------------- 5. users

test("VH-5: users list shows every user of the firm (RLS-scoped), not only the caller", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "vh-users");
    const firm = await admin.query(
      `SELECT id, role FROM users WHERE firm_id = (SELECT firm_id FROM users WHERE id = $1) ORDER BY name`,
      [OMAR],
    );
    for (const caller of [OMAR, LAYLA]) {
      const list = (await listBooksUsers(caller, company.clientId)) as Array<{
        id: string;
        role: string;
        isMe: boolean;
      }>;
      assert.deepEqual(
        list.map((u) => u.id).sort(),
        firm.rows.map((r) => String(r.id)).sort(),
        "all firm users are listed",
      );
      assert.ok(list.length > 1);
      assert.deepEqual(list.filter((u) => u.isMe).map((u) => u.id), [caller]);
      for (const u of list) {
        assert.equal(u.role, firm.rows.find((r) => String(r.id) === u.id)?.role, "role shown");
      }
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// ---------------------------------------------------------------- 6. KPIs

test("VH-6: KPI side is case-insensitive; anything else is 400 invalid_side", () => {
  assert.equal(parseOpenItemKpiSide("ar"), "AR");
  assert.equal(parseOpenItemKpiSide("AR"), "AR");
  assert.equal(parseOpenItemKpiSide(" Ap "), "AP");
  for (const bad of [null, "", "receivables", "x"]) {
    assert.throws(
      () => parseOpenItemKpiSide(bad),
      (err: unknown) => err instanceof BooksError && err.message === "invalid_side" && err.code === "invalid",
    );
  }
});

test("VH-6: AR overdue KPI uses the ageing due date (issue date + party payment terms)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "vh-kpi");
    const partyId = await customer(company, "Terms", 30);
    // Issued 02/05/2026 with no due date, 30-day terms → due 01/06/2026: long overdue today.
    const d = await createBooksDocument(OMAR, company.clientId, invoiceBody(company, partyId, `VH-KPI-${stamp()}`));
    await approveAndPostBooksDocument(LAYLA, company.clientId, String(d.id));
    const kpi = await getBooksOpenItemKpis(OMAR, company.clientId, "AR");
    assert.equal(kpi.totalOutstandingAedMinor, 21000);
    assert.equal(kpi.overdueAedMinor, 21000, "overdue = ageing's overdue");
    const ap = await getBooksOpenItemKpis(OMAR, company.clientId, "AP");
    assert.equal(ap.totalOutstandingAedMinor, 0, "AR item is not counted as AP");
    await rejectsBooks(
      getBooksOpenItemKpis(OMAR, company.clientId, "AR", { partyId: "not-a-uuid" }),
      /^invalid_party_id$/,
      "invalid",
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// ---------------------------------------------------------------- 7. Day Book

test("VH-7: Day Book — totals equal, party on its own side, Expense is a type", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    assert.ok(VOUCHER_TYPES.every((v) => (DAY_BOOK_TYPES as readonly string[]).includes(v)), "every voucher type");
    assert.equal(dayBookType("Expense"), "Expense");

    const company = await createTestCompany(admin, "vh-daybook");
    const c = company.clientId;
    const partyId = await customer(company, "Receipt");
    const inv = await createBooksDocument(OMAR, c, invoiceBody(company, partyId, `VH-DB-${stamp()}`));
    await approveAndPostBooksDocument(LAYLA, c, String(inv.id));
    // Unallocated receipt: Dr bank / Cr 2320 customer advances — the customer was credited.
    await createReceiptOrPayment(OMAR, LAYLA, c, {
      docType: "receipt",
      partyId,
      issueDate: "2026-05-04",
      periodId: company.periods["May 2026"],
      bankAccountId: company.accountIdByCode["1120"],
      originalAmountMinor: 70000,
      allocations: [],
    });
    const exp = await createBooksJournal(OMAR, c, {
      periodId: company.periods["May 2026"],
      entryDate: "2026-05-05",
      memo: "Expense voucher",
      voucherType: "Expense",
      lines: [
        { accountId: company.accountIdByCode["6900"], debitMinor: 1500 },
        { accountId: company.accountIdByCode["1120"], creditMinor: 1500 },
      ],
    });
    await postBooksJournal(LAYLA, c, exp.id);
    const expType = await admin.query(`SELECT voucher_type FROM books_journal_entries WHERE id = $1`, [exp.id]);

    const book = await booksDayBook(OMAR, c, { from: "2026-05-01", to: "2026-05-31" });
    assert.equal(book.totalDebitMinor, book.totalCreditMinor, "a day book of balanced vouchers balances");
    for (const r of book.rows) {
      assert.equal(r.debitMinor, r.creditMinor, `${r.number} balances`);
      assert.equal(r.debitMinor, r.lines.reduce((s, l) => s + l.debitMinor, 0));
    }
    const receipt = book.rows.find((r) => r.type === "Receipt");
    assert.ok(receipt);
    assert.equal(receipt.partySide, "Cr", "customer credited on a receipt (advance line)");
    assert.ok(receipt.party);
    const sale = book.rows.find((r) => r.type === "Sales");
    assert.equal(sale?.partySide, "Dr");

    assert.equal(String(expType.rows[0].voucher_type), "Expense");
    const expRow = book.rows.find((r) => r.entryId === exp.id);
    assert.equal(expRow?.type, "Expense", "expense vouchers are typed Expense, not Journal");
    const only = await booksDayBook(OMAR, c, { from: "2026-05-01", to: "2026-05-31", type: "Expense" });
    assert.deepEqual(only.rows.map((r) => r.entryId), [exp.id]);
    await rejectsBooks(booksDayBook(OMAR, c, { from: "2026-02-30", to: "2026-03-31" }), /^invalid_date_range$/, "invalid");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// ---------------------------------------------------------------- 8. Close checklist

test("VH-8: close — unposted draft dated in the period fails a waivable gate; readable details; 2320 not a clearing gate", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "vh-close");
    const c = company.clientId;
    const may = company.periods["May 2026"];
    // Customer advance of 700.00 sitting in 2320 (normal liability balance).
    const adv = await createBooksJournal(OMAR, c, {
      periodId: may,
      entryDate: "2026-05-10",
      memo: "Advance received",
      lines: [
        { accountId: company.accountIdByCode["1120"], debitMinor: 70000 },
        { accountId: company.accountIdByCode["2320"], creditMinor: 70000 },
      ],
    });
    await postBooksJournal(LAYLA, c, adv.id);
    // A plain draft (not scheduled) dated 25/05.
    await createBooksJournal(OMAR, c, {
      periodId: may,
      entryDate: "2026-05-25",
      memo: "Forgotten accrual",
      lines: [
        { accountId: company.accountIdByCode["6900"], debitMinor: 999 },
        { accountId: company.accountIdByCode["1120"], creditMinor: 999 },
      ],
      post: false,
    });

    const cl = await getBooksCloseChecklist(OMAR, c, may);
    const drafts = cl.gates.find((g) => g.key === ("unposted_drafts" as typeof g.key));
    assert.ok(drafts, "drafts gate exists");
    assert.equal(drafts.status, "fail");
    assert.equal(drafts.blocking, true);
    assert.equal(drafts.count, 1);
    assert.match(drafts.detail || "", /2026-05-25/);
    assert.ok(cl.failing.includes(drafts.key));
    assert.equal(cl.gates.find((g) => g.key === "scheduled")?.status, "pass", "not double-counted");

    // Readable details: never "1120:no_statement" style codes.
    for (const g of cl.gates) {
      assert.doesNotMatch(g.detail || "", /\b\d{4}:(no_statement|difference)\b|\b\d{4}=-?\d/, `${g.key}: ${g.detail}`);
    }
    const recon = cl.gates.find((g) => g.key === "bank_recon");
    if (recon?.detail) assert.match(recon.detail, /\b1120 Bank\b[^;]* — (no statement|statement doesn.t match the ledger)/);

    const info = cl.gates.find((g) => g.key === "clearing_info");
    assert.ok(info);
    assert.doesNotMatch(info.label, /advance/i, "the label says what it checks");
    assert.match(info.label, /1220/);
    assert.match(info.label, /1130/);
    assert.doesNotMatch(info.detail || "", /2320/);

    // Waivable like the others.
    await waiveBooksCloseGate(LAYLA, c, may, "unposted_drafts", "Accrual moves to June");
    const after = await getBooksCloseChecklist(OMAR, c, may);
    assert.equal(after.gates.find((g) => g.key === ("unposted_drafts" as typeof g.key))?.status, "waived");
    assert.ok(!after.failing.includes("unposted_drafts" as (typeof after.failing)[number]));

    // Other periods are unaffected.
    const jun = await getBooksCloseChecklist(OMAR, c, company.periods["Jun 2026"]);
    assert.equal(jun.gates.find((g) => g.key === ("unposted_drafts" as typeof g.key))?.status, "pass");
  } finally {
    await admin.end().catch(() => undefined);
  }
});
