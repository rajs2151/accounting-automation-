/**
 * P2B-2: posted sales/purchase documents record the place of supply (emirate) from the party master,
 * or an audited document-level override, so a future VAT 201 can group VAT by emirate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  approveAndPostBooksDocument,
  createBooksDocument,
  type DocLineInput,
} from "@/server/books/documents";
import { createBooksParty, updateBooksParty } from "@/server/books/parties";
import {
  listPlaceOfSupplyGaps,
  normalizeEmirate,
  normalizePlaceOfSupply,
  placeOfSupplyFromParty,
  setDocumentPlaceOfSupply,
} from "@/server/books/place-of-supply";
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
  const ready = await admin.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'books_documents' AND column_name = 'place_of_supply'`,
  );
  if (!ready.rowCount) {
    t.skip("db/51 not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const SR_LINE: DocLineInput[] = [
  { description: "Service", lineKind: "revenue", vatCode: "SR", netMinor: 100000, vatMinor: 5000 },
];

async function pos(admin: pg.Client, id: string) {
  const r = await admin.query(
    `SELECT place_of_supply, place_of_supply_source, place_of_supply_reason, status
     FROM books_documents WHERE id = $1`,
    [id],
  );
  return r.rows[0] as {
    place_of_supply: string | null;
    place_of_supply_source: string | null;
    place_of_supply_reason: string | null;
    status: string;
  };
}

test("P2B-2: emirate normalisation and party → place of supply", () => {
  assert.equal(normalizeEmirate("dubai"), "Dubai");
  assert.equal(normalizeEmirate(" RAK "), "Ras Al Khaimah");
  assert.equal(normalizeEmirate("Umm-Al-Quwain"), "Umm Al Quwain");
  assert.equal(normalizeEmirate("AbuDhabi"), "Abu Dhabi");
  assert.equal(normalizeEmirate("Muscat"), null);
  assert.equal(normalizeEmirate(""), null);
  assert.equal(normalizePlaceOfSupply("outside uae"), "OUTSIDE_UAE");
  assert.deepEqual(placeOfSupplyFromParty({ country: "AE", emirate: "shj" }), {
    placeOfSupply: "Sharjah",
    source: "party",
  });
  assert.deepEqual(placeOfSupplyFromParty({ country: "US", emirate: null }), {
    placeOfSupply: "OUTSIDE_UAE",
    source: "party",
  });
  assert.deepEqual(placeOfSupplyFromParty({ country: "AE", emirate: null }), {
    placeOfSupply: null,
    source: "missing",
  });
});

test("P2B-2: posted documents snapshot the party emirate; later party edits do not change them", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2b2-snapshot");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const s = stamp();
    const sharjah = await createBooksParty(OMAR, clientId, {
      partyType: "customer",
      name: `P2B2 Sharjah ${s}`,
      trn: "100000000000021",
      emirate: "Sharjah",
      force: true,
    });
    const inv = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId: String(sharjah.id),
      issueDate: "2026-05-10",
      periodId,
      documentNumber: `POS-SHJ-${s}`,
      lines: SR_LINE,
    });
    assert.equal((await pos(admin, String(inv.id))).place_of_supply, "Sharjah");
    await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));
    await updateBooksParty(OMAR, clientId, String(sharjah.id), { emirate: "Dubai" });
    const after = await pos(admin, String(inv.id));
    assert.equal(after.place_of_supply, "Sharjah", "posted snapshot is frozen");
    assert.equal(after.place_of_supply_source, "party");

    // Party with no emirate at draft time, fixed before approve → approve snapshots the fix.
    const blank = await createBooksParty(OMAR, clientId, {
      partyType: "supplier",
      name: `P2B2 Blank ${s}`,
      trn: "100000000000022",
      force: true,
    });
    const bill = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: String(blank.id),
      issueDate: "2026-05-11",
      periodId,
      documentNumber: `POS-BLANK-${s}`,
      lines: [{ description: "Rent", lineKind: "expense", vatCode: "SR", netMinor: 40000, vatMinor: 2000 }],
    });
    assert.equal((await pos(admin, String(bill.id))).place_of_supply_source, "missing");
    await updateBooksParty(OMAR, clientId, String(blank.id), { emirate: "ajman" });
    await approveAndPostBooksDocument(LAYLA, clientId, String(bill.id));
    const billPos = await pos(admin, String(bill.id));
    assert.equal(billPos.place_of_supply, "Ajman");
    assert.equal(billPos.place_of_supply_source, "party");

    // Foreign supplier → OUTSIDE_UAE; credit note inherits from its original.
    const foreign = await createBooksParty(OMAR, clientId, {
      partyType: "supplier",
      name: `P2B2 Foreign ${s}`,
      trn: null,
      country: "US",
      force: true,
    });
    const rc = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: String(foreign.id),
      issueDate: "2026-05-12",
      periodId,
      documentNumber: `POS-US-${s}`,
      lines: [{ description: "Cloud", lineKind: "expense", vatCode: "RC_IN", netMinor: 10000, vatMinor: 500 }],
    });
    assert.equal((await pos(admin, String(rc.id))).place_of_supply, "OUTSIDE_UAE");

    const cn = await createBooksDocument(OMAR, clientId, {
      docType: "credit_note",
      partyId: String(sharjah.id),
      issueDate: "2026-05-20",
      periodId,
      documentNumber: `POS-CN-${s}`,
      originalDocumentId: String(inv.id),
      lines: [{ description: "Discount", lineKind: "revenue", vatCode: "SR", netMinor: 10000, vatMinor: 500 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(cn.id));
    const cnPos = await pos(admin, String(cn.id));
    assert.equal(cnPos.place_of_supply, "Sharjah", "note follows the original, not today's party emirate");
    assert.equal(cnPos.place_of_supply_source, "original");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2B-2: document-level override needs a reason, is audited, drafts only", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2b2-override");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const s = stamp();
    const dubai = await createBooksParty(OMAR, clientId, {
      partyType: "customer",
      name: `P2B2 Dubai ${s}`,
      trn: "100000000000023",
      emirate: "Dubai",
      force: true,
    });
    const base = {
      docType: "sales_invoice" as const,
      partyId: String(dubai.id),
      issueDate: "2026-05-10",
      periodId,
      lines: SR_LINE,
    };
    await assert.rejects(
      createBooksDocument(OMAR, clientId, { ...base, documentNumber: `OV0-${s}`, placeOfSupply: "Abu Dhabi" }),
      /place_of_supply_reason_required/,
    );
    await assert.rejects(
      createBooksDocument(OMAR, clientId, {
        ...base,
        documentNumber: `OV0b-${s}`,
        placeOfSupply: "Muscat",
        placeOfSupplyReason: "x",
      }),
      /invalid_place_of_supply/,
    );

    const inv = await createBooksDocument(OMAR, clientId, {
      ...base,
      documentNumber: `OV1-${s}`,
      placeOfSupply: "abu dhabi",
      placeOfSupplyReason: "Goods delivered to the Abu Dhabi branch",
    });
    let p = await pos(admin, String(inv.id));
    assert.equal(p.place_of_supply, "Abu Dhabi");
    assert.equal(p.place_of_supply_source, "override");

    // Clear → back to party; set again via API helper → audited before/after.
    await setDocumentPlaceOfSupply(OMAR, clientId, String(inv.id), { placeOfSupply: null });
    assert.equal((await pos(admin, String(inv.id))).place_of_supply, "Dubai");
    await assert.rejects(
      setDocumentPlaceOfSupply(OMAR, clientId, String(inv.id), { placeOfSupply: "Fujairah", reason: " " }),
      /place_of_supply_reason_required/,
    );
    await setDocumentPlaceOfSupply(OMAR, clientId, String(inv.id), {
      placeOfSupply: "Fujairah",
      reason: "Service performed at the Fujairah site",
    });
    const audit = await admin.query(
      `SELECT before_json, after_json, actor FROM books_audit_events
       WHERE client_id = $1 AND entity_id = $2 AND action = 'set_place_of_supply'
       ORDER BY at`,
      [clientId, inv.id],
    );
    assert.equal(audit.rowCount, 2);
    assert.equal(audit.rows[1].before_json.placeOfSupply, "Dubai");
    assert.equal(audit.rows[1].after_json.placeOfSupply, "Fujairah");
    assert.equal(audit.rows[1].after_json.reason, "Service performed at the Fujairah site");
    assert.equal(String(audit.rows[1].actor), OMAR);

    // Approve keeps the override (party master is not re-applied).
    await approveAndPostBooksDocument(LAYLA, clientId, String(inv.id));
    p = await pos(admin, String(inv.id));
    assert.equal(p.place_of_supply, "Fujairah");
    assert.equal(p.place_of_supply_reason, "Service performed at the Fujairah site");

    // Posted → immutable (correction = void + re-issue).
    await assert.rejects(
      setDocumentPlaceOfSupply(OMAR, clientId, String(inv.id), { placeOfSupply: "Dubai", reason: "oops" }),
      /not_draft/,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2B-2: output VAT groups by emirate; posted documents with no emirate are listed as gaps", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2b2-group");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const s = stamp();
    const mk = (name: string, emirate: string | null, trn: string) =>
      createBooksParty(OMAR, clientId, {
        partyType: "customer",
        name: `P2B2 ${name} ${s}`,
        trn,
        emirate,
        force: true,
      });
    const dxb = await mk("DXB", "Dubai", "100000000000024");
    const auh = await mk("AUH", "Abu Dhabi", "100000000000025");
    const none = await mk("None", null, "100000000000026");
    const post = async (partyId: string, n: string, net: number) => {
      const d = await createBooksDocument(OMAR, clientId, {
        docType: "sales_invoice",
        partyId,
        issueDate: "2026-05-15",
        periodId,
        documentNumber: `GRP-${n}-${s}`,
        lines: [{ description: "Svc", lineKind: "revenue", vatCode: "SR", netMinor: net, vatMinor: net / 20 }],
      });
      await approveAndPostBooksDocument(LAYLA, clientId, String(d.id));
      return String(d.id);
    };
    await post(String(dxb.id), "1", 100000);
    await post(String(dxb.id), "2", 20000);
    await post(String(auh.id), "3", 60000);
    const gapId = await post(String(none.id), "4", 40000);

    const grouped = await admin.query(
      `SELECT COALESCE(place_of_supply, '(missing)') AS e, SUM(vat_minor)::bigint AS vat
       FROM books_documents
       WHERE client_id = $1 AND doc_type = 'sales_invoice' AND status = 'posted'
       GROUP BY 1 ORDER BY 1`,
      [clientId],
    );
    assert.deepEqual(
      grouped.rows.map((r) => [r.e, Number(r.vat)]),
      [
        ["(missing)", 2000],
        ["Abu Dhabi", 3000],
        ["Dubai", 6000],
      ],
    );
    const gaps = await listPlaceOfSupplyGaps(OMAR, clientId, { from: "2026-05-01", to: "2026-05-31" });
    assert.deepEqual(
      gaps.map((g: { id: string }) => g.id),
      [gapId],
    );
    assert.equal(gaps[0].vatMinor, 2000);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
