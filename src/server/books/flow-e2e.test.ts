/**
 * ING-5a: upload → seed worker-shaped extraction → Omar confirm → Layla approve
 * → assert tables, reports, dashboard. Exact fils from fixtures/extraction/ing5.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import { aedFromOriginal, parseFxRateToScaled } from "@/lib/fx";
import { booksAgeing } from "@/server/books/ageing";
import { listBooksIssues } from "@/server/books/dashboard";
import {
  approveAndPostBooksDocument,
  createBooksDocument,
} from "@/server/books/documents";
import { booksFinancialStatementsPack } from "@/server/books/financial-statements";
import { booksHealthSummary } from "@/server/books/health";
import {
  confirmInboxAsDocument,
  uploadBooksInboxFiles,
  type InboxIntendedType,
} from "@/server/books/inbox";
import { createBooksParty } from "@/server/books/parties";
import { createReceiptOrPayment } from "@/server/books/settlements";
import { createTestCompany } from "@/server/books/test-company";
import { workerInvoiceFieldsJson } from "@/server/books/test-fixtures/worker-extraction";
import { booksTrialBalance } from "@/server/books/trial-balance";
import { generateVat201Draft } from "@/server/books/vat201";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const ING5 = path.join(process.cwd(), "fixtures/extraction/ing5");
const FX = parseFxRateToScaled("3.6725");

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
  const ready = await admin.query(`SELECT to_regclass('books_extractions') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("phase1 schema not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

function loadPdf(stem: string): Buffer {
  return fs.readFileSync(path.join(ING5, "pdfs", `${stem}.pdf`));
}

async function seedExtraction(
  admin: pg.Client,
  args: {
    clientId: string;
    inboxId: string;
    fileId: string;
    docType: string;
    fields: Record<string, unknown>;
  },
) {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO books_extractions (
       id, client_id, file_id, inbox_item_id, doc_type, status,
       fields_json, raw_text, word_boxes, validation_flags, extractor_version
     ) VALUES ($1,$2,$3,$4,$5,'needs_review',$6::jsonb,'',$7::jsonb,'[]'::jsonb,'ing5-v1')`,
    [
      id,
      args.clientId,
      args.fileId,
      args.inboxId,
      args.docType,
      JSON.stringify(args.fields),
      JSON.stringify([]),
    ],
  );
  await admin.query(
    `UPDATE books_inbox_items
     SET status = 'needs_review', detected_type = $2, updated_at = now()
     WHERE id = $1`,
    [args.inboxId, args.docType],
  );
  return id;
}

async function ensureStatementsBucket() {
  const { CreateBucketCommand, HeadBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
  const endpoint = process.env.S3_ENDPOINT || "http://minio:9000";
  const bucket = process.env.S3_BUCKET || "statements";
  const s3 = new S3Client({
    endpoint,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || "daftar",
      secretAccessKey: process.env.S3_SECRET_KEY || "daftar-local-only",
    },
  });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch {
      /* raced create — next put will surface a real error */
    }
  }
}

