/**
 * P2B-2 / P2B-5: posted sales/purchase documents record a place of supply (emirate) for VAT 201
 * grouping. Rule (owner 2026-10-06): services → supplier's establishment emirate (sales: the company),
 * goods → delivery emirate (sales: the customer). Draft override with reason, audited.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { setCompanyVatSettings } from "@/server/books/company-vat-settings";
import {
  approveAndPostBooksDocument,
  createBooksDocument,
  type DocLineInput,
} from "@/server/books/documents";
import { createBooksParty, updateBooksParty } from "@/server/books/parties";
import {
  decidePlaceOfSupply,
  documentSupplyType,
  lineSupplyType,
  listPlaceOfSupplyGaps,
  normalizeEmirate,
  normalizePlaceOfSupply,
  placeOfSupplyFromParty,
  reapplyPlaceOfSupplyRule,
  setDocumentPlaceOfSupply,
} from "@/server/books/place-of-supply";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";

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
     WHERE table_name = 'books_documents' AND column_name = 'supply_type'`,
  );
  if (!ready.rowCount) {
    t.skip("db/53 not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const SERVICE: DocLineInput[] = [
  { description: "Service", lineKind: "revenue", vatCode: "SR", netMinor: 100000, vatMinor: 5000 },
];

async function pos(admin: pg.Client, id: string) {
  const r = await admin.query(
    `SELECT place_of_supply, place_of_supply_source, place_of_supply_reason, supply_type, status
     FROM books_documents WHERE id = $1`,
    [id],
  );
  return r.rows[0] as {
    place_of_supply: string | null;
    place_of_supply_source: string | null;
    place_of_supply_reason: string | null;
    supply_type: string | null;
    status: string;
  };
}

/** Company in Dubai (via the admin settings API). */
async function dubaiCompany(admin: pg.Client, label: string) {
  const company = await createTestCompany(admin, label);
  await admin.query(
    `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [RAJ, company.clientId],
  );
  await setCompanyVatSettings(RAJ, company.clientId, { establishmentEmirate: "dxb" });
  return company;
}

async function party(
  company: TestCompany,
  partyType: "customer" | "supplier",
  name: string,
  emirate: string | null,
  trn: string | null,
  country = "AE",
) {
  const p = await createBooksParty(OMAR, company.clientId, {
    partyType,
    name: `P2B5 ${name} ${stamp()}`,
    trn,
    emirate,
    country,
    force: true,
  });
  return String(p.id);
}

async function doc(
  company: TestCompany,
  body: {
    docType: "sales_invoice" | "purchase_bill" | "credit_note" | "debit_note";
    partyId: string;
    lines: DocLineInput[];
    originalDocumentId?: string;
    placeOfSupply?: string;
    placeOfSupplyReason?: string;
  },
) {
  const d = await createBooksDocument(OMAR, company.clientId, {
    issueDate: "2026-05-10",
    periodId: company.periods["May 2026"],
    documentNumber: `POS-${stamp()}`,
    ...body,
  });
  return String(d.id);
}

test("P2B-2: emirate normalisation and party → place of supply", () => {
  assert.equal(normalizeEmirate("dubai"), "Dubai");
  assert.equal(normalizeEmirate(" RAK "), "Ras Al Khaimah");
  assert.equal(normalizeEmirate("Umm-Al-Quwain"), "Umm Al Quwain");
  assert.equal(normalizeEmirate("AbuDhabi"), "Abu Dhabi");
  assert.equal(normalizeEmirate("Muscat"), null);
  assert.equal(normalizeEmirate(""), null);
  assert.equal(normalizePlaceOfSupply("outside uae"), "OUTSIDE_UAE");
  assert.deepEqual(placeOfSupplyFromParty({ country: "US", emirate: null }), {
    placeOfSupply: "OUTSIDE_UAE",
    source: "party",
  });
});

test("P2B-5: the rule — services → supplier's establishment, goods → delivery", () => {
  assert.equal(lineSupplyType("revenue", "service"), "services");
  assert.equal(lineSupplyType("revenue", "product"), "goods");
  assert.equal(lineSupplyType("inventory", null), "goods");
  assert.equal(lineSupplyType("asset", null), "goods");
  assert.equal(lineSupplyType("expense", null), "services");
  assert.equal(lineSupplyType("disbursement", null), null);
  assert.equal(documentSupplyType(["services", null]), "services");
  assert.equal(documentSupplyType(["goods", "services"]), "mixed");
  assert.equal(documentSupplyType([null]), "none");

  const sharjahCustomer = { country: "AE", emirate: "Sharjah" };
  const cases: Array<[Parameters<typeof decidePlaceOfSupply>[0], string | null, string]> = [
    [{ side: "sales", supplyType: "services", companyEmirate: "Dubai", party: sharjahCustomer }, "Dubai", "company"],
    [{ side: "sales", supplyType: "goods", companyEmirate: "Dubai", party: sharjahCustomer }, "Sharjah", "party"],
    [{ side: "sales", supplyType: "goods", companyEmirate: "Dubai", party: { country: "OM" } }, "OUTSIDE_UAE", "party"],
    [{ side: "sales", supplyType: "services", companyEmirate: null, party: sharjahCustomer }, null, "missing"],
    [{ side: "purchases", supplyType: "services", companyEmirate: "Dubai", party: sharjahCustomer }, "Sharjah", "party"],
    [{ side: "purchases", supplyType: "goods", companyEmirate: "Dubai", party: sharjahCustomer }, "Dubai", "company"],
    [{ side: "purchases", supplyType: "services", companyEmirate: "Dubai", party: { country: "US" } }, "OUTSIDE_UAE", "party"],
    [{ side: "sales", supplyType: "mixed", companyEmirate: "Dubai", party: sharjahCustomer }, null, "missing"],
    [{ side: "sales", supplyType: "none", companyEmirate: "Dubai", party: sharjahCustomer }, null, "not_applicable"],
  ];
  for (const [args, want, source] of cases) {
    assert.deepEqual(decidePlaceOfSupply(args), { placeOfSupply: want, source }, JSON.stringify(args));
  }
});

test("P2B-5: documents snapshot the rule; posted snapshot frozen; notes inherit", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await dubaiCompany(admin, "p2b5-snapshot");
    const shj = await party(company, "customer", "Sharjah", "Sharjah", "100000000000051");
    const supplier = await party(company, "supplier", "Ajman", "ajman", "100000000000052");

    // Services sale → company's Dubai, whatever the customer's emirate.
    const svc = await doc(company, { docType: "sales_invoice", partyId: shj, lines: SERVICE });
    let p = await pos(admin, svc);
    assert.deepEqual([p.place_of_supply, p.place_of_supply_source, p.supply_type], ["Dubai", "company", "services"]);

    // Goods sale (product-sales account 4200) → customer's Sharjah.
    const goods = await doc(company, {
      docType: "sales_invoice",
      partyId: shj,
      lines: [
        {
          description: "Laptops",
          lineKind: "revenue",
          accountId: company.accountIdByCode["4200"],
          vatCode: "SR",
          netMinor: 200000,
          vatMinor: 10000,
        },
      ],
    });
    p = await pos(admin, goods);
    assert.deepEqual([p.place_of_supply, p.place_of_supply_source, p.supply_type], ["Sharjah", "party", "goods"]);

    // Purchases: services → supplier's Ajman; inventory → delivered to us in Dubai.
    const svcBill = await doc(company, {
      docType: "purchase_bill",
      partyId: supplier,
      lines: [{ description: "Audit", lineKind: "expense", vatCode: "SR", netMinor: 10000, vatMinor: 500 }],
    });
    assert.equal((await pos(admin, svcBill)).place_of_supply, "Ajman");
    const stockBill = await doc(company, {
      docType: "purchase_bill",
      partyId: supplier,
      lines: [{ description: "Stock", lineKind: "inventory", vatCode: "SR", netMinor: 10000, vatMinor: 500 }],
    });
    assert.equal((await pos(admin, stockBill)).place_of_supply, "Dubai");

    // Disbursement-only rebill: not a supply → not_applicable (never a gap).
    const rebill = await doc(company, {
      docType: "sales_invoice",
      partyId: shj,
      lines: [{ description: "Gov fee", lineKind: "disbursement", netMinor: 5000, vatMinor: 0 }],
    });
    p = await pos(admin, rebill);
    assert.deepEqual([p.place_of_supply, p.place_of_supply_source, p.supply_type], [null, "not_applicable", "none"]);

    await approveAndPostBooksDocument(LAYLA, company.clientId, goods);
    await updateBooksParty(OMAR, company.clientId, shj, { emirate: "Fujairah" });
    assert.equal((await pos(admin, goods)).place_of_supply, "Sharjah", "posted snapshot is frozen");

    const cn = await doc(company, {
      docType: "credit_note",
      partyId: shj,
      originalDocumentId: goods,
      lines: [
        {
          description: "Return",
          lineKind: "revenue",
          accountId: company.accountIdByCode["4200"],
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, company.clientId, cn);
    p = await pos(admin, cn);
    assert.deepEqual([p.place_of_supply, p.place_of_supply_source], ["Sharjah", "original"]);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2B-5: gaps — company emirate missing, mixed supply; admin re-apply fixes posted documents", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2b5-gaps");
    const clientId = company.clientId;
    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [RAJ, clientId],
    );
    const customer = await party(company, "customer", "Dubai cust", "Dubai", "100000000000053");

    // No establishment emirate yet → services sale is a gap, but approve still works.
    const svc = await doc(company, { docType: "sales_invoice", partyId: customer, lines: SERVICE });
    await approveAndPostBooksDocument(LAYLA, clientId, svc);
    assert.equal((await pos(admin, svc)).place_of_supply_source, "missing");

    const mixed = await doc(company, {
      docType: "sales_invoice",
      partyId: customer,
      lines: [
        ...SERVICE,
        {
          description: "Hardware",
          lineKind: "revenue",
          accountId: company.accountIdByCode["4200"],
          vatCode: "SR",
          netMinor: 40000,
          vatMinor: 2000,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, mixed);
    const rebill = await doc(company, {
      docType: "sales_invoice",
      partyId: customer,
      lines: [{ description: "Gov fee", lineKind: "disbursement", netMinor: 5000, vatMinor: 0 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, rebill);

    let gaps = await listPlaceOfSupplyGaps(OMAR, clientId);
    assert.deepEqual(
      gaps.map((g) => [g.id, g.why]).sort(),
      [
        [mixed, "mixed_supply"],
        [svc, "company_emirate_missing"],
      ].sort(),
    );

    await assert.rejects(reapplyPlaceOfSupplyRule(OMAR, clientId), /reapply_requires_admin/);
    await setCompanyVatSettings(RAJ, clientId, { establishmentEmirate: "Abu Dhabi" });
    const re = await reapplyPlaceOfSupplyRule(RAJ, clientId);
    assert.equal(re.changed, 1, "only the services invoice changes; mixed stays a gap");
    assert.equal((await pos(admin, svc)).place_of_supply, "Abu Dhabi");
    gaps = await listPlaceOfSupplyGaps(OMAR, clientId);
    assert.deepEqual(
      gaps.map((g) => g.id),
      [mixed],
    );
    const audit = await admin.query(
      `SELECT before_json, after_json FROM books_audit_events
       WHERE client_id = $1 AND entity_id = $2 AND action = 'reapply_place_of_supply'`,
      [clientId, svc],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].before_json.source, "missing");
    assert.equal(audit.rows[0].after_json.placeOfSupply, "Abu Dhabi");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2B-2: document-level override needs a reason, is audited, drafts only, survives approve", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await dubaiCompany(admin, "p2b5-override");
    const clientId = company.clientId;
    const customer = await party(company, "customer", "Dubai", "Dubai", "100000000000054");
    await assert.rejects(
      doc(company, { docType: "sales_invoice", partyId: customer, lines: SERVICE, placeOfSupply: "Abu Dhabi" }),
      /place_of_supply_reason_required/,
    );
    await assert.rejects(
      doc(company, {
        docType: "sales_invoice",
        partyId: customer,
        lines: SERVICE,
        placeOfSupply: "Muscat",
        placeOfSupplyReason: "x",
      }),
      /invalid_place_of_supply/,
    );
    const inv = await doc(company, {
      docType: "sales_invoice",
      partyId: customer,
      lines: SERVICE,
      placeOfSupply: "abu dhabi",
      placeOfSupplyReason: "Service supplied from the Abu Dhabi branch",
    });
    let p = await pos(admin, inv);
    assert.deepEqual([p.place_of_supply, p.place_of_supply_source, p.supply_type], ["Abu Dhabi", "override", "services"]);

    await setDocumentPlaceOfSupply(OMAR, clientId, inv, { placeOfSupply: null });
    assert.equal((await pos(admin, inv)).place_of_supply, "Dubai", "back to the rule (company emirate)");
    await assert.rejects(
      setDocumentPlaceOfSupply(OMAR, clientId, inv, { placeOfSupply: "Fujairah", reason: " " }),
      /place_of_supply_reason_required/,
    );
    await setDocumentPlaceOfSupply(OMAR, clientId, inv, {
      placeOfSupply: "Fujairah",
      reason: "Branch in Fujairah supplies this contract",
    });
    const audit = await admin.query(
      `SELECT before_json, after_json, actor FROM books_audit_events
       WHERE client_id = $1 AND entity_id = $2 AND action = 'set_place_of_supply' ORDER BY at`,
      [clientId, inv],
    );
    assert.equal(audit.rowCount, 2);
    assert.equal(audit.rows[1].before_json.placeOfSupply, "Dubai");
    assert.equal(audit.rows[1].after_json.placeOfSupply, "Fujairah");
    assert.equal(String(audit.rows[1].actor), OMAR);

    await approveAndPostBooksDocument(LAYLA, clientId, inv);
    p = await pos(admin, inv);
    assert.equal(p.place_of_supply, "Fujairah");
    assert.equal(p.place_of_supply_reason, "Branch in Fujairah supplies this contract");
    // Admin re-apply never touches overrides.
    await reapplyPlaceOfSupplyRule(RAJ, clientId);
    assert.equal((await pos(admin, inv)).place_of_supply, "Fujairah");
    await assert.rejects(
      setDocumentPlaceOfSupply(OMAR, clientId, inv, { placeOfSupply: "Dubai", reason: "oops" }),
      /not_draft/,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});
