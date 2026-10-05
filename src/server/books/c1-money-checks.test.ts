import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  approveAndPostBooksDocument,
  createBooksDocument,
  previewBooksDocumentJournal,
} from "@/server/books/documents";
import { BooksError } from "@/server/books/errors";
import { getBooksOpenItemKpis, listBooksOpenItems } from "@/server/books/open-items";
import { createBooksParty } from "@/server/books/parties";
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
  const ready = await admin.query(`SELECT to_regclass('books_documents') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("phase1 schema not migrated");
    await admin.end();
    return null;
  }
  const col = await admin.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'books_documents' AND column_name = 'printed_gross_minor'`,
  );
  if (!col.rowCount) {
    t.skip("db/28 printed totals not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function uniqueSupplier(clientId: string, tag: string, trn?: string | null): Promise<string> {
  const created = await createBooksParty(OMAR, clientId, {
    partyType: "supplier",
    name: `C1-1 KPI Supplier ${tag}`,
    trn: trn === undefined ? `100${Date.now().toString().slice(-10)}004` : trn,
    force: true,
  });
  assert.ok(created.id, "supplier party created");
  return String(created.id);
}

async function uniqueCustomer(clientId: string, tag: string): Promise<string> {
  const created = await createBooksParty(OMAR, clientId, {
    partyType: "customer",
    name: `C1-1 KPI Customer ${tag}`,
    force: true,
  });
  assert.ok(created.id, "customer party created");
  return String(created.id);
}

test("C1-1 KPI: AP outstanding / overdue / due-7; draft excluded", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-1");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const tag = `KPI-AP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueSupplier(clientId, tag);

    const overdue = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId,
      issueDate: "2026-05-01",
      dueDate: isoDateOffset(-10),
      periodId,
      documentNumber: `${tag}-OD`,
      lines: [
        { description: "Overdue bill", lineKind: "expense", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
      ],
    });
    const due3 = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId,
      issueDate: "2026-05-02",
      dueDate: isoDateOffset(3),
      periodId,
      documentNumber: `${tag}-D3`,
      lines: [
        { description: "Due 3d", lineKind: "expense", vatCode: "SR", netMinor: 20000, vatMinor: 1000 },
      ],
    });
    const due30 = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId,
      issueDate: "2026-05-03",
      dueDate: isoDateOffset(30),
      periodId,
      documentNumber: `${tag}-D30`,
      lines: [
        { description: "Due 30d", lineKind: "expense", vatCode: "SR", netMinor: 30000, vatMinor: 1500 },
      ],
    });
    await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId,
      issueDate: "2026-05-04",
      dueDate: isoDateOffset(-5),
      periodId,
      documentNumber: `${tag}-DRAFT`,
      lines: [
        { description: "Draft only", lineKind: "expense", vatCode: "SR", netMinor: 99900, vatMinor: 4995 },
      ],
    });

    // Different party: its posted bill must not appear in our party's KPIs.
    const otherPartyId = await uniqueSupplier(clientId, `${tag}-other`);
    const other = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: otherPartyId,
      issueDate: "2026-05-01",
      dueDate: isoDateOffset(-10),
      periodId,
      documentNumber: `${tag}-OTHER`,
      lines: [
        { description: "Other party", lineKind: "expense", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
      ],
    });

    await approveAndPostBooksDocument(LAYLA, clientId, String(overdue.id));
    await approveAndPostBooksDocument(LAYLA, clientId, String(due3.id));
    await approveAndPostBooksDocument(LAYLA, clientId, String(due30.id));
    await approveAndPostBooksDocument(LAYLA, clientId, String(other.id));

    const items = await listBooksOpenItems(OMAR, clientId, { side: "AP", partyId });
    const ours = items.filter((i: { documentNumber?: string }) =>
      String(i.documentNumber || "").startsWith(tag),
    );
    assert.equal(ours.length, 3, "draft must not create an open item");
    assert.ok(
      !ours.some((i: { documentNumber?: string }) => i.documentNumber === `${tag}-OTHER`),
      "other party's document excluded from party open-items list",
    );

    const kpis = await getBooksOpenItemKpis(OMAR, clientId, "AP", { partyId });
    assert.equal(kpis.unmatchedToBankAedMinor, null);
    assert.equal(kpis.totalOutstandingAedMinor, 63000);
    assert.equal(kpis.overdueAedMinor, 10500);
    assert.equal(kpis.dueIn7DaysAedMinor, 21000);

    const otherKpis = await getBooksOpenItemKpis(OMAR, clientId, "AP", { partyId: otherPartyId });
    assert.equal(otherKpis.totalOutstandingAedMinor, 10500, "other party KPI is only its own bill");
    assert.equal(otherKpis.overdueAedMinor, 10500);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-1 KPI: AR sales invoice overdue / due-7", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-1");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const tag = `KPI-AR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueCustomer(clientId, tag);

    const overdue = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId,
      issueDate: "2026-05-05",
      dueDate: isoDateOffset(-2),
      periodId,
      documentNumber: `${tag}-OD`,
      lines: [
        { description: "AR overdue", lineKind: "revenue", vatCode: "SR", netMinor: 40000, vatMinor: 2000 },
      ],
    });
    const due3 = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId,
      issueDate: "2026-05-06",
      dueDate: isoDateOffset(3),
      periodId,
      documentNumber: `${tag}-D3`,
      lines: [
        { description: "AR due 3", lineKind: "revenue", vatCode: "SR", netMinor: 50000, vatMinor: 2500 },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(overdue.id));
    await approveAndPostBooksDocument(LAYLA, clientId, String(due3.id));

    const kpis = await getBooksOpenItemKpis(OMAR, clientId, "AR", { partyId });
    assert.equal(kpis.side, "AR");
    assert.equal(kpis.totalOutstandingAedMinor, 94500);
    assert.equal(kpis.overdueAedMinor, 42000);
    assert.equal(kpis.dueIn7DaysAedMinor, 52500);
    assert.equal(kpis.unmatchedToBankAedMinor, null);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-1 printed totals: match posts; mismatch / VAT block; NULL ok", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-1");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const stamp = Date.now();
    const supplierId = await uniqueSupplier(clientId, `PT-${stamp}`);

    const match = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: supplierId,
      issueDate: "2026-05-10",
      periodId,
      documentNumber: `PT-OK-${stamp}`,
      printedNetMinor: 10000,
      printedVatMinor: 500,
      printedGrossMinor: 10500,
      lines: [
        { description: "Match", lineKind: "expense", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
      ],
    });
    const posted = await approveAndPostBooksDocument(LAYLA, clientId, String(match.id));
    assert.ok(posted.journalEntryId);

    const mismatch = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: supplierId,
      issueDate: "2026-05-10",
      periodId,
      documentNumber: `PT-MIS-${stamp}`,
      printedNetMinor: 10000,
      printedVatMinor: 500,
      printedGrossMinor: 10501, // off by 1 fils
      lines: [
        { description: "Mismatch", lineKind: "expense", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
      ],
    });
    await assert.rejects(
      () => approveAndPostBooksDocument(LAYLA, clientId, String(mismatch.id)),
      (e: unknown) =>
        e instanceof BooksError &&
        e.code === "conflict" &&
        String(e.message).startsWith("printed_totals_mismatch"),
    );
    const journals = await admin.query(
      `SELECT journal_entry_id FROM books_documents WHERE id = $1`,
      [mismatch.id],
    );
    assert.equal(journals.rows[0].journal_entry_id, null);

    const vatBad = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: supplierId,
      issueDate: "2026-05-10",
      periodId,
      documentNumber: `PT-VAT-${stamp}`,
      lines: [
        { description: "Bad VAT", lineKind: "expense", vatCode: "SR", netMinor: 100, vatMinor: 60 },
      ],
    });
    await assert.rejects(
      () => approveAndPostBooksDocument(LAYLA, clientId, String(vatBad.id)),
      (e: unknown) =>
        e instanceof BooksError && e.code === "conflict" && e.message === "vat_exceeds_rate",
    );

    const nullPrinted = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: supplierId,
      issueDate: "2026-05-11",
      periodId,
      documentNumber: `PT-NULL-${stamp}`,
      lines: [
        { description: "No printed", lineKind: "expense", vatCode: "SR", netMinor: 8000, vatMinor: 400 },
      ],
    });
    const postedNull = await approveAndPostBooksDocument(LAYLA, clientId, String(nullPrinted.id));
    assert.ok(postedNull.journalEntryId);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-1 payments made: info only — open item full gross, no settlement rows", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-1");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueCustomer(clientId, `PAY-${stamp}`);

    const beforeAlloc = await admin.query(
      `SELECT COUNT(*)::int AS n
       FROM books_allocations a
       JOIN books_open_items oi ON oi.id = a.open_item_id
       WHERE a.client_id = $1 AND oi.party_id = $2`,
      [clientId, partyId],
    );
    const beforeDocs = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_documents
       WHERE client_id = $1 AND party_id = $2 AND doc_type IN ('receipt','payment')`,
      [clientId, partyId],
    );

    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId,
      issueDate: "2026-05-12",
      periodId,
      documentNumber: `PAY-INFO-${stamp}`,
      printedPaidMinor: 5000,
      printedBalanceDueMinor: 5500,
      printedNetMinor: 10000,
      printedVatMinor: 500,
      printedGrossMinor: 10500,
      lines: [
        { description: "Paid on doc", lineKind: "revenue", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
    const oi = await listBooksOpenItems(OMAR, clientId, { partyId, status: "open" });
    const item = oi.find((r: { documentNumber?: string }) => r.documentNumber === `PAY-INFO-${stamp}`);
    assert.ok(item);
    assert.equal(Number(item!.openAedMinor), 10500);
    assert.equal(Number(item!.openOriginalMinor), 10500);

    const afterAlloc = await admin.query(
      `SELECT COUNT(*)::int AS n
       FROM books_allocations a
       JOIN books_open_items oi ON oi.id = a.open_item_id
       WHERE a.client_id = $1 AND oi.party_id = $2`,
      [clientId, partyId],
    );
    const afterDocs = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_documents
       WHERE client_id = $1 AND party_id = $2 AND doc_type IN ('receipt','payment')`,
      [clientId, partyId],
    );
    // Also: no allocations against this document's open item.
    const docAlloc = await admin.query(
      `SELECT COUNT(*)::int AS n
       FROM books_allocations a
       JOIN books_open_items oi ON oi.id = a.open_item_id
       WHERE a.client_id = $1 AND oi.document_id = $2`,
      [clientId, doc.id],
    );
    assert.equal(afterAlloc.rows[0].n, beforeAlloc.rows[0].n);
    assert.equal(afterDocs.rows[0].n, beforeDocs.rows[0].n);
    assert.equal(docAlloc.rows[0].n, 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-1 journal preview: matches posted lines; creates no rows; balances", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-1");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const supplierId = await uniqueSupplier(clientId, `PREV-${stamp}`);
    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: supplierId,
      issueDate: "2026-05-13",
      periodId,
      documentNumber: `PREV-${stamp}`,
      lines: [
        { description: "Preview line", lineKind: "expense", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
      ],
    });
    const docId = String(doc.id);

    const scopedAuditCount = async () => {
      const a = await admin.query(
        `SELECT COUNT(*)::int AS n FROM books_audit_events
         WHERE client_id = $1
           AND (
             entity_id = $2::uuid
             OR entity_id IN (SELECT id FROM books_document_lines WHERE document_id = $2::uuid)
             OR entity_id IN (
               SELECT journal_entry_id FROM books_documents
               WHERE id = $2::uuid AND journal_entry_id IS NOT NULL
             )
           )`,
        [clientId, docId],
      );
      return a.rows[0].n as number;
    };

    const journalLink = async () => {
      const d = await admin.query(
        `SELECT journal_entry_id FROM books_documents WHERE id = $1 AND client_id = $2`,
        [docId, clientId],
      );
      const linkedViaDoc = await admin.query(
        `SELECT COUNT(*)::int AS n FROM books_documents
         WHERE id = $1 AND client_id = $2 AND journal_entry_id IS NOT NULL`,
        [docId, clientId],
      );
      return {
        journalEntryId: d.rows[0].journal_entry_id as string | null,
        linkedCount: linkedViaDoc.rows[0].n as number,
      };
    };

    const voucherSnapshot = async () => {
      const v = await admin.query(
        `SELECT voucher_type AS "voucherType", year, prefix, last_n AS "lastN"
         FROM books_voucher_sequences
         WHERE client_id = $1
         ORDER BY voucher_type, year`,
        [clientId],
      );
      return v.rows;
    };

    const beforeAudit = await scopedAuditCount();
    const beforeJournal = await journalLink();
    const beforeVouchers = await voucherSnapshot();

    const preview = await previewBooksDocumentJournal(OMAR, clientId, docId);

    const afterAudit = await scopedAuditCount();
    const afterJournal = await journalLink();
    const afterVouchers = await voucherSnapshot();

    assert.equal(afterAudit, beforeAudit, "preview must not write document-scoped audit");
    assert.equal(afterJournal.journalEntryId, null);
    assert.equal(beforeJournal.journalEntryId, null);
    assert.equal(afterJournal.linkedCount, 0);
    assert.deepEqual(afterVouchers, beforeVouchers, "preview must not consume voucher numbers");
    assert.equal(preview.balanced, true);
    assert.equal(preview.debitMinor, preview.creditMinor);
    assert.ok(preview.lines.length >= 2);

    const posted = await approveAndPostBooksDocument(LAYLA, clientId, docId);
    const jl = await admin.query(
      `SELECT a.code AS "accountCode",
              COALESCE(l.vat_treatment, l.vat_code) AS "vatCode",
              l.debit_minor AS "debitMinor", l.credit_minor AS "creditMinor"
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1`,
      [posted.journalEntryId],
    );

    const norm = (
      rows: Array<{ accountCode: string; vatCode: string | null; debitMinor: number; creditMinor: number }>,
    ) =>
      rows
        .map((r) => ({
          accountCode: String(r.accountCode),
          vatCode: r.vatCode ? String(r.vatCode) : null,
          debitMinor: Number(r.debitMinor),
          creditMinor: Number(r.creditMinor),
        }))
        .sort(
          (a, b) =>
            a.accountCode.localeCompare(b.accountCode) ||
            a.debitMinor - b.debitMinor ||
            a.creditMinor - b.creditMinor,
        );

    const previewNorm = norm(
      preview.lines.map((l) => ({
        accountCode: l.accountCode,
        vatCode: l.vatCode,
        debitMinor: l.debitMinor,
        creditMinor: l.creditMinor,
      })),
    );
    const postedNorm = norm(jl.rows);
    assert.deepEqual(previewNorm, postedNorm);

    // AED balance of preview totals.
    const sumDrAed = preview.lines.reduce((s, l) => s + (l.debitMinor > 0 ? l.aedMinor : 0), 0);
    const sumCrAed = preview.lines.reduce((s, l) => s + (l.creditMinor > 0 ? l.aedMinor : 0), 0);
    assert.equal(sumDrAed, sumCrAed);
    assert.equal(preview.debitMinor, sumDrAed);
    assert.equal(preview.creditMinor, sumCrAed);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