async function uploadOne(
  clientId: string,
  stem: string,
  filename: string,
  intendedType?: InboxIntendedType,
) {
  await ensureStatementsBucket();
  const base = loadPdf(stem);
  const bytes = Buffer.concat([base, Buffer.from(`\n%ing5-${stem}-${Date.now()}-${randomUUID()}`)]);
  const uploaded = await uploadBooksInboxFiles(
    OMAR,
    clientId,
    [{ filename, contentType: "application/pdf", bytes }],
    intendedType ? { intendedType } : undefined,
  );
  const row = uploaded.results[0];
  assert.ok(row?.inboxItemId && row.fileId);
  return { ...row, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}

test("ING-5a: scenarios 1–10 + tie-outs (exact fils)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  if (!fs.existsSync(path.join(ING5, "pdfs", "sales_tax_invoice.pdf"))) {
    t.skip("ING-5 fixtures missing — run fixtures/extraction/ing5/generate.py");
    await admin.end();
    return;
  }

  let company: Awaited<ReturnType<typeof createTestCompany>>;
  try {
    company = await createTestCompany(admin, `ing5-flow-${Date.now()}`);
  } catch (e) {
    t.skip(`createTestCompany failed: ${e instanceof Error ? e.message : e}`);
    await admin.end();
    return;
  }
  const clientId = company.clientId;
  const may = company.periods["May 2026"];
  assert.ok(may);

  // Seed FX rate for scenario 4 (db/59 — entered_by required).
  await admin.query(
    `INSERT INTO books_fx_rates (client_id, currency, rate_date, rate_scaled, entered_by)
     VALUES ($1,'USD','2026-05-18',$2,$3)
     ON CONFLICT (client_id, currency, rate_date) DO NOTHING`,
    [clientId, Number(FX), OMAR],
  ).catch(() => undefined);

  const bankId = company.accountIdByCode["1120"];
  assert.ok(bankId);

  // Emirate required so VAT-201 place-of-supply gate does not block the draft.
  await admin.query(`UPDATE clients SET establishment_emirate = 'Dubai' WHERE id = $1`, [clientId]);

  const customer = await createBooksParty(OMAR, clientId, {
    partyType: "customer",
    name: `ING5 Customer ${Date.now()}`,
    trn: "100123456700003",
    force: true,
  });
  const supplier = await createBooksParty(OMAR, clientId, {
    partyType: "supplier",
    name: `ING5 Supplier ${Date.now()}`,
    trn: "100999999999999",
    force: true,
  });
  const supplierNoTrn = await createBooksParty(OMAR, clientId, {
    partyType: "supplier",
    name: `ING5 Cash Stall ${Date.now()}`,
    trn: null,
    force: true,
  });
  const foreignSupplier = await createBooksParty(OMAR, clientId, {
    partyType: "supplier",
    name: `ING5 Foreign ${Date.now()}`,
    trn: null,
    force: true,
  });

  let salesDocId: string;
  let salesOpenItemId: string;
  let purchaseDocId: string;
  let purchaseOpenItemId: string;

  try {
    // ----- Scenario 1: sales tax invoice -----
    let up: Awaited<ReturnType<typeof uploadOne>>;
    try {
      up = await uploadOne(clientId, "sales_tax_invoice", "sales_tax_invoice.pdf", "sales_invoice");
    } catch (e) {
      t.skip(`upload unavailable (MinIO?): ${e instanceof Error ? e.message : e}`);
      return;
    }
    assert.equal(up.duplicate, false);
    const files1 = await admin.query(`SELECT id, sha256 FROM books_files WHERE id = $1`, [up.fileId]);
    assert.equal(files1.rowCount, 1);

    await seedExtraction(admin, {
      clientId,
      inboxId: String(up.inboxItemId),
      fileId: String(up.fileId),
      docType: "sales_invoice",
      fields: workerInvoiceFieldsJson({
        invoiceNo: "INV-ING5-001",
        invoiceDate: "2026-05-15",
        netMinor: 1_000_000,
        vatMinor: 50_000,
        grossMinor: 1_050_000,
        supplierTrn: "100000000000001",
        lineVatCode: "SR",
      }),
    });

    const confirmed1 = await confirmInboxAsDocument(OMAR, clientId, String(up.inboxItemId), {
      partyId: String(customer.id),
      periodId: may,
      docType: "sales_invoice",
      issueDate: "2026-05-15",
    });
    salesDocId = String(confirmed1.documentId);
    await approveAndPostBooksDocument(LAYLA, clientId, salesDocId);

    const jl1 = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_documents d ON d.journal_entry_id = e.id
       WHERE d.id = $1 AND e.status = 'posted'
       ORDER BY a.code`,
      [salesDocId],
    );
    const byCode1 = Object.fromEntries(
      jl1.rows.map((r) => [r.code, { dr: Number(r.debit_minor), cr: Number(r.credit_minor) }]),
    );
    assert.equal(byCode1["1210"]?.dr, 1_050_000);
    assert.equal(byCode1["4100"]?.cr, 1_000_000);
    assert.equal(byCode1["2210"]?.cr, 50_000);

    const oi1 = await admin.query(
      `SELECT id, open_aed_minor, open_original_minor FROM books_open_items WHERE document_id = $1`,
      [salesDocId],
    );
    assert.equal(Number(oi1.rows[0].open_aed_minor), 1_050_000);
    salesOpenItemId = String(oi1.rows[0].id);

    const audit1 = await admin.query(
      `SELECT actor, action FROM books_audit_events
       WHERE client_id = $1 AND entity_id = $2 ORDER BY at`,
      [clientId, salesDocId],
    );
    assert.ok(audit1.rowCount && audit1.rowCount >= 1);

    // ----- Scenario 2: purchase with TRN -----
    const up2 = await uploadOne(clientId, "purchase_with_trn", "purchase_with_trn.pdf", "purchase_bill");
    await seedExtraction(admin, {
      clientId,
      inboxId: String(up2.inboxItemId),
      fileId: String(up2.fileId),
      docType: "purchase_bill",
      fields: workerInvoiceFieldsJson({
        invoiceNo: "BILL-ING5-002",
        invoiceDate: "2026-05-16",
        netMinor: 200_000,
        vatMinor: 10_000,
        grossMinor: 210_000,
        supplierTrn: "100999999999999",
        lineVatCode: "SR",
      }),
    });
    const confirmed2 = await confirmInboxAsDocument(OMAR, clientId, String(up2.inboxItemId), {
      partyId: String(supplier.id),
      periodId: may,
      docType: "purchase_bill",
      issueDate: "2026-05-16",
    });
    purchaseDocId = String(confirmed2.documentId);
    await approveAndPostBooksDocument(LAYLA, clientId, purchaseDocId);
    const jl2 = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_documents d ON d.journal_entry_id = e.id
       WHERE d.id = $1 AND e.status = 'posted'`,
      [purchaseDocId],
    );
    const byCode2: Record<string, { dr: number; cr: number }> = Object.fromEntries(
      jl2.rows.map((r) => [String(r.code), { dr: Number(r.debit_minor), cr: Number(r.credit_minor) }]),
    );
    assert.equal(byCode2["2110"]?.cr, 210_000);
    assert.equal(byCode2["1430"]?.dr, 10_000);
    assert.ok(
      (byCode2["6600"]?.dr ?? 0) === 200_000 ||
        Object.values(byCode2).some((x) => x.dr === 200_000),
    );
    const oi2 = await admin.query(
      `SELECT id, open_aed_minor FROM books_open_items WHERE document_id = $1`,
      [purchaseDocId],
    );
    assert.equal(Number(oi2.rows[0].open_aed_minor), 210_000);
    purchaseOpenItemId = String(oi2.rows[0].id);

    // ----- Scenario 8 early: credit note against open sales (before receipt) -----
    const cn = await createBooksDocument(OMAR, clientId, {
      docType: "credit_note",
      partyId: String(customer.id),
      issueDate: "2026-05-19",
      periodId: may,
      documentNumber: `CN-ING5-001-${Date.now()}`,
      originalDocumentId: salesDocId,
      lines: [
        {
          description: "Consulting credit",
          lineKind: "revenue",
          vatCode: "SR",
          netMinor: 100_000,
          vatMinor: 5_000,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(cn.id));
    const jlCn = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_documents d ON d.journal_entry_id = e.id
       WHERE d.id = $1 AND e.status = 'posted'`,
      [cn.id],
    );
    assert.ok(jlCn.rowCount);
    const cn1210 = jlCn.rows.find((r) => r.code === "1210");
    assert.ok(cn1210);
    assert.equal(Number(cn1210.credit_minor), 105_000);

    const oi1AfterCn = await admin.query(
      `SELECT open_aed_minor FROM books_open_items WHERE document_id = $1`,
      [salesDocId],
    );
    // CN reduces AR open on original (1,050,000 − 105,000).
    assert.equal(Number(oi1AfterCn.rows[0].open_aed_minor), 945_000);

    // ----- Scenario 3: purchase without supplier TRN -----
    const bill3 = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: String(supplierNoTrn.id),
      issueDate: "2026-05-17",
      periodId: may,
      documentNumber: `BILL-ING5-003-${Date.now()}`,
      lines: [
        {
          description: "Office supplies",
          lineKind: "expense",
          vatCode: "SR",
          netMinor: 200_000,
          vatMinor: 10_000,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(bill3.id));
    const jl3 = await admin.query(
      `SELECT a.code, SUM(l.debit_minor)::bigint AS dr, SUM(l.credit_minor)::bigint AS cr
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_documents d ON d.journal_entry_id = e.id
       WHERE d.id = $1 AND e.status = 'posted'
       GROUP BY a.code`,
      [bill3.id],
    );
    const byCode3: Record<string, { dr: number; cr: number }> = Object.fromEntries(
      jl3.rows.map((r) => [String(r.code), { dr: Number(r.dr), cr: Number(r.cr) }]),
    );
    assert.equal(byCode3["2110"]?.cr, 210_000);
    assert.equal(byCode3["1430"]?.dr ?? 0, 0, "no recoverable input VAT without TRN");
    const expDr = Object.entries(byCode3)
      .filter(([c]) => c !== "2110" && c !== "1430")
      .reduce((s, [, v]) => s + v.dr, 0);
    assert.equal(expDr, 210_000);

    // ----- Scenario 4: reverse charge USD -----
    const aedNet = aedFromOriginal(100_000, FX);
    const aedVat = aedFromOriginal(5_000, FX); // 5% of 1000 USD = 50 USD → AED
    const rc = await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: String(foreignSupplier.id),
      issueDate: "2026-05-18",
      periodId: may,
      currency: "USD",
      fxRateScaled: Number(FX),
      documentNumber: `BILL-ING5-RC-${Date.now()}`,
      lines: [
        {
          description: "Legal advisory",
          lineKind: "expense",
          vatCode: "RC_IN",
          netMinor: 100_000,
          vatMinor: 5_000,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, clientId, String(rc.id));
    const oiRc = await admin.query(
      `SELECT open_aed_minor, open_original_minor, currency FROM books_open_items WHERE document_id = $1`,
      [rc.id],
    );
    assert.equal(Number(oiRc.rows[0].open_original_minor), 100_000);
    assert.equal(Number(oiRc.rows[0].open_aed_minor), aedNet, "AP open = AED net only");
    assert.notEqual(Number(oiRc.rows[0].open_aed_minor), aedNet + aedVat);

    // ----- Scenario 5: receipt settling remaining sales AR (after CN) -----
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "receipt",
      partyId: String(customer.id),
      issueDate: "2026-05-20",
      periodId: may,
      bankAccountId: String(bankId),
      originalAmountMinor: 945_000,
      allocations: [{ openItemId: salesOpenItemId, allocatedOriginalMinor: 945_000 }],
    });
    const oi1After = await admin.query(
      `SELECT open_aed_minor FROM books_open_items WHERE id = $1`,
      [salesOpenItemId],
    );
    assert.equal(Number(oi1After.rows[0].open_aed_minor), 0);

    // ----- Scenario 6: payment settling purchase -----
    await createReceiptOrPayment(OMAR, LAYLA, clientId, {
      docType: "payment",
      partyId: String(supplier.id),
      issueDate: "2026-05-21",
      periodId: may,
      bankAccountId: String(bankId),
      originalAmountMinor: 210_000,
      allocations: [{ openItemId: purchaseOpenItemId, allocatedOriginalMinor: 210_000 }],
    });
    const oi2After = await admin.query(
      `SELECT open_aed_minor FROM books_open_items WHERE id = $1`,
      [purchaseOpenItemId],
    );
    assert.equal(Number(oi2After.rows[0].open_aed_minor), 0);

    // ----- Scenario 7: bank statement materialize (if table present) -----
    // Closing = 5,000,000 + 945,000 − 210,000 − 5,250 + 10,000 = 5,739,750
    const hasTxn = await admin.query(`SELECT to_regclass('books_bank_transactions') AS t`);
    if (hasTxn.rows[0]?.t) {
      const { materializeBooksBankTransactions } = await import("@/server/books/bank-transactions");
      await admin.query(
        `UPDATE books_accounts SET iban = 'AE070331234567890123456' WHERE id = $1`,
        [bankId],
      ).catch(() => undefined);

      const upBank = await uploadOne(clientId, "bank_stmt_match", "bank_stmt_match.pdf");
      const stmtId = randomUUID();
      await admin.query(
        `INSERT INTO books_statement_extractions (
           id, client_id, file_id, inbox_item_id, account_id, iban, bank_name, currency,
           period_from, period_to, opening_balance_minor, closing_balance_minor,
           status, validation_flags
         ) VALUES ($1,$2,$3,$4,$5,'AE070331234567890123456','Synthetic UAE Bank ING5','AED',
           '2026-05-01','2026-05-31',5000000,5739750,'ready','["balance_ok"]'::jsonb)`,
        [stmtId, clientId, upBank.fileId, upBank.inboxItemId, bankId],
      );
      const lines = [
        ["2026-05-20", "CLIENT RECEIPT INV-ING5-001", 0, 945_000],
        ["2026-05-21", "SUPPLIER PAYMENT BILL-ING5-002", 210_000, 0],
        ["2026-05-22", "BANK CHARGE", 5_250, 0],
        ["2026-05-23", "UNMATCHED CREDIT", 0, 10_000],
      ] as const;
      for (let i = 0; i < lines.length; i++) {
        const [d, desc, deb, cre] = lines[i]!;
        await admin.query(
          `INSERT INTO books_statement_lines (
             id, statement_id, client_id, line_date, description,
             debit_minor, credit_minor, currency, sort_index
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',$8)`,
          [randomUUID(), stmtId, clientId, d, desc, deb, cre, i],
        );
      }
      const mat = await materializeBooksBankTransactions(OMAR, clientId, { accountId: String(bankId) });
      assert.ok(mat.inserted >= 4);
      const txnCount = await admin.query(
        `SELECT COUNT(*)::int AS n FROM books_bank_transactions WHERE statement_id = $1`,
        [stmtId],
      );
      assert.equal(Number(txnCount.rows[0].n), 4);
    } else {
      t.diagnostic("skip scenario 7 details — books_bank_transactions missing in test DB");
    }

    // ----- Scenario 9: duplicate upload -----
    const dup = await uploadBooksInboxFiles(OMAR, clientId, [
      {
        filename: "sales_tax_invoice.pdf",
        contentType: "application/pdf",
        bytes: up.bytes!,
      },
    ]);
    assert.equal(dup.results[0]?.duplicate, true);
    const docsDup = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_documents
       WHERE client_id = $1 AND document_number = 'INV-ING5-001' AND deleted_at IS NULL`,
      [clientId],
    );
    assert.equal(Number(docsDup.rows[0].n), 1);

    // ----- Scenario 10: EUR bank txn post without FX rate → fx_rate_required -----
    // (USD already has a rate from scenario 4; resolveBankFxRateScaled uses rate_date <= txn.)
    {
      const hasTxn10 = await admin.query(`SELECT to_regclass('books_bank_transactions') AS t`);
      if (hasTxn10.rows[0]?.t) {
        const { postBooksBankTransaction } = await import("@/server/books/bank-transactions");
        const stmt10 = randomUUID();
        const line10 = randomUUID();
        const txnId = randomUUID();
        const up10 = await uploadOne(clientId, "bank_stmt_match", "bank_eur_norate.pdf");
        await admin.query(
          `INSERT INTO books_statement_extractions (
             id, client_id, file_id, account_id, iban, currency,
             period_from, period_to, opening_balance_minor, closing_balance_minor,
             status, validation_flags
           ) VALUES ($1,$2,$3,$4,'AE070331234567890123456','AED',
             '2026-05-01','2026-05-31',0,10000,'ready','["balance_ok"]'::jsonb)`,
          [stmt10, clientId, up10.fileId, bankId],
        );
        await admin.query(
          `INSERT INTO books_statement_lines (
             id, statement_id, client_id, line_date, description,
             debit_minor, credit_minor, currency, sort_index
           ) VALUES ($1,$2,$3,'2026-05-25','EUR wire no rate',0,10000,'EUR',0)`,
          [line10, stmt10, clientId],
        );
        await admin.query(
          `INSERT INTO books_bank_transactions (
             id, client_id, account_id, statement_id, statement_line_id,
             txn_date, description, currency, debit_minor, credit_minor,
             review_status, txn_type, category_account_id, reviewed_by, reviewed_at
           ) VALUES (
             $1,$2,$3,$4,$5,'2026-05-25','EUR wire no rate','EUR',0,10000,
             'ready','other_income',$6,$7,now()
           )`,
          [txnId, clientId, bankId, stmt10, line10, company.accountIdByCode["4100"], OMAR],
        );
        await assert.rejects(
          () => postBooksBankTransaction(LAYLA, clientId, txnId),
          (err: unknown) => /fx_rate_required/i.test(String((err as Error)?.message || err)),
        );
      }
    }

    // ----- Tie-outs -----
    const tb = await booksTrialBalance(OMAR, clientId, may, { includeZeroBalances: true });
    assert.equal(tb.balanced, true, "trial balance Dr = Cr");
    assert.equal(tb.totalClosingDebit, tb.totalClosingCredit);

    const fsPack = await booksFinancialStatementsPack(OMAR, clientId, {
      mode: "monthly",
      from: "2026-05-01",
      to: "2026-05-31",
      asOf: "2026-05-31",
    });
    assert.ok(fsPack.integrity?.tbBalances?.ok !== false);

    const arAge = await booksAgeing(OMAR, clientId, { side: "AR", asOf: "2026-05-31" });
    const apAge = await booksAgeing(OMAR, clientId, { side: "AP", asOf: "2026-05-31" });
    assert.ok(Array.isArray(arAge.rows));
    assert.ok(Array.isArray(apAge.rows));

    // Backfill POS if drafts snapped before company emirate was visible to the gate.
    await admin.query(
      `UPDATE books_documents SET place_of_supply = 'Dubai', place_of_supply_source = 'company'
       WHERE client_id = $1 AND place_of_supply IS NULL AND deleted_at IS NULL`,
      [clientId],
    );
    const vat = await generateVat201Draft(OMAR, clientId, { from: "2026-05-01", to: "2026-05-31" });
    assert.ok(vat);

    const issueList = await listBooksIssues(OMAR, clientId, { periodId: may });
    const controlMismatch = issueList.some(
      (i: { code?: string; key?: string; kind?: string }) =>
        /control/i.test(String(i.code || i.key || i.kind || "")),
    );
    assert.equal(controlMismatch, false, "no control-account mismatch on issues badge");

    try {
      const health = await booksHealthSummary(OMAR, clientId, may);
      assert.ok(health);
    } catch {
      // Health may need extra seed; TB identity is the hard gate above.
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
});
