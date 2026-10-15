/**
 * P2B-6 / P2B-7: VAT 201 box mapping and draft return. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { setCompanyVatSettings } from "@/server/books/company-vat-settings";
import {
  approveAndPostBooksDocument,
  createBooksDocument,
  voidBooksDocument,
  type DocLineInput,
} from "@/server/books/documents";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createBooksParty } from "@/server/books/parties";
import { reapplyPlaceOfSupplyRule } from "@/server/books/place-of-supply";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";
import {
  generateVat201Draft,
  VatReturnBlockedError,
  vat201Box,
  type VatBoxMapRow,
} from "@/server/books/vat201";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const RAJ = "77777777-7777-4777-8777-777777777777";

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
  const ready = await admin.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'books_vat_codes' AND column_name = 'vat201_output_box'`,
  );
  if (!ready.rowCount) {
    t.skip("db/54 not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("P2B-6: VAT 201 box map by direction (db/54)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const rows = await admin.query(
      `SELECT code, vat201_output_box AS "vat201OutputBox", vat201_input_box AS "vat201InputBox", vat201_box
       FROM books_vat_codes ORDER BY code`,
    );
    const map = new Map<string, VatBoxMapRow>(rows.rows.map((r) => [String(r.code), r as VatBoxMapRow]));
    const got = Object.fromEntries(
      rows.rows.map((r) => [r.code, [r.vat201OutputBox ?? null, r.vat201InputBox ?? null]]),
    );
    assert.deepEqual(got, {
      EX: ["5", null],
      NR: [null, null],
      OS: [null, null],
      RC_IN: [null, "10"],
      RC_OUT: ["3", null],
      SR: ["1", "9"],
      ZR: ["4", null],
    });
    const legacy = Object.fromEntries(rows.rows.map((r) => [r.code, r.vat201_box]));
    assert.equal(legacy.ZR, "4");
    assert.equal(legacy.EX, "5");

    // Sales SR goes to the emirate's sub-box; without an emirate it cannot be placed.
    assert.deepEqual(vat201Box(map, "SR", "output", "Dubai"), { box: "1b", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "SR", "output", "Fujairah"), { box: "1g", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "SR", "output", null), { box: null, needsEmirate: true });
    assert.deepEqual(vat201Box(map, "SR", "output", "OUTSIDE_UAE"), { box: null, needsEmirate: true });
    assert.deepEqual(vat201Box(map, "SR", "input"), { box: "9", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "ZR", "output"), { box: "4", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "EX", "output"), { box: "5", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "RC_OUT", "output"), { box: "3", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "RC_IN", "input"), { box: "10", needsEmirate: false });
    assert.deepEqual(vat201Box(map, "NR", "input"), { box: null, needsEmirate: false });
    assert.deepEqual(vat201Box(map, "OS", "output"), { box: null, needsEmirate: false });
    assert.deepEqual(vat201Box(map, null, "output"), { box: null, needsEmirate: false });
  } finally {
    await admin.end().catch(() => undefined);
  }
});

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setup(admin: pg.Client, label: string, emirate: string | null) {
  const company = await createTestCompany(admin, label);
  await admin.query(
    `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [RAJ, company.clientId],
  );
  await setCompanyVatSettings(RAJ, company.clientId, {
    establishmentEmirate: emirate,
    vatReturnFrequency: "quarterly",
    vatPeriodEndMonth: 6,
  });
  return company;
}

async function party(
  company: TestCompany,
  partyType: "customer" | "supplier",
  opts: { emirate?: string | null; trn?: string | null; country?: string },
) {
  const p = await createBooksParty(OMAR, company.clientId, {
    partyType,
    name: `P2B7 ${partyType} ${stamp()}`,
    trn: opts.trn ?? null,
    emirate: opts.emirate ?? null,
    country: opts.country ?? "AE",
    force: true,
  });
  return String(p.id);
}

async function post(
  company: TestCompany,
  docType: "sales_invoice" | "purchase_bill" | "credit_note",
  partyId: string,
  lines: DocLineInput[],
  extra: { originalDocumentId?: string; issueDate?: string; period?: string } = {},
) {
  const d = await createBooksDocument(OMAR, company.clientId, {
    docType,
    partyId,
    issueDate: extra.issueDate || "2026-05-12",
    periodId: company.periods[extra.period || "May 2026"],
    documentNumber: `V201-${stamp()}`,
    originalDocumentId: extra.originalDocumentId,
    lines,
  });
  await approveAndPostBooksDocument(LAYLA, company.clientId, String(d.id));
  return String(d.id);
}

test("P2B-7: draft VAT 201 from posted journals — boxes by emirate and direction, ties to VAT controls", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await setup(admin, "p2b7-draft", "Dubai");
    const clientId = company.clientId;
    const product = company.accountIdByCode["4200"];
    const shj = await party(company, "customer", { emirate: "Sharjah", trn: "100000000000071" });
    const foreignCustomer = await party(company, "customer", { country: "OM" });
    const supplier = await party(company, "supplier", { emirate: "Dubai", trn: "100000000000072" });
    const noTrnSupplier = await party(company, "supplier", { emirate: "Dubai", trn: null });
    const foreignSupplier = await party(company, "supplier", { country: "US" });

    // Services → company Dubai (1b); goods → customer Sharjah (1c).
    await post(company, "sales_invoice", shj, [
      { description: "Bookkeeping", lineKind: "revenue", vatCode: "SR", netMinor: 100000, vatMinor: 5000 },
    ]);
    const goods = await post(company, "sales_invoice", shj, [
      { description: "Printer", lineKind: "revenue", accountId: product, vatCode: "SR", netMinor: 200000, vatMinor: 10000 },
    ]);
    await post(company, "credit_note", shj, [
      { description: "Return", lineKind: "revenue", accountId: product, vatCode: "SR", netMinor: 20000, vatMinor: 1000 },
    ], { originalDocumentId: goods });
    // Export of goods (ZR) → Box 4; exempt → Box 5; disbursement-only → nowhere.
    await post(company, "sales_invoice", foreignCustomer, [
      { description: "Export", lineKind: "revenue", accountId: product, vatCode: "ZR", netMinor: 300000, vatMinor: 0 },
    ]);
    await post(company, "sales_invoice", shj, [
      { description: "Exempt service", lineKind: "revenue", vatCode: "EX", netMinor: 50000, vatMinor: 0 },
    ]);
    await post(company, "sales_invoice", shj, [
      { description: "Gov fee", lineKind: "disbursement", netMinor: 7000, vatMinor: 0 },
    ]);
    // Voided invoice nets to zero in its box.
    const voided = await post(company, "sales_invoice", shj, [
      { description: "Mistake", lineKind: "revenue", vatCode: "SR", netMinor: 40000, vatMinor: 2000 },
    ]);
    await voidBooksDocument(LAYLA, clientId, voided, { reason: "Wrong customer" });

    // Purchases: recoverable SR → Box 9; no TRN → VAT in cost, not Box 9; reverse charge → 3 + 10.
    await post(company, "purchase_bill", supplier, [
      { description: "Rent", lineKind: "expense", vatCode: "SR", netMinor: 100000, vatMinor: 5000 },
    ]);
    await post(company, "purchase_bill", noTrnSupplier, [
      { description: "Cleaning", lineKind: "expense", vatCode: "SR", netMinor: 60000, vatMinor: 3000 },
    ]);
    await post(company, "purchase_bill", foreignSupplier, [
      { description: "SaaS", lineKind: "expense", vatCode: "RC_IN", netMinor: 200000, vatMinor: 10000 },
    ]);
    // Outside the range (June) → not included.
    await post(company, "sales_invoice", shj, [
      { description: "June work", lineKind: "revenue", vatCode: "SR", netMinor: 999900, vatMinor: 49995 },
    ], { issueDate: "2026-06-05", period: "Jun 2026" });
    // Manual JV touching 2210 (not from a document) → reported as unlinked, not in a box.
    const jv = await createBooksJournal(OMAR, clientId, {
      periodId: company.periods["May 2026"],
      entryDate: "2026-05-30",
      memo: "VAT correction",
      allowControlAccounts: true,
      lines: [
        { accountId: company.accountIdByCode["2210"], creditMinor: 123 },
        { accountId: company.accountIdByCode["6900"], debitMinor: 123 },
      ],
    });
    await postBooksJournal(LAYLA, clientId, jv.id);

    const d = await generateVat201Draft(OMAR, clientId, { from: "2026-05-01", to: "2026-05-31" });
    assert.equal(d.from, "2026-05-01");
    assert.equal(d.to, "2026-05-31");
    const b = (id: keyof typeof d.boxes) => [d.boxes[id].amountMinor, d.boxes[id].vatMinor];
    assert.deepEqual(b("1a"), [0, 0]);
    assert.deepEqual(b("1b"), [100000, 5000], "services at the company's emirate; void nets out");
    assert.deepEqual(b("1c"), [180000, 9000], "goods at the customer's emirate, less the credit note");
    assert.deepEqual(b("3"), [200000, 10000]);
    assert.deepEqual(b("4"), [300000, 0]);
    assert.deepEqual(b("5"), [50000, 0]);
    assert.deepEqual(b("9"), [100000, 5000], "no-TRN purchase stays out of Box 9");
    assert.deepEqual(b("10"), [200000, 10000]);
    assert.deepEqual(d.box8, { amountMinor: 830000, vatMinor: 24000 });
    assert.deepEqual(d.box11, { amountMinor: 300000, vatMinor: 15000 });
    assert.equal(d.box12DueTaxMinor, 24000);
    assert.equal(d.box13RecoverableTaxMinor, 15000);
    assert.equal(d.box14PayableMinor, 9000);
    assert.deepEqual(d.unlinked, { outputVatMinor: 123, inputVatMinor: 0, lineCount: 1 });

    // Tie-out: box VAT == document-linked movement on 2210 / 1430 in the quarter.
    const ctl = await admin.query(
      `SELECT a.code, SUM(l.credit_minor - l.debit_minor)::bigint AS cr_net
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_accounts a ON a.id = l.account_id
       WHERE e.client_id = $1 AND e.status IN ('posted','reversed')
         AND e.entry_date BETWEEN '2026-05-01' AND '2026-05-31' AND a.code IN ('2210','1430')
       GROUP BY a.code`,
      [clientId],
    );
    const net = Object.fromEntries(ctl.rows.map((r) => [r.code, Number(r.cr_net)]));
    assert.equal(net["2210"], d.box12DueTaxMinor + d.unlinked.outputVatMinor);
    assert.equal(-net["1430"], d.box13RecoverableTaxMinor);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2B-7: VAT return blocked while the period's gap list is non-empty", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await setup(admin, "p2b7-gate", null);
    const clientId = company.clientId;
    const customer = await party(company, "customer", { emirate: "Ajman", trn: "100000000000073" });
    const svc = await post(company, "sales_invoice", customer, [
      { description: "Consulting", lineKind: "revenue", vatCode: "SR", netMinor: 100000, vatMinor: 5000 },
    ]);

    await assert.rejects(
      generateVat201Draft(OMAR, clientId, { from: "2026-04-01", to: "2026-06-30" }),
      (e: unknown) =>
        e instanceof VatReturnBlockedError &&
        e.message === "vat_return_blocked_place_of_supply_gaps" &&
        e.gaps.length === 1 &&
        e.gaps[0].id === svc &&
        e.gaps[0].why === "company_emirate_missing",
    );
    // A gap outside the range does not block another range.
    const other = await generateVat201Draft(OMAR, clientId, { from: "2026-06-01", to: "2026-06-30" });
    assert.equal(other.box14PayableMinor, 0);

    await setCompanyVatSettings(RAJ, clientId, { establishmentEmirate: "Ras Al Khaimah" });
    await reapplyPlaceOfSupplyRule(RAJ, clientId);
    const ok = await generateVat201Draft(OMAR, clientId, { monthEnd: "2026-05-31" });
    assert.equal(ok.from, "2026-04-01", "quarter from the stagger (Apr–Jun)");
    assert.equal(ok.to, "2026-06-30");
    assert.deepEqual([ok.boxes["1f"].amountMinor, ok.boxes["1f"].vatMinor], [100000, 5000]);

    await admin.query(`UPDATE clients SET vat_return_frequency = NULL, vat_period_end_month = NULL WHERE id = $1`, [
      clientId,
    ]);
    await assert.rejects(generateVat201Draft(OMAR, clientId, { monthEnd: "2026-06-30" }), /vat_stagger_not_set/);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
