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

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const DESERT = "e1000001-0000-4000-8000-000000000001";
const CUSTOMER = "e9000001-0000-4000-8000-000000000001";
const SUPPLIER = "e9000001-0000-4000-8000-000000000002";

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

async function mayPeriod(admin: pg.Client) {
  const row = await admin.query(
    `SELECT id FROM books_periods WHERE client_id = $1 AND label = 'May 2026'`,
    [DESERT],
  );
  return String(row.rows[0].id);
}

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("C1-1 KPI: AP outstanding / overdue / due-7; draft excluded", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const periodId = await mayPeriod(admin);
    const tag = `KPI-AP-${Date.now()}`;
    const before = await getBooksOpenItemKpis(OMAR, DESERT, "AP");

    const overdue = await createBooksDocument(OMAR, DESERT, {
      docType: "purchase_bill",
      partyId: SUPPLIER,
      issueDate: "2026-05-01",
      dueDate: isoDateOffset(-10),
      periodId,
      documentNumber: `${tag}-OD`,
      lines: [
        { description: "Overdue bill", lineKind: "expense", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
      ],
    });
    const due3 = await createBooksDocument(OMAR, DESERT, {
      docType: "purchase_bill",
      partyId: SUPPLIER,
      issueDate: "2026-05-02",
      dueDate: isoDateOffset(3),
      periodId,
      documentNumber: `${tag}-D3`,
      lines: [
        { description: "Due 3d", lineKind: "expense", vatCode: "SR", netMinor: 20000, vatMinor: 1000 },
      ],
    });
    const due30 = await createBooksDocument(OMAR, DESERT, {
      docType: "purchase_bill",
      partyId: SUPPLIER,
      issueDate: "2026-05-03",
      dueDate: isoDateOffset(30),
      periodId,
      documentNumber: `${tag}-D30`,
      lines: [
        { description: "Due 30d", lineKind: "expense", vatCode: "SR", netMinor: 30000, vatMinor: 1500 },
      ],
    });
    await createBooksDocument(OMAR, DESERT, {
      docType: "purchase_bill",
      partyId: SUPPLIER,
      issueDate: "2026-05-04",
      dueDate: isoDateOffset(-5),
      periodId,
      documentNumber: `${tag}-DRAFT`,
      lines: [
        { description: "Draft only", lineKind: "expense", vatCode: "SR", netMinor: 99900, vatMinor: 4995 },
      ],
    });

    await approveAndPostBooksDocument(LAYLA, DESERT, String(overdue.id));
    await approveAndPostBooksDocument(LAYLA, DESERT, String(due3.id));
    await approveAndPostBooksDocument(LAYLA, DESERT, String(due30.id));

    const items = await listBooksOpenItems(OMAR, DESERT, { side: "AP" });
    const ours = items.filter((i: { documentNumber?: string }) =>
      String(i.documentNumber || "").startsWith(tag),
    );
    assert.equal(ours.length, 3, "draft must not create an open item");

    const kpis = await getBooksOpenItemKpis(OMAR, DESERT, "AP");
    assert.equal(kpis.unmatchedToBankAedMinor, null);
    assert.equal(kpis.totalOutstandingAedMinor - before.totalOutstandingAedMinor, 10500 + 21000 + 31500);
    assert.equal(kpis.overdueAedMinor - before.overdueAedMinor, 10500);
    assert.equal(kpis.dueIn7DaysAedMinor - before.dueIn7DaysAedMinor, 21000);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-1 KPI: AR sales invoice overdue / due-7", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const periodId = await mayPeriod(admin);
    const tag = `KPI-AR-${Date.now()}`;
    const before = await getBooksOpenItemKpis(OMAR, DESERT, "AR");
    const overdue = await createBooksDocument(OMAR, DESERT, {
      docType: "sales_invoice",
      partyId: CUSTOMER,
      issueDate: "2026-05-05",
      dueDate: isoDateOffset(-2),
      periodId,
      documentNumber: `${tag}-OD`,
      lines: [
        { description: "AR overdue", lineKind: "revenue", vatCode: "SR", netMinor: 40000, vatMinor: 2000 },
      ],
    });
    const due3 = await createBooksDocument(OMAR, DESERT, {
      docType: "sales_invoice",
      partyId: CUSTOMER,
      issueDate: "2026-05-06",
      dueDate: isoDateOffset(3),
      periodId,
      documentNumber: `${tag}-D3`,
      lines: [
        { description: "AR due 3", lineKind: "revenue", vatCode: "SR", netMinor: 50000, vatMinor: 2500 },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, DESERT, String(overdue.id));
    await approveAndPostBooksDocument(LAYLA, DESERT, String(due3.id));

    const kpis = await getBooksOpenItemKpis(OMAR, DESERT, "AR");
    assert.equal(kpis.side, "AR");
    assert.equal(kpis.overdueAedMinor - before.overdueAedMinor, 42000);
    assert.equal(kpis.dueIn7DaysAedMinor - before.dueIn7DaysAedMinor, 52500);
    assert.equal(kpis.unmatchedToBankAedMinor, null);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-1 printed totals: match posts; mismatch / VAT block; NULL ok", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const periodId = await mayPeriod(admin);
    const stamp = Date.now();

    const match = await createBooksDocument(OMAR, DESERT, {
      docType: "purchase_bill",
      partyId: SUPPLIER,
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
    const posted = await approveAndPostBooksDocument(LAYLA, DESERT, String(match.id));
    assert.ok(posted.journalEntryId);

    const mismatch = await createBooksDocument(OMAR, DESERT, {
      docType: "purchase_bill",
      partyId: SUPPLIER,
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
      () => approveAndPostBooksDocument(LAYLA, DESERT, String(mismatch.id)),
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

    const vatBad = await createBooksDocument(OMAR, DESERT, {
      docType: "purchase_bill",
      partyId: SUPPLIER,
      issueDate: "2026-05-10",
      periodId,
      documentNumber: `PT-VAT-${stamp}`,
      lines: [
        { description: "Bad VAT", lineKind: "expense", vatCode: "SR", netMinor: 100, vatMinor: 60 },
      ],
    });
    await assert.rejects(
      () => approveAndPostBooksDocument(LAYLA, DESERT, String(vatBad.id)),
      (e: unknown) =>
        e instanceof BooksError && e.code === "conflict" && e.message === "vat_exceeds_rate",
    );

    const nullPrinted = await createBooksDocument(OMAR, DESERT, {
      docType: "purchase_bill",
      partyId: SUPPLIER,
      issueDate: "2026-05-11",
      periodId,
      documentNumber: `PT-NULL-${stamp}`,
      lines: [
        { description: "No printed", lineKind: "expense", vatCode: "SR", netMinor: 8000, vatMinor: 400 },
      ],
    });
    const postedNull = await approveAndPostBooksDocument(LAYLA, DESERT, String(nullPrinted.id));
    assert.ok(postedNull.journalEntryId);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-1 payments made: info only — open item full gross, no settlement rows", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const periodId = await mayPeriod(admin);
    const stamp = Date.now();
    const beforeAlloc = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_allocations WHERE client_id = $1`,
      [DESERT],
    );
    const beforeDocs = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_documents
       WHERE client_id = $1 AND doc_type IN ('receipt','payment')`,
      [DESERT],
    );

    const doc = await createBooksDocument(OMAR, DESERT, {
      docType: "sales_invoice",
      partyId: CUSTOMER,
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
    await approveAndPostBooksDocument(LAYLA, DESERT, String(doc.id));
    const oi = await listBooksOpenItems(OMAR, DESERT, { partyId: CUSTOMER, status: "open" });
    const item = oi.find((r: { documentNumber?: string }) => r.documentNumber === `PAY-INFO-${stamp}`);
    assert.ok(item);
    assert.equal(Number(item!.openAedMinor), 10500);
    assert.equal(Number(item!.openOriginalMinor), 10500);

    const afterAlloc = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_allocations WHERE client_id = $1`,
      [DESERT],
    );
    const afterDocs = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_documents
       WHERE client_id = $1 AND doc_type IN ('receipt','payment')`,
      [DESERT],
    );
    assert.equal(afterAlloc.rows[0].n, beforeAlloc.rows[0].n);
    assert.equal(afterDocs.rows[0].n, beforeDocs.rows[0].n);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-1 journal preview: matches posted lines; creates no rows; balances", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const periodId = await mayPeriod(admin);
    const stamp = Date.now();
    const doc = await createBooksDocument(OMAR, DESERT, {
      docType: "purchase_bill",
      partyId: SUPPLIER,
      issueDate: "2026-05-13",
      periodId,
      documentNumber: `PREV-${stamp}`,
      lines: [
        { description: "Preview line", lineKind: "expense", vatCode: "SR", netMinor: 10000, vatMinor: 500 },
      ],
    });

    const count = async () => {
      const j = await admin.query(
        `SELECT COUNT(*)::int AS n FROM books_journal_entries WHERE client_id = $1`,
        [DESERT],
      );
      const v = await admin.query(
        `SELECT COUNT(*)::int AS n FROM books_voucher_sequences WHERE client_id = $1`,
        [DESERT],
      );
      const a = await admin.query(
        `SELECT COUNT(*)::int AS n FROM books_audit_events WHERE client_id = $1`,
        [DESERT],
      );
      return { journals: j.rows[0].n, vouchers: v.rows[0].n, audit: a.rows[0].n };
    };

    const before = await count();
    const preview = await previewBooksDocumentJournal(OMAR, DESERT, String(doc.id));
    const afterPreview = await count();
    assert.deepEqual(afterPreview, before, "preview must not insert journals/vouchers/audit");
    assert.equal(preview.balanced, true);
    assert.equal(preview.debitMinor, preview.creditMinor);
    assert.ok(preview.lines.length >= 2);

    const posted = await approveAndPostBooksDocument(LAYLA, DESERT, String(doc.id));
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
  } finally {
    await admin.end().catch(() => undefined);
  }
});
