/**
 * P2B-1: void = reversal for posted sales invoices / purchase bills (and notes); credit/debit notes
 * link to their originals and reduce the open item. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  approveAndPostBooksDocument,
  createBooksDocument,
  voidBooksDocument,
  type DocLineInput,
} from "@/server/books/documents";
import { assertOpenItemsMatchRebuild, listBooksOpenItems } from "@/server/books/open-items";
import { createBooksParty } from "@/server/books/parties";
import { createReceiptOrPayment } from "@/server/books/settlements";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555"; // accountant (preparer)
const LAYLA = "44444444-4444-4444-8444-444444444444"; // approver
const RAJ = "77777777-7777-4777-8777-777777777777"; // admin (synthetic owner, db/31)

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
     WHERE table_name = 'books_documents' AND column_name = 'void_journal_id'`,
  );
  if (!ready.rowCount) {
    t.skip("db/50 not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function party(clientId: string, partyType: "customer" | "supplier", tag: string, trn: string) {
  const created = await createBooksParty(OMAR, clientId, {
    partyType,
    name: `P2B1 ${partyType} ${tag}`,
    trn,
    force: true,
  });
  return String(created.id);
}

const SALES_LINES: DocLineInput[] = [
  { description: "Gov fee rebill", lineKind: "disbursement", netMinor: 100000, vatMinor: 0 },
  { description: "Service charge", lineKind: "revenue", vatCode: "SR", netMinor: 50000, vatMinor: 2500 },
];

async function draft(
  userId: string,
  clientId: string,
  periodId: string,
  body: {
    docType: "sales_invoice" | "purchase_bill" | "credit_note" | "debit_note";
    partyId: string;
    documentNumber: string;
    lines: DocLineInput[];
    originalDocumentId?: string;
    issueDate?: string;
  },
) {
  const doc = await createBooksDocument(userId, clientId, {
    issueDate: "2026-05-10",
    periodId,
    ...body,
  });
  return String(doc.id);
}

async function openItemOf(admin: pg.Client, documentId: string) {
  const r = await admin.query(
    `SELECT id, original_minor, open_original_minor, open_aed_minor, status
     FROM books_open_items WHERE document_id = $1`,
    [documentId],
  );
  return r.rows[0]
    ? {
        id: String(r.rows[0].id),
        original: Number(r.rows[0].original_minor),
        openOriginal: Number(r.rows[0].open_original_minor),
        openAed: Number(r.rows[0].open_aed_minor),
        status: String(r.rows[0].status),
      }
    : null;
}

async function glByCode(admin: pg.Client, clientId: string) {
  const r = await admin.query(
    `SELECT a.code, SUM(l.debit_minor - l.credit_minor)::bigint AS b
     FROM books_journal_lines l
     JOIN books_journal_entries e ON e.id = l.entry_id
     JOIN books_accounts a ON a.id = l.account_id
     WHERE e.client_id = $1 AND e.status IN ('posted', 'reversed')
     GROUP BY a.code`,
    [clientId],
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[String(row.code)] = Number(row.b);
  return out;
}

function may(company: TestCompany) {
  return company.periods["May 2026"];
}

test("P2B-1: void a posted sales invoice posts a linked reversal, closes the open item, audited", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2b1-void-sv");
    const clientId = company.clientId;
    const periodId = may(company);
    const s = stamp();
    const customer = await party(clientId, "customer", s, "100000000000011");
    const invId = await draft(OMAR, clientId, periodId, {
      docType: "sales_invoice",
      partyId: customer,
      documentNumber: `VOID-SV-${s}`,
      lines: SALES_LINES,
    });
    const posted = await approveAndPostBooksDocument(LAYLA, clientId, invId);
    const before = await glByCode(admin, clientId);
    assert.equal(before["1210"], 152500);
    assert.equal(before["1220"], -100000);
    assert.equal(before["2210"], -2500);

    // Reason required; preparer (accountant) cannot void.
    await assert.rejects(voidBooksDocument(LAYLA, clientId, invId, { reason: "  " }), /void_reason_required/);
    await assert.rejects(
      voidBooksDocument(OMAR, clientId, invId, { reason: "Issued to wrong customer" }),
      /reverse_requires_approver/,
    );

    const result = await voidBooksDocument(LAYLA, clientId, invId, { reason: "Issued to wrong customer" });
    assert.equal(result.status, "void");
    assert.match(String(result.reversalEntryNo), /^JV-2026-\d+$/);

    const entries = await admin.query(
      `SELECT id, status, reverses_entry_id, reversed_by_entry_id, entry_type, period_id
       FROM books_journal_entries WHERE id = ANY($1::uuid[])`,
      [[posted.journalEntryId, result.reversalJournalId]],
    );
    const orig = entries.rows.find((r) => String(r.id) === String(posted.journalEntryId))!;
    const rev = entries.rows.find((r) => String(r.id) === String(result.reversalJournalId))!;
    assert.equal(orig.status, "reversed");
    assert.equal(String(orig.reversed_by_entry_id), String(result.reversalJournalId));
    assert.equal(rev.status, "posted");
    assert.equal(rev.entry_type, "reversal");
    assert.equal(String(rev.reverses_entry_id), String(posted.journalEntryId));
    assert.equal(String(rev.period_id), String(periodId));

    // Every account nets to zero after void (original + reversal), incl. VAT and 1220 clearing.
    const after = await glByCode(admin, clientId);
    for (const code of ["1210", "1220", "2210", "4100"]) assert.equal(after[code] ?? 0, 0, code);

    const doc = await admin.query(
      `SELECT status, void_reason, voided_by, void_journal_id, journal_entry_id
       FROM books_documents WHERE id = $1`,
      [invId],
    );
    assert.equal(doc.rows[0].status, "void");
    assert.equal(doc.rows[0].void_reason, "Issued to wrong customer");
    assert.equal(String(doc.rows[0].voided_by), LAYLA);
    assert.equal(String(doc.rows[0].void_journal_id), String(result.reversalJournalId));
    assert.equal(String(doc.rows[0].journal_entry_id), String(posted.journalEntryId), "original link kept");

    const oi = await openItemOf(admin, invId);
    assert.equal(oi!.openOriginal, 0);
    assert.equal(oi!.openAed, 0);
    assert.equal(oi!.status, "closed");
    const open = await listBooksOpenItems(OMAR, clientId, { partyId: customer, status: "open" });
    assert.equal(open.length, 0);

    const audit = await admin.query(
      `SELECT actor, before_json, after_json FROM books_audit_events
       WHERE client_id = $1 AND entity_id = $2 AND action = 'void_document'`,
      [clientId, invId],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(String(audit.rows[0].actor), LAYLA);
    assert.equal(audit.rows[0].after_json.reason, "Issued to wrong customer");
    assert.equal(audit.rows[0].before_json.status, "posted");

    await assert.rejects(voidBooksDocument(LAYLA, clientId, invId, { reason: "again" }), /already_void/);
    assert.deepEqual((await assertOpenItemsMatchRebuild(OMAR, clientId)).mismatches, []);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2B-1: whoever prepared the document cannot void it, even as admin (dual control)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2b1-void-dual");
    const clientId = company.clientId;
    const periodId = may(company);
    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [RAJ, clientId],
    );
    const s = stamp();
    const supplier = await party(clientId, "supplier", s, "100000000000012");
    // Admin prepares (approvers cannot create documents under RLS); approver posts.
    const billId = await draft(RAJ, clientId, periodId, {
      docType: "purchase_bill",
      partyId: supplier,
      documentNumber: `VOID-PV-${s}`,
      lines: [{ description: "Rent", lineKind: "expense", vatCode: "SR", netMinor: 20000, vatMinor: 1000 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, billId);
    await assert.rejects(
      voidBooksDocument(RAJ, clientId, billId, { reason: "Duplicate bill" }),
      /reverse_preparer_cannot_approve/,
    );
    const ok = await voidBooksDocument(LAYLA, clientId, billId, { reason: "Duplicate bill" });
    assert.equal(ok.status, "void");
    const gl = await glByCode(admin, clientId);
    for (const code of ["2110", "1430", "6200"]) assert.equal(gl[code] ?? 0, 0, code);
    assert.equal((await openItemOf(admin, billId))!.status, "closed");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2B-1: void blocked while settled, locked, or not posted", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2b1-void-block");
    const clientId = company.clientId;
    const periodId = may(company);
    const s = stamp();
    const customer = await party(clientId, "customer", s, "100000000000013");

    const draftId = await draft(OMAR, clientId, periodId, {
      docType: "sales_invoice",
      partyId: customer,
      documentNumber: `VOID-DRAFT-${s}`,
      lines: SALES_LINES,
    });
    await assert.rejects(voidBooksDocument(LAYLA, clientId, draftId, { reason: "x" }), /void_requires_posted/);

    const paidId = await draft(OMAR, clientId, periodId, {
      docType: "sales_invoice",
      partyId: customer,
      documentNumber: `VOID-PAID-${s}`,
      lines: SALES_LINES,
    });
    await approveAndPostBooksDocument(LAYLA, clientId, paidId);
    const oi = await openItemOf(admin, paidId);
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: customer,
      issueDate: "2026-05-20",
      periodId,
      bankAccountId: company.accountIdByCode["1120"],
      originalAmountMinor: 100000,
      allocations: [{ openItemId: oi!.id, allocatedOriginalMinor: 100000 }],
    });
    await assert.rejects(
      voidBooksDocument(LAYLA, clientId, paidId, { reason: "x" }),
      /void_has_settlements/,
    );
    assert.equal((await openItemOf(admin, paidId))!.openOriginal, 52500, "partial receipt untouched");

    const lockedId = await draft(OMAR, clientId, periodId, {
      docType: "sales_invoice",
      partyId: customer,
      documentNumber: `VOID-LOCK-${s}`,
      lines: SALES_LINES,
    });
    await approveAndPostBooksDocument(LAYLA, clientId, lockedId);
    await admin.query(`UPDATE books_periods SET status = 'LOCKED' WHERE id = $1`, [periodId]);
    await assert.rejects(voidBooksDocument(LAYLA, clientId, lockedId, { reason: "x" }), /period/);
    const still = await admin.query(`SELECT status FROM books_documents WHERE id = $1`, [lockedId]);
    assert.equal(still.rows[0].status, "posted");
    await admin.query(`UPDATE books_periods SET status = 'OPEN' WHERE id = $1`, [periodId]);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P2B-1: credit / debit notes link to the right original, reduce the open item; void order enforced", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2b1-notes");
    const clientId = company.clientId;
    const periodId = may(company);
    const s = stamp();
    const customer = await party(clientId, "customer", s, "100000000000014");
    const other = await party(clientId, "customer", `${s}-b`, "100000000000015");
    const supplier = await party(clientId, "supplier", s, "100000000000016");

    const invId = await draft(OMAR, clientId, periodId, {
      docType: "sales_invoice",
      partyId: customer,
      documentNumber: `NOTE-SV-${s}`,
      lines: [{ description: "Audit", lineKind: "revenue", vatCode: "SR", netMinor: 100000, vatMinor: 5000 }],
    });
    const cnLines: DocLineInput[] = [
      { description: "Discount", lineKind: "revenue", vatCode: "SR", netMinor: 20000, vatMinor: 1000 },
    ];
    // Original still a draft → rejected.
    await assert.rejects(
      draft(OMAR, clientId, periodId, {
        docType: "credit_note",
        partyId: customer,
        documentNumber: `CN-EARLY-${s}`,
        originalDocumentId: invId,
        lines: cnLines,
      }),
      /original_not_posted/,
    );
    await approveAndPostBooksDocument(LAYLA, clientId, invId);

    await assert.rejects(
      draft(OMAR, clientId, periodId, {
        docType: "credit_note",
        partyId: other,
        documentNumber: `CN-PARTY-${s}`,
        originalDocumentId: invId,
        lines: cnLines,
      }),
      /original_party_mismatch/,
    );
    await assert.rejects(
      draft(OMAR, clientId, periodId, {
        docType: "debit_note",
        partyId: customer,
        documentNumber: `DN-WRONG-${s}`,
        originalDocumentId: invId,
        lines: [{ description: "x", lineKind: "expense", vatCode: "SR", netMinor: 1000, vatMinor: 50 }],
      }),
      /original_wrong_type/,
    );

    const cnId = await draft(OMAR, clientId, periodId, {
      docType: "credit_note",
      partyId: customer,
      documentNumber: `CN-${s}`,
      originalDocumentId: invId,
      lines: cnLines,
    });
    await approveAndPostBooksDocument(LAYLA, clientId, cnId);
    let oi = await openItemOf(admin, invId);
    assert.equal(oi!.openOriginal, 84000);
    assert.equal(oi!.status, "partial");
    let gl = await glByCode(admin, clientId);
    assert.equal(gl["1210"], 84000);
    assert.equal(gl["2210"], -4000);

    // Invoice cannot be voided while the note stands; void the note first.
    await assert.rejects(voidBooksDocument(LAYLA, clientId, invId, { reason: "x" }), /void_has_settlements|void_has_linked_notes/);
    await voidBooksDocument(LAYLA, clientId, cnId, { reason: "Discount withdrawn" });
    oi = await openItemOf(admin, invId);
    assert.equal(oi!.openOriginal, 105000);
    assert.equal(oi!.status, "open");
    assert.deepEqual((await assertOpenItemsMatchRebuild(OMAR, clientId)).mismatches, []);
    await voidBooksDocument(LAYLA, clientId, invId, { reason: "Engagement cancelled" });
    gl = await glByCode(admin, clientId);
    for (const code of ["1210", "2210", "4100"]) assert.equal(gl[code] ?? 0, 0, code);

    // Debit note against a bill; approve-time re-check stops a note larger than what is still open.
    const billId = await draft(OMAR, clientId, periodId, {
      docType: "purchase_bill",
      partyId: supplier,
      documentNumber: `NOTE-PV-${s}`,
      lines: [{ description: "Laptops", lineKind: "expense", vatCode: "SR", netMinor: 40000, vatMinor: 2000 }],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, billId);
    const dnId = await draft(OMAR, clientId, periodId, {
      docType: "debit_note",
      partyId: supplier,
      documentNumber: `DN-${s}`,
      originalDocumentId: billId,
      lines: [{ description: "Return one", lineKind: "expense", vatCode: "SR", netMinor: 20000, vatMinor: 1000 }],
    });
    const billOi = await openItemOf(admin, billId);
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "payment",
      partyId: supplier,
      issueDate: "2026-05-21",
      periodId,
      bankAccountId: company.accountIdByCode["1120"],
      originalAmountMinor: 30000,
      allocations: [{ openItemId: billOi!.id, allocatedOriginalMinor: 30000 }],
    });
    const journalsBefore = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_journal_entries WHERE client_id = $1`,
      [clientId],
    );
    await assert.rejects(approveAndPostBooksDocument(LAYLA, clientId, dnId), /exceeds_original_balance/);
    const journalsAfter = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_journal_entries WHERE client_id = $1`,
      [clientId],
    );
    assert.equal(journalsAfter.rows[0].n, journalsBefore.rows[0].n, "nothing posted");
    assert.equal((await openItemOf(admin, billId))!.openOriginal, 12000);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
