import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import {
  acknowledgeBooksDocumentCheckVat,
  approveAndPostBooksDocument,
  createBooksDocument,
  getBooksDocument,
} from "@/server/books/documents";
import { BooksError } from "@/server/books/errors";
import { confirmInboxAsDocument } from "@/server/books/inbox";
import { createBooksParty } from "@/server/books/parties";
import { aedFromOriginal, parseFxRateToScaled } from "@/lib/fx";
import { createTestCompany } from "@/server/books/test-company";
import { workerInvoiceFieldsJson } from "@/server/books/test-fixtures/worker-extraction";

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
     WHERE table_name = 'books_documents' AND column_name = 'check_vat_reason'`,
  );
  if (!col.rowCount) {
    t.skip("db/29 check_vat not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

async function uniqueSupplier(clientId: string, tag: string, trn: string | null) {
  const created = await createBooksParty(OMAR, clientId, {
    partyType: "supplier",
    name: `C1-2 Supplier ${tag}`,
    trn,
    force: true,
  });
  return String(created.id);
}

async function uniqueCustomer(clientId: string, tag: string) {
  const created = await createBooksParty(OMAR, clientId, {
    partyType: "customer",
    name: `C1-2 Customer ${tag}`,
    force: true,
  });
  return String(created.id);
}

type JLine = {
  accountCode: string;
  vatCode: string | null;
  debitMinor: number;
  creditMinor: number;
};

async function journalLines(admin: pg.Client, entryId: string): Promise<JLine[]> {
  const jl = await admin.query(
    `SELECT a.code AS "accountCode",
            COALESCE(l.vat_treatment, l.vat_code) AS "vatCode",
            l.debit_minor AS "debitMinor", l.credit_minor AS "creditMinor"
     FROM books_journal_lines l
     JOIN books_accounts a ON a.id = l.account_id
     WHERE l.entry_id = $1
     ORDER BY a.code, l.debit_minor DESC, l.credit_minor DESC`,
    [entryId],
  );
  return jl.rows.map((r) => ({
    accountCode: String(r.accountCode),
    vatCode: r.vatCode ? String(r.vatCode) : null,
    debitMinor: Number(r.debitMinor),
    creditMinor: Number(r.creditMinor),
  }));
}

function assertBalanced(lines: JLine[]) {
  const dr = lines.reduce((s, l) => s + l.debitMinor, 0);
  const cr = lines.reduce((s, l) => s + l.creditMinor, 0);
  assert.equal(dr, cr, `journal unbalanced Dr ${dr} ≠ Cr ${cr}`);
}

function assertHas(
  lines: JLine[],
  accountCode: string,
  debitMinor: number,
  creditMinor: number,
  vatCode?: string | null,
) {
  const hit = lines.find(
    (l) =>
      l.accountCode === accountCode &&
      l.debitMinor === debitMinor &&
      l.creditMinor === creditMinor &&
      (vatCode === undefined || l.vatCode === vatCode),
  );
  assert.ok(
    hit,
    `missing ${accountCode} Dr${debitMinor}/Cr${creditMinor}` +
      (vatCode !== undefined ? ` vat=${vatCode}` : "") +
      `; got ${lines.map((l) => `${l.accountCode}:${l.debitMinor}/${l.creditMinor}:${l.vatCode}`).join(" | ")}`,
  );
}

test("C1-2 case 1: mixed bill — disbursement 1220 + service expense + 1430", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const tag = `C1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueSupplier(clientId, tag, `100${Date.now().toString().slice(-10)}003`);

    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId,
      issueDate: "2026-05-10",
      periodId,
      documentNumber: `${tag}-MIX`,
      lines: [
        { description: "Gov fee", lineKind: "disbursement", netMinor: 2000, vatMinor: 0 },
        {
          description: "Professional service",
          lineKind: "expense",
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
        },
      ],
    });
    const posted = await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
    const lines = await journalLines(admin, String(posted.journalEntryId));
    assertBalanced(lines);
    assertHas(lines, "1220", 2000, 0);
    assertHas(lines, "6600", 10000, 0, "SR");
    assertHas(lines, "1430", 500, 0, "SR");
    assertHas(lines, "2110", 0, 12500);
    assert.ok(!lines.some((l) => l.accountCode === "2210"));
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-2 case 2: gov-authority bill no VAT — all lines 1220, no 1430", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const tag = `C2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueSupplier(clientId, tag, `100${Date.now().toString().slice(-10)}004`);

    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId,
      issueDate: "2026-05-11",
      periodId,
      documentNumber: `${tag}-GOV`,
      lines: [
        { description: "DED licence", lineKind: "disbursement", netMinor: 3000, vatMinor: 0 },
        { description: "Immigration fee", lineKind: "disbursement", netMinor: 1500, vatMinor: 0 },
      ],
    });
    const posted = await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
    const lines = await journalLines(admin, String(posted.journalEntryId));
    assertBalanced(lines);
    assertHas(lines, "1220", 3000, 0);
    assertHas(lines, "1220", 1500, 0);
    assertHas(lines, "2110", 0, 4500);
    assert.ok(!lines.some((l) => l.accountCode === "1430"));
    assert.ok(!lines.some((l) => l.accountCode === "6600"));
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-2 case 3: supplier TRN + service line no VAT → check_vat requires ack", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const tag = `C3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueSupplier(clientId, tag, `100${Date.now().toString().slice(-10)}005`);

    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId,
      issueDate: "2026-05-12",
      periodId,
      documentNumber: `${tag}-CHK`,
      lines: [
        {
          description: "Consulting (no VAT on line)",
          lineKind: "expense",
          vatCode: null,
          netMinor: 8000,
          vatMinor: 0,
        },
      ],
    });

    const got = await getBooksDocument(OMAR, clientId, String(doc.id));
    assert.ok(got.checkVatReason, "check_vat flag must be stored");
    assert.match(String(got.checkVatReason), /service_line_missing_vat/);
    assert.equal(got.checkVatAckAt, null);

    await assert.rejects(
      () => approveAndPostBooksDocument(LAYLA, clientId, String(doc.id)),
      (e: unknown) =>
        e instanceof BooksError &&
        e.code === "conflict" &&
        e.message === "check_vat_unacknowledged",
    );

    const still = await admin.query(
      `SELECT journal_entry_id, status FROM books_documents WHERE id = $1`,
      [doc.id],
    );
    assert.equal(still.rows[0].journal_entry_id, null);
    assert.equal(still.rows[0].status, "draft");

    const acked = await acknowledgeBooksDocumentCheckVat(OMAR, clientId, String(doc.id));
    assert.ok(acked.checkVatAckAt, "ack response must include timestamp");
    assert.equal(String(acked.checkVatAckBy), OMAR);

    const afterAck = await getBooksDocument(OMAR, clientId, String(doc.id));
    assert.ok(afterAck.checkVatAckAt, "ack must persist on document");
    assert.equal(String(afterAck.checkVatAckBy), OMAR);

    const audit = await admin.query(
      `SELECT action FROM books_audit_events
       WHERE client_id = $1 AND entity_id = $2 AND action = 'ack_check_vat'`,
      [clientId, doc.id],
    );
    assert.ok(audit.rowCount && audit.rowCount >= 1, "ack must be audited");

    const posted = await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
    assert.ok(posted.journalEntryId);
    const lines = await journalLines(admin, String(posted.journalEntryId));
    assertBalanced(lines);
    assert.ok(!lines.some((l) => l.accountCode === "1430"));
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-2 case 4: FX bill no TRN — VAT in cost; asset deposit → 1420", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const tag = `C4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueSupplier(clientId, tag, null);
    const rate = Number(parseFxRateToScaled("3.67"));

    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId,
      issueDate: "2026-05-13",
      periodId,
      documentNumber: `${tag}-FX`,
      currency: "USD",
      fxRateScaled: rate,
      lines: [
        {
          description: "Offshore service",
          lineKind: "expense",
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
          originalMinor: 10500,
          fxRateScaled: rate,
        },
        {
          description: "Refundable security deposit",
          lineKind: "asset",
          netMinor: 5000,
          vatMinor: 0,
          originalMinor: 5000,
          fxRateScaled: rate,
        },
      ],
    });
    const posted = await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
    const lines = await journalLines(admin, String(posted.journalEntryId));
    assertBalanced(lines);

    const expenseAed = aedFromOriginal(10000, rate) + aedFromOriginal(500, rate);
    const depositAed = aedFromOriginal(5000, rate);
    assertHas(lines, "6600", expenseAed, 0);
    assertHas(lines, "1420", depositAed, 0);
    assertHas(lines, "2110", 0, expenseAed + depositAed);
    assert.ok(!lines.some((l) => l.accountCode === "1430"), "no recoverable input VAT without TRN");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-2 case 5: USD sales — Arnifi Fee revenue+2210, Government Fee Cr 1220", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const tag = `C5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueCustomer(clientId, tag);
    const rate = Number(parseFxRateToScaled("3.67"));

    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId,
      issueDate: "2026-05-14",
      periodId,
      documentNumber: `${tag}-USD`,
      currency: "USD",
      fxRateScaled: rate,
      lines: [
        {
          description: "- Arnifi Fee",
          lineKind: "revenue",
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
          originalMinor: 10500,
          fxRateScaled: rate,
        },
        {
          description: "- Government Fee",
          lineKind: "disbursement",
          netMinor: 2000,
          vatMinor: 0,
          originalMinor: 2000,
          fxRateScaled: rate,
        },
      ],
    });
    const posted = await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
    const lines = await journalLines(admin, String(posted.journalEntryId));
    assertBalanced(lines);

    const feeNet = aedFromOriginal(10000, rate);
    const feeVat = aedFromOriginal(500, rate);
    const gov = aedFromOriginal(2000, rate);
    assertHas(lines, "4100", 0, feeNet, "SR");
    assertHas(lines, "2210", 0, feeVat, "SR");
    assertHas(lines, "1220", 0, gov);
    assertHas(lines, "1210", feeNet + feeVat + gov, 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-2 case 6: exempt residential lease — EX code, no 2210", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const tag = `C6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueCustomer(clientId, tag);

    const rental = await admin.query(
      `SELECT id FROM books_accounts WHERE client_id = $1 AND code = '4300'`,
      [clientId],
    );
    const rentalId = String(rental.rows[0].id);

    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "sales_invoice",
      partyId,
      issueDate: "2026-05-15",
      periodId,
      documentNumber: `${tag}-EX`,
      lines: [
        {
          description: "Residential lease — May",
          lineKind: "revenue",
          vatCode: "EX",
          accountId: rentalId,
          netMinor: 50000,
          vatMinor: 0,
        },
      ],
    });
    const posted = await approveAndPostBooksDocument(LAYLA, clientId, String(doc.id));
    const lines = await journalLines(admin, String(posted.journalEntryId));
    assertBalanced(lines);
    assertHas(lines, "4300", 0, 50000, "EX");
    assertHas(lines, "1210", 50000, 0);
    assert.ok(!lines.some((l) => l.accountCode === "2210"), "no output VAT on exempt");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-2 case 7: sales classified but uploaded under Purchases → sales_invoice draft", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const tag = `C7-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueCustomer(clientId, tag);

    const fileId = randomUUID();
    const inboxId = randomUUID();
    const extractionId = randomUUID();
    const sha = `c1-2-case7-${tag}`;

    await admin.query(
      `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,'application/pdf',100,$6)`,
      [fileId, clientId, sha, `books/${clientId}/${fileId}/synth.pdf`, `${tag}.pdf`, OMAR],
    );
    await admin.query(
      `INSERT INTO books_inbox_items (id, client_id, file_id, detected_type, status, intended_type)
       VALUES ($1,$2,$3,'sales_invoice','needs_review','purchase_bill')`,
      [inboxId, clientId, fileId],
    );
    await admin.query(
      `INSERT INTO books_extractions (
         id, client_id, file_id, inbox_item_id, doc_type, status, fields_json, validation_flags
       ) VALUES ($1,$2,$3,$4,'sales_invoice','needs_review',$5::jsonb,'[]'::jsonb)`,
      [
        extractionId,
        clientId,
        fileId,
        inboxId,
        JSON.stringify(
          workerInvoiceFieldsJson({
            invoiceNo: `${tag}-INV`,
            netMinor: 10000,
            vatMinor: 500,
            grossMinor: 10500,
          }),
        ),
      ],
    );

    const confirmed = await confirmInboxAsDocument(OMAR, clientId, inboxId, {
      partyId,
      periodId,
      docType: "purchase_bill",
      issueDate: "2026-05-16",
    });

    assert.equal(confirmed.docType, "sales_invoice");
    assert.equal(confirmed.reroutedFrom, "purchase_bill");
    assert.ok(confirmed.notice);

    const docRow = await admin.query(
      `SELECT doc_type, status FROM books_documents WHERE id = $1`,
      [confirmed.documentId],
    );
    assert.equal(docRow.rows[0].doc_type, "sales_invoice");
    assert.equal(docRow.rows[0].status, "draft");
    assert.notEqual(docRow.rows[0].doc_type, "purchase_bill");

    const purchaseCount = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_documents
       WHERE id = $1 AND doc_type = 'purchase_bill'`,
      [confirmed.documentId],
    );
    assert.equal(purchaseCount.rows[0].n, 0);

    const audit = await admin.query(
      `SELECT action, after_json FROM books_audit_events
       WHERE client_id = $1 AND entity_id = $2 AND action = 'reroute_doc_type'`,
      [clientId, confirmed.documentId],
    );
    assert.ok(audit.rowCount && audit.rowCount >= 1, "reroute must be audited");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

async function seedPurchaseConfirmFixture(
  admin: pg.Client,
  clientId: string,
  periodId: string,
  opts: { tag: string; detectedType: string | null; extractionDocType: string | null },
) {
  const partyId = await uniqueSupplier(clientId, opts.tag, `100${Date.now().toString().slice(-10)}007`);
  const fileId = randomUUID();
  const inboxId = randomUUID();
  const extractionId = randomUUID();
  const sha = `c1-2-${opts.tag}`;

  await admin.query(
    `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,'application/pdf',100,$6)`,
    [fileId, clientId, sha, `books/${clientId}/${fileId}/synth.pdf`, `${opts.tag}.pdf`, OMAR],
  );
  await admin.query(
    `INSERT INTO books_inbox_items (id, client_id, file_id, detected_type, status, intended_type)
     VALUES ($1,$2,$3,$4,'needs_review','purchase_bill')`,
    [inboxId, clientId, fileId, opts.detectedType],
  );
  await admin.query(
    `INSERT INTO books_extractions (
       id, client_id, file_id, inbox_item_id, doc_type, status, fields_json, validation_flags
     ) VALUES ($1,$2,$3,$4,$5,'needs_review',$6::jsonb,'[]'::jsonb)`,
    [
      extractionId,
      clientId,
      fileId,
      inboxId,
      opts.extractionDocType,
      JSON.stringify(
        workerInvoiceFieldsJson({
          invoiceNo: `${opts.tag}-INV`,
          netMinor: 10000,
          vatMinor: 500,
          grossMinor: 10500,
        }),
      ),
    ],
  );

  return { periodId, partyId, inboxId };
}

async function assertStaysPurchaseBill(
  admin: pg.Client,
  clientId: string,
  confirmed: Awaited<ReturnType<typeof confirmInboxAsDocument>>,
) {
  assert.equal(confirmed.docType, "purchase_bill");
  assert.equal(confirmed.reroutedFrom, null);

  const docRow = await admin.query(
    `SELECT doc_type FROM books_documents WHERE id = $1`,
    [confirmed.documentId],
  );
  assert.equal(docRow.rows[0].doc_type, "purchase_bill");

  const audit = await admin.query(
    `SELECT COUNT(*)::int AS n FROM books_audit_events
     WHERE client_id = $1 AND entity_id = $2 AND action = 'reroute_doc_type'`,
    [clientId, confirmed.documentId],
  );
  assert.equal(audit.rows[0].n, 0, "must not write reroute_doc_type audit");
}

test("C1-2 case 7b: unknown classification under Purchases stays purchase_bill", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const tag = `C7b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { periodId, partyId, inboxId } = await seedPurchaseConfirmFixture(admin, clientId, company.periods["May 2026"], {
      tag,
      detectedType: null,
      extractionDocType: null,
    });

    const confirmed = await confirmInboxAsDocument(OMAR, clientId, inboxId, {
      partyId,
      periodId,
      docType: "purchase_bill",
      issueDate: "2026-05-16",
    });

    await assertStaysPurchaseBill(admin, clientId, confirmed);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-2 case 7c: receipt classification under Purchases stays purchase_bill", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const tag = `C7c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { periodId, partyId, inboxId } = await seedPurchaseConfirmFixture(admin, clientId, company.periods["May 2026"], {
      tag,
      detectedType: "receipt",
      extractionDocType: "receipt",
    });

    const confirmed = await confirmInboxAsDocument(OMAR, clientId, inboxId, {
      partyId,
      periodId,
      docType: "purchase_bill",
      issueDate: "2026-05-16",
    });

    await assertStaysPurchaseBill(admin, clientId, confirmed);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-2 case 7d: purchase_bill classification under Purchases stays purchase_bill", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const tag = `C7d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { periodId, partyId, inboxId } = await seedPurchaseConfirmFixture(admin, clientId, company.periods["May 2026"], {
      tag,
      detectedType: "purchase_bill",
      extractionDocType: "purchase_bill",
    });

    const confirmed = await confirmInboxAsDocument(OMAR, clientId, inboxId, {
      partyId,
      periodId,
      docType: "purchase_bill",
      issueDate: "2026-05-16",
    });

    await assertStaysPurchaseBill(admin, clientId, confirmed);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("C1-2 case 8: multi-line VAT > 5% → vat_exceeds_rate, nothing posted", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "c1-2");
    const clientId = company.clientId;
    const periodId = company.periods["May 2026"];
    const tag = `C8-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partyId = await uniqueSupplier(clientId, tag, `100${Date.now().toString().slice(-10)}008`);

    const doc = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId,
      issueDate: "2026-05-17",
      periodId,
      documentNumber: `${tag}-VAT`,
      lines: [
        {
          description: "Line A",
          lineKind: "expense",
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
        },
        {
          description: "Line B tax larger than subtotal share",
          lineKind: "expense",
          vatCode: "SR",
          netMinor: 1000,
          vatMinor: 2000,
        },
      ],
    });

    await assert.rejects(
      () => approveAndPostBooksDocument(LAYLA, clientId, String(doc.id)),
      (e: unknown) =>
        e instanceof BooksError && e.code === "conflict" && e.message === "vat_exceeds_rate",
    );

    const row = await admin.query(
      `SELECT journal_entry_id, status FROM books_documents WHERE id = $1`,
      [doc.id],
    );
    assert.equal(row.rows[0].journal_entry_id, null, "no journal must exist");
    assert.equal(row.rows[0].status, "draft");

    const journals = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_journal_entries e
       JOIN books_documents d ON d.journal_entry_id = e.id
       WHERE d.id = $1`,
      [doc.id],
    );
    assert.equal(journals.rows[0].n, 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
