import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { aedFromOriginal } from "@/lib/fx";
import { assertMinor } from "@/lib/money";
import { writeBooksAudit } from "@/server/books/audit";
import { requireDualControlActor } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { upsertOpenItemFromDocument } from "@/server/books/open-items";
import { enqueueBooksJob } from "@/server/books/jobs";
import { vatMinorForNet } from "@/server/books/vat-codes";
import { assertSyntheticTenant } from "@/server/security-gate";

export type DocLineInput = {
  description?: string;
  quantityScaled?: number;
  unitPriceMinor?: number;
  lineKind?: "revenue" | "disbursement" | "taxable_recharge" | "expense" | "asset" | "inventory";
  accountId?: string | null;
  vatCode?: string | null;
  netMinor: number;
  vatMinor?: number;
  currency?: string;
  originalMinor?: number | null;
  fxRateScaled?: number | null;
  tags?: string[];
};

export type DocumentInput = {
  docType: "sales_invoice" | "purchase_bill" | "credit_note" | "debit_note";
  partyId: string;
  issueDate: string;
  dueDate?: string | null;
  serviceStart?: string | null;
  serviceEnd?: string | null;
  deferRevenue?: boolean | null;
  currency?: string;
  fxRateScaled?: number;
  documentNumber?: string | null;
  memo?: string;
  /** C1b: required when recording a sales invoice manually (no upload/extraction). */
  manualRecordReason?: string | null;
  /** Set to "manual" from the Sales "Record manually" UI (not inbox confirm / fixtures). */
  recordSource?: "manual" | "upload" | "test" | null;
  originalDocumentId?: string | null;
  periodId: string;
  lines: DocLineInput[];
  forceDuplicate?: boolean;
  /** Printed/extracted totals (document currency). Info for UI; server gates Approve. */
  printedNetMinor?: number | null;
  printedVatMinor?: number | null;
  printedGrossMinor?: number | null;
  /** Info only — never creates a receipt/payment or allocation. */
  printedPaidMinor?: number | null;
  printedBalanceDueMinor?: number | null;
  extractionId?: string | null;
  fileId?: string | null;
};

function optionalMinor(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return assertMinor(value);
}

/** Intentional zero-VAT codes — do not raise check_vat. */
const ZERO_VAT_OK = new Set(["ZR", "EX", "OS", "RC_IN", "RC_OUT"]);

/**
 * Supplier has TRN but a service/expense line carries no VAT and no intentional zero code.
 * Returns a short reason string or null.
 */
export function detectCheckVatReason(
  docType: string,
  supplierTrn: string | null | undefined,
  lines: Array<{ lineKind?: string | null; vatCode?: string | null; vatMinor?: number | null }>,
): string | null {
  if (docType !== "purchase_bill" && docType !== "debit_note") return null;
  if (!supplierTrn || !String(supplierTrn).trim()) return null;
  const bad: number[] = [];
  lines.forEach((line, idx) => {
    const kind = line.lineKind || "expense";
    if (kind === "disbursement" || kind === "asset" || kind === "inventory") return;
    const vat = Number(line.vatMinor || 0);
    const code = line.vatCode ? String(line.vatCode) : null;
    if (vat === 0 && (!code || !ZERO_VAT_OK.has(code))) {
      bad.push(idx + 1);
    }
  });
  if (!bad.length) return null;
  return `service_line_missing_vat:lines=${bad.join(",")}`;
}

async function accountIdByCode(db: PoolClient, clientId: string, code: string) {
  const row = await db.query(
    `SELECT id FROM books_accounts WHERE client_id = $1 AND code = $2 AND active = true`,
    [clientId, code],
  );
  if (!row.rowCount) throw new BooksError(`account_missing:${code}`, "not_found");
  return String(row.rows[0].id);
}

async function vatRateBp(
  db: PoolClient,
  code: string | null | undefined,
): Promise<{ rateBp: number; recoverable: boolean }> {
  if (!code) return { rateBp: 0, recoverable: false };
  const row = await db.query(`SELECT rate_bp, recoverable FROM books_vat_codes WHERE code = $1`, [
    code,
  ]);
  if (!row.rowCount) throw new BooksError("invalid_vat_code", "invalid");
  return { rateBp: Number(row.rows[0].rate_bp), recoverable: Boolean(row.rows[0].recoverable) };
}

function monthsSpan(start: string, end: string): number {
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  return (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + 1;
}

function normalizeLines(lines: DocLineInput[], fxRateScaled: number, currency: string) {
  return lines.map((line, idx) => {
    const net = assertMinor(line.netMinor) ?? 0;
    if (net < 0) throw new BooksError("negative_line", "invalid_money");
    const kind = line.lineKind || "revenue";
    let vat = line.vatMinor ?? 0;
    if (kind === "disbursement") vat = 0;
    const gross = net + vat;
    const original = line.originalMinor ?? (currency === "AED" ? gross : null);
    const aed =
      currency === "AED"
        ? gross
        : aedFromOriginal(original ?? gross, line.fxRateScaled ?? fxRateScaled);
    return {
      lineNo: idx + 1,
      description: line.description || "",
      quantityScaled: line.quantityScaled ?? 1000,
      unitPriceMinor: line.unitPriceMinor ?? net,
      lineKind: kind,
      accountId: line.accountId || null,
      vatCode: kind === "disbursement" ? null : line.vatCode || null,
      netMinor: net,
      vatMinor: vat,
      grossMinor: gross,
      currency,
      originalMinor: original,
      fxRateScaled: line.fxRateScaled ?? fxRateScaled,
      aedMinor: aed,
      tags: line.tags || [],
    };
  });
}

export async function listBooksDocuments(
  userId: string,
  clientId: string,
  opts?: { docType?: string; status?: string; q?: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT d.id, d.doc_type AS "docType", d.doc_kind AS "docKind", d.status,
              d.document_number AS "documentNumber", d.issue_date AS "issueDate",
              d.due_date AS "dueDate", d.currency, d.gross_minor AS "grossMinor",
              d.aed_total_minor AS "aedTotalMinor", d.vat_minor AS "vatMinor",
              d.journal_entry_id AS "journalEntryId", d.defer_revenue AS "deferRevenue",
              p.name AS "partyName", p.id AS "partyId",
              oi.open_aed_minor AS "outstandingMinor"
       FROM books_documents d
       LEFT JOIN books_parties p ON p.id = d.party_id
       LEFT JOIN books_open_items oi ON oi.document_id = d.id AND oi.client_id = d.client_id
       WHERE d.client_id = $1 AND d.deleted_at IS NULL
         AND ($2::text IS NULL OR d.doc_type = $2)
         AND ($3::text IS NULL OR d.status = $3)
         AND ($4::text IS NULL OR d.document_number ILIKE '%' || $4 || '%' OR p.name ILIKE '%' || $4 || '%')
       ORDER BY d.issue_date DESC NULLS LAST, d.created_at DESC`,
      [clientId, opts?.docType || null, opts?.status || null, opts?.q?.trim() || null],
    );
    return rows.rows;
  });
}

export async function getBooksDocument(userId: string, clientId: string, documentId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const doc = await db.query(
      `SELECT d.*, p.name AS party_name
       FROM books_documents d
       LEFT JOIN books_parties p ON p.id = d.party_id
       WHERE d.id = $1 AND d.client_id = $2 AND d.deleted_at IS NULL`,
      [documentId, clientId],
    );
    if (!doc.rowCount) throw new BooksError("document_not_found", "not_found");
    const lines = await db.query(
      `SELECT id, line_no AS "lineNo", description, quantity_scaled AS "quantityScaled",
              unit_price_minor AS "unitPriceMinor", line_kind AS "lineKind",
              account_id AS "accountId", vat_code AS "vatCode",
              net_minor AS "netMinor", vat_minor AS "vatMinor", gross_minor AS "grossMinor",
              currency, original_minor AS "originalMinor", fx_rate_scaled AS "fxRateScaled",
              aed_minor AS "aedMinor", tags
       FROM books_document_lines WHERE document_id = $1 ORDER BY line_no`,
      [documentId],
    );
    const d = doc.rows[0];
    return {
      ...d,
      id: String(d.id),
      partyId: d.party_id == null ? null : String(d.party_id),
      docType: String(d.doc_type),
      issueDate: d.issue_date == null ? null : String(d.issue_date).slice(0, 10),
      currency: String(d.currency || "AED"),
      status: String(d.status),
      printedNetMinor: d.printed_net_minor == null ? null : Number(d.printed_net_minor),
      printedVatMinor: d.printed_vat_minor == null ? null : Number(d.printed_vat_minor),
      printedGrossMinor: d.printed_gross_minor == null ? null : Number(d.printed_gross_minor),
      printedPaidMinor: d.printed_paid_minor == null ? null : Number(d.printed_paid_minor),
      printedBalanceDueMinor:
        d.printed_balance_due_minor == null ? null : Number(d.printed_balance_due_minor),
      checkVatReason: d.check_vat_reason == null ? null : String(d.check_vat_reason),
      checkVatAckBy: d.check_vat_ack_by == null ? null : String(d.check_vat_ack_by),
      checkVatAckAt: d.check_vat_ack_at == null ? null : d.check_vat_ack_at,
      netMinor: Number(d.net_minor),
      vatMinor: Number(d.vat_minor),
      grossMinor: Number(d.gross_minor),
      lines: lines.rows,
    };
  });
}

export async function createBooksDocument(userId: string, clientId: string, body: DocumentInput) {
  if (!body.lines?.length) throw new BooksError("lines_required", "invalid");
  if (!body.partyId?.trim()) throw new BooksError("party_required", "invalid");
  const currency = (body.currency || "AED").toUpperCase();
  const fxRateScaled = body.fxRateScaled ?? 100000000;

  // C1b record-only: Sales UI "Record manually" must send reason + printed invoice no.
  // Inbox confirm (extractionId/fileId) and synthetic fixtures are exempt.
  if (
    body.docType === "sales_invoice" &&
    body.recordSource === "manual" &&
    !body.extractionId &&
    !body.fileId
  ) {
    if (!body.documentNumber?.trim()) {
      throw new BooksError("document_number_required", "invalid");
    }
    if (!body.manualRecordReason?.trim()) {
      throw new BooksError("manual_record_requires_reason", "invalid");
    }
  }

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!body.periodId) throw new BooksError("period_required", "invalid");
    const party = await db.query(
      `SELECT id, party_type, trn FROM books_parties WHERE id = $1 AND client_id = $2`,
      [body.partyId, clientId],
    );
    if (!party.rowCount) throw new BooksError("party_not_found", "not_found");

    // Compute VAT where missing
    const withVat: DocLineInput[] = [];
    for (const line of body.lines) {
      const kind = line.lineKind || "revenue";
      let vatCode = line.vatCode || null;
      if (kind === "disbursement") vatCode = null;
      if (kind === "taxable_recharge" && !vatCode) vatCode = "SR";
      let vatMinor = line.vatMinor;
      if (vatMinor == null && vatCode && kind !== "disbursement") {
        const { rateBp } = await vatRateBp(db, vatCode);
        vatMinor = vatMinorForNet(line.netMinor, rateBp);
      }
      withVat.push({ ...line, lineKind: kind, vatCode, vatMinor: vatMinor ?? 0 });
    }

    const lines = normalizeLines(withVat, fxRateScaled, currency);
    const net = lines.reduce((s, l) => s + l.netMinor, 0);
    const vat = lines.reduce((s, l) => s + l.vatMinor, 0);
    const gross = lines.reduce((s, l) => s + l.grossMinor, 0);
    const aedTotal = lines.reduce((s, l) => s + (l.aedMinor ?? l.grossMinor), 0);
    const originalTotal =
      currency === "AED" ? gross : lines.reduce((s, l) => s + (l.originalMinor ?? l.grossMinor), 0);

    // Duplicate detection: type + number + party + amount
    if (body.documentNumber && !body.forceDuplicate) {
      const dup = await db.query(
        `SELECT id FROM books_documents
         WHERE client_id = $1 AND doc_type = $2 AND document_number = $3
           AND party_id = $4 AND aed_total_minor = $5 AND deleted_at IS NULL AND status <> 'void'`,
        [clientId, body.docType, body.documentNumber, body.partyId, aedTotal],
      );
      if (dup.rowCount) throw new BooksError("duplicate_document", "conflict");
    }

    // CN/DN constraints
    let docKind: string | null = null;
    if (body.docType === "credit_note") docKind = "customer";
    if (body.docType === "debit_note") docKind = "supplier";
    if (body.docType === "sales_invoice") docKind = "customer";
    if (body.docType === "purchase_bill") docKind = "supplier";

    if (body.docType === "credit_note" || body.docType === "debit_note") {
      if (!body.originalDocumentId) throw new BooksError("original_required", "invalid");
      const orig = await db.query(
        `SELECT id, doc_type, party_id, status, gross_minor, aed_total_minor
         FROM books_documents WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
        [body.originalDocumentId, clientId],
      );
      if (!orig.rowCount) throw new BooksError("original_not_found", "not_found");
      const oi = await db.query(
        `SELECT open_aed_minor, open_original_minor FROM books_open_items
         WHERE document_id = $1 AND client_id = $2`,
        [body.originalDocumentId, clientId],
      );
      const remaining = oi.rowCount
        ? Number(oi.rows[0].open_aed_minor)
        : Number(orig.rows[0].aed_total_minor || orig.rows[0].gross_minor);
      if (aedTotal > remaining) throw new BooksError("exceeds_original_balance", "invalid");
    }

    // Deferred revenue default (b): service span > 1 month → defer unless explicitly false
    let defer = body.deferRevenue;
    if (
      body.docType === "sales_invoice" &&
      body.serviceStart &&
      body.serviceEnd &&
      defer == null
    ) {
      defer = monthsSpan(body.serviceStart, body.serviceEnd) > 1;
    }
    defer = Boolean(defer);

    const printedNet = optionalMinor(body.printedNetMinor);
    const printedVat = optionalMinor(body.printedVatMinor);
    const printedGross = optionalMinor(body.printedGrossMinor);
    const printedPaid = optionalMinor(body.printedPaidMinor);
    const printedBalanceDue = optionalMinor(body.printedBalanceDueMinor);

    const checkVatReason = detectCheckVatReason(
      body.docType,
      party.rows[0]?.trn as string | null,
      lines.map((l) => ({ lineKind: l.lineKind, vatCode: l.vatCode, vatMinor: l.vatMinor })),
    );

    const id = randomUUID();
    const reason = body.manualRecordReason?.trim() || "";
    const memo =
      reason && !body.memo
        ? `Manual record: ${reason}`
        : reason && body.memo
          ? `${body.memo}\nManual record: ${reason}`
          : body.memo || "";
    await db.query(
      `INSERT INTO books_documents (
         id, client_id, doc_type, doc_kind, status, document_number, party_id,
         issue_date, due_date, service_start, service_end, defer_revenue,
         currency, fx_rate_scaled, original_total_minor, aed_total_minor,
         net_minor, vat_minor, gross_minor, memo, original_document_id, created_by,
         printed_net_minor, printed_vat_minor, printed_gross_minor,
         printed_paid_minor, printed_balance_due_minor, extraction_id, file_id,
         check_vat_reason
       ) VALUES (
         $1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
         $22,$23,$24,$25,$26,$27,$28,$29
       )`,
      [
        id,
        clientId,
        body.docType,
        docKind,
        body.documentNumber || null,
        body.partyId,
        body.issueDate,
        body.dueDate || null,
        body.serviceStart || null,
        body.serviceEnd || null,
        defer,
        currency,
        fxRateScaled,
        originalTotal,
        aedTotal,
        net,
        vat,
        gross,
        memo,
        body.originalDocumentId || null,
        userId,
        printedNet,
        printedVat,
        printedGross,
        printedPaid,
        printedBalanceDue,
        body.extractionId || null,
        body.fileId || null,
        checkVatReason,
      ],
    );

    for (const line of lines) {
      await db.query(
        `INSERT INTO books_document_lines (
           document_id, client_id, line_no, description, quantity_scaled, unit_price_minor,
           line_kind, account_id, vat_code, net_minor, vat_minor, gross_minor,
           currency, original_minor, fx_rate_scaled, aed_minor, tags
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          id,
          clientId,
          line.lineNo,
          line.description,
          line.quantityScaled,
          line.unitPriceMinor,
          line.lineKind,
          line.accountId,
          line.vatCode,
          line.netMinor,
          line.vatMinor,
          line.grossMinor,
          line.currency,
          line.originalMinor,
          line.fxRateScaled,
          line.aedMinor,
          line.tags,
        ],
      );
    }

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_document",
      entityId: id,
      before: null,
      after: {
        docType: body.docType,
        gross,
        defer,
        manualRecordReason: reason || null,
        extractionId: body.extractionId || null,
      },
    });

    const linesOut = await db.query(
      `SELECT id, line_no AS "lineNo", description, quantity_scaled AS "quantityScaled",
              unit_price_minor AS "unitPriceMinor", line_kind AS "lineKind",
              account_id AS "accountId", vat_code AS "vatCode",
              net_minor AS "netMinor", vat_minor AS "vatMinor", gross_minor AS "grossMinor",
              currency, original_minor AS "originalMinor", fx_rate_scaled AS "fxRateScaled",
              aed_minor AS "aedMinor", tags
       FROM books_document_lines WHERE document_id = $1 ORDER BY line_no`,
      [id],
    );
    const header = await db.query(`SELECT * FROM books_documents WHERE id = $1`, [id]);
    return { ...header.rows[0], id, lines: linesOut.rows };
  });
}

type BuiltLine = {
  accountId: string;
  debitMinor?: number;
  creditMinor?: number;
  currency?: string;
  originalMinor?: number | null;
  fxRateScaled?: number | null;
  aedMinor?: number | null;
  lineMemo?: string;
  vatCode?: string | null;
  tags?: string[];
};

/** Server gate: printed totals must match computed; VAT must not exceed 5% + 1 fils/line. */
export function assertDocumentApproveMoneyGates(doc: {
  net_minor: number;
  vat_minor: number;
  gross_minor: number;
  printed_net_minor: number | null;
  printed_vat_minor: number | null;
  printed_gross_minor: number | null;
}, lines: Array<{ net_minor: number; vat_minor: number; line_kind: string; vat_code: string | null }>) {
  const diffs: string[] = [];
  const printedNet = doc.printed_net_minor == null ? null : Number(doc.printed_net_minor);
  const printedVat = doc.printed_vat_minor == null ? null : Number(doc.printed_vat_minor);
  const printedGross = doc.printed_gross_minor == null ? null : Number(doc.printed_gross_minor);
  if (printedNet != null && printedNet !== Number(doc.net_minor)) {
    diffs.push(`net:${printedNet}!=${doc.net_minor}`);
  }
  if (printedVat != null && printedVat !== Number(doc.vat_minor)) {
    diffs.push(`vat:${printedVat}!=${doc.vat_minor}`);
  }
  if (printedGross != null && printedGross !== Number(doc.gross_minor)) {
    diffs.push(`gross:${printedGross}!=${doc.gross_minor}`);
  }
  if (diffs.length) {
    throw new BooksError(`printed_totals_mismatch:${diffs.join(",")}`, "conflict");
  }

  // Taxable net = lines that are not disbursements and carry a positive VAT amount or SR-class code.
  let taxableNet = 0;
  let taxableLineCount = 0;
  for (const line of lines) {
    if (line.line_kind === "disbursement") continue;
    const vat = Number(line.vat_minor || 0);
    const net = Number(line.net_minor || 0);
    if (vat > 0 || (line.vat_code && line.vat_code !== "ZR" && line.vat_code !== "EX" && line.vat_code !== "OS" && line.vat_code !== "NR")) {
      taxableNet += net;
      taxableLineCount += 1;
    }
  }
  if (taxableLineCount === 0 && Number(doc.vat_minor) > 0) {
    taxableNet = Number(doc.net_minor);
    taxableLineCount = 1;
  }
  const maxVat = vatMinorForNet(taxableNet, 500) + taxableLineCount;
  if (Number(doc.vat_minor) > maxVat) {
    throw new BooksError("vat_exceeds_rate", "conflict");
  }
}

async function buildPostingLines(
  db: PoolClient,
  clientId: string,
  doc: {
    id: string;
    doc_type: string;
    party_id: string;
    defer_revenue: boolean;
    currency: string;
    fx_rate_scaled: number;
  },
  lines: Array<{
    line_kind: string;
    account_id: string | null;
    vat_code: string | null;
    net_minor: number;
    vat_minor: number;
    aed_minor: number | null;
    original_minor: number | null;
    fx_rate_scaled: number | null;
    description: string;
    tags: string[];
  }>,
): Promise<BuiltLine[]> {
  const ar = await accountIdByCode(db, clientId, "1210");
  const ap = await accountIdByCode(db, clientId, "2110");
  const vatOut = await accountIdByCode(db, clientId, "2210");
  const vatIn = await accountIdByCode(db, clientId, "1430");
  const clearing = await accountIdByCode(db, clientId, "1220");
  const deferred = await accountIdByCode(db, clientId, "2310");
  const revenueDefault = await accountIdByCode(db, clientId, "4100");
  const expenseDefault = await accountIdByCode(db, clientId, "6600");
  const depositDefault = await accountIdByCode(db, clientId, "1420");
  const inventoryDefault = await accountIdByCode(db, clientId, "1510");

  const party = await db.query(`SELECT trn, country FROM books_parties WHERE id = $1`, [
    doc.party_id,
  ]);
  const supplierTrn = party.rows[0]?.trn as string | null;

  const out: BuiltLine[] = [];
  let arApTotal = 0;
  let outputVatTotal = 0;

  const docType = doc.doc_type;
  const isSales = docType === "sales_invoice" || docType === "credit_note";
  const sign = docType === "credit_note" || docType === "debit_note" ? -1 : 1;
  const isFx = String(doc.currency || "AED").toUpperCase() !== "AED";

  for (const line of lines) {
    const rate = Number(line.fx_rate_scaled ?? doc.fx_rate_scaled);
    const netDoc = Number(line.net_minor);
    const vatDoc = Number(line.vat_minor);
    // Convert net and VAT separately so FX journals use AED minor units end-to-end.
    const netAed = isFx ? aedFromOriginal(netDoc, rate) : netDoc;
    const vatAed = isFx ? aedFromOriginal(vatDoc, rate) : vatDoc;
    const grossAed = netAed + vatAed;

    const fx = {
      currency: doc.currency,
      originalMinor: line.original_minor,
      fxRateScaled: rate,
      aedMinor: netAed,
    };

    if (isSales) {
      if (line.line_kind === "disbursement") {
        // Dr AR / Cr 1220
        arApTotal += grossAed * sign;
        out.push({
          accountId: clearing,
          creditMinor: sign > 0 ? netAed : 0,
          debitMinor: sign > 0 ? 0 : netAed,
          lineMemo: line.description || "Disbursement rebill",
          tags: line.tags,
          ...fx,
          aedMinor: netAed,
        });
      } else {
        const revAcct =
          line.account_id || (doc.defer_revenue && docType === "sales_invoice" ? deferred : revenueDefault);
        const creditAcct =
          doc.defer_revenue && line.line_kind !== "taxable_recharge" && docType === "sales_invoice"
            ? deferred
            : line.line_kind === "taxable_recharge"
              ? line.account_id || revenueDefault
              : revAcct;
        arApTotal += grossAed * sign;
        outputVatTotal += vatAed * sign;
        out.push({
          accountId: creditAcct,
          creditMinor: sign > 0 ? netAed : 0,
          debitMinor: sign > 0 ? 0 : netAed,
          lineMemo: line.description || "Revenue",
          vatCode: line.vat_code,
          tags: line.tags,
          ...fx,
          aedMinor: netAed,
        });
      }
    } else {
      // Purchase / DN
      if (line.line_kind === "disbursement") {
        arApTotal += grossAed * sign;
        out.push({
          accountId: clearing,
          debitMinor: sign > 0 ? netAed : 0,
          creditMinor: sign > 0 ? 0 : netAed,
          lineMemo: line.description || "Client disbursement",
          tags: line.tags,
          ...fx,
          aedMinor: netAed,
        });
      } else {
        const isAsset = line.line_kind === "asset";
        const isInventory = line.line_kind === "inventory";
        const expAcct =
          line.account_id ||
          (isAsset ? depositDefault : isInventory ? inventoryDefault : expenseDefault);
        const vatCode = line.vat_code;
        const vatMeta = vatCode ? await vatRateBp(db, vatCode) : { rateBp: 0, recoverable: false };
        const canRecover =
          Boolean(supplierTrn) && vatCode !== "NR" && vatMeta.recoverable && vatAed > 0;
        const memoDefault = isAsset
          ? "Deposit / asset"
          : isInventory
            ? "Inventory"
            : "Expense";

        if (vatCode === "RC_IN" || vatCode === "RC_OUT") {
          // Foreign services: expense net; RC_OUT + RC_IN net zero on VAT controls
          arApTotal += netAed * sign;
          out.push({
            accountId: expAcct,
            debitMinor: sign > 0 ? netAed : 0,
            creditMinor: sign > 0 ? 0 : netAed,
            lineMemo: line.description || memoDefault,
            vatCode,
            tags: line.tags,
            ...fx,
            aedMinor: netAed,
          });
          if (vatAed > 0) {
            out.push({
              accountId: vatOut,
              creditMinor: sign > 0 ? vatAed : 0,
              debitMinor: sign > 0 ? 0 : vatAed,
              lineMemo: "RC_OUT",
              vatCode: "RC_OUT",
              aedMinor: vatAed,
              currency: doc.currency,
            });
            out.push({
              accountId: vatIn,
              debitMinor: sign > 0 ? vatAed : 0,
              creditMinor: sign > 0 ? 0 : vatAed,
              lineMemo: "RC_IN",
              vatCode: "RC_IN",
              aedMinor: vatAed,
              currency: doc.currency,
            });
          }
        } else if (canRecover) {
          arApTotal += grossAed * sign;
          out.push({
            accountId: expAcct,
            debitMinor: sign > 0 ? netAed : 0,
            creditMinor: sign > 0 ? 0 : netAed,
            lineMemo: line.description || memoDefault,
            vatCode,
            tags: line.tags,
            ...fx,
            aedMinor: netAed,
          });
          out.push({
            accountId: vatIn,
            debitMinor: sign > 0 ? vatAed : 0,
            creditMinor: sign > 0 ? 0 : vatAed,
            lineMemo: "Input VAT",
            vatCode,
            aedMinor: vatAed,
            currency: doc.currency,
          });
        } else {
          // VAT in cost (incl. no supplier TRN → recoverable = 0)
          const cost = netAed + vatAed;
          arApTotal += cost * sign;
          out.push({
            accountId: expAcct,
            debitMinor: sign > 0 ? cost : 0,
            creditMinor: sign > 0 ? 0 : cost,
            lineMemo: line.description || `${memoDefault}${vatAed > 0 ? " (VAT in cost)" : ""}`,
            vatCode: vatCode || (vatAed > 0 ? "NR" : null),
            tags: line.tags,
            ...fx,
            aedMinor: cost,
          });
        }
      }
    }
  }

  // Control AR/AP + output VAT (sales)
  if (isSales && outputVatTotal !== 0) {
    out.push({
      accountId: vatOut,
      creditMinor: outputVatTotal > 0 ? outputVatTotal : 0,
      debitMinor: outputVatTotal < 0 ? -outputVatTotal : 0,
      lineMemo: "Output VAT",
      vatCode: "SR",
      aedMinor: Math.abs(outputVatTotal),
      currency: doc.currency,
    });
  }

  if (arApTotal !== 0) {
    const control = isSales ? ar : ap;
    out.push({
      accountId: control,
      debitMinor: isSales
        ? arApTotal > 0
          ? arApTotal
          : 0
        : arApTotal < 0
          ? -arApTotal
          : 0,
      creditMinor: isSales
        ? arApTotal < 0
          ? -arApTotal
          : 0
        : arApTotal > 0
          ? arApTotal
          : 0,
      lineMemo: isSales ? "Trade receivables" : "Trade payables",
      aedMinor: Math.abs(arApTotal),
      currency: doc.currency,
      originalMinor: null,
      fxRateScaled: doc.fx_rate_scaled,
    });
  }

  // Drop zero lines
  return out.filter((l) => (l.debitMinor ?? 0) + (l.creditMinor ?? 0) > 0);
}

const VOUCHER_FOR_DOC: Record<string, string> = {
  sales_invoice: "Sales",
  purchase_bill: "Purchase",
  credit_note: "Credit Note",
  debit_note: "Debit Note",
};

/** Approve + post document (dual-control). Separate connection for journal helpers. */
export async function approveAndPostBooksDocument(
  userId: string,
  clientId: string,
  documentId: string,
  opts?: { applyAdvanceOriginalMinor?: number },
) {
  // Pre-checks + build lines inside one session, then create journal
  const prepared = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const docRes = await db.query(
      `SELECT * FROM books_documents WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [documentId, clientId],
    );
    if (!docRes.rowCount) throw new BooksError("document_not_found", "not_found");
    const doc = docRes.rows[0];
    if (doc.status !== "draft") throw new BooksError("not_draft", "conflict");
    await requireDualControlActor(db, userId, String(doc.created_by), "post");

    if (doc.check_vat_reason && !doc.check_vat_ack_at) {
      throw new BooksError("check_vat_unacknowledged", "conflict");
    }

    const linesRes = await db.query(
      `SELECT * FROM books_document_lines WHERE document_id = $1 ORDER BY line_no`,
      [documentId],
    );
    assertDocumentApproveMoneyGates(doc, linesRes.rows);
    const period = await db.query(
      `SELECT id, status FROM books_periods
       WHERE client_id = $1 AND period_start <= $2::date AND period_end >= $2::date`,
      [clientId, doc.issue_date],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
      throw new BooksError("period_locked", "period_closed");
    }

    const journalLines = await buildPostingLines(db, clientId, doc, linesRes.rows);
    return {
      doc,
      periodId: String(period.rows[0].id),
      journalLines,
      voucherType: VOUCHER_FOR_DOC[String(doc.doc_type)] || "Journal",
    };
  });

  // Journal preparer = document creator; approver posts (dual control).
  const preparerId = String(prepared.doc.created_by);
  const created = await createBooksJournal(preparerId, clientId, {
    periodId: prepared.periodId,
    entryDate: String(prepared.doc.issue_date),
    memo: prepared.doc.memo || `${prepared.doc.doc_type} ${prepared.doc.document_number || ""}`.trim(),
    voucherType: prepared.voucherType,
    // VAT companions already built in buildPostingLines — do not expand again.
    lines: prepared.journalLines.map((l) => ({
      accountId: l.accountId,
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
      currency: l.currency,
      originalMinor: l.originalMinor,
      fxRateScaled: l.fxRateScaled,
      aedMinor: l.aedMinor,
      lineMemo: l.lineMemo,
      vatCode: null,
      vatTreatment: l.vatCode ?? null,
      tags: l.tags,
      isVatCompanion: true,
    })),
    post: false,
  });

  const posted = await postBooksJournal(userId, clientId, created.id);

  await withUser(userId, async (db) => {
    await db.query(
      `UPDATE books_documents SET
         status = 'posted', journal_entry_id = $3, approved_by = $4, updated_at = now(),
         voucher_type = $5
       WHERE id = $1 AND client_id = $2`,
      [documentId, clientId, created.id, userId, prepared.voucherType],
    );

    const side =
      prepared.doc.doc_type === "sales_invoice" || prepared.doc.doc_type === "credit_note"
        ? "AR"
        : "AP";

    if (
      ["sales_invoice", "purchase_bill"].includes(String(prepared.doc.doc_type)) &&
      prepared.doc.party_id
    ) {
      await upsertOpenItemFromDocument(db, {
        clientId,
        partyId: String(prepared.doc.party_id),
        documentId,
        journalEntryId: created.id,
        side,
        currency: String(prepared.doc.currency),
        originalMinor: Number(prepared.doc.original_total_minor),
        aedMinor: Number(prepared.doc.aed_total_minor),
        fxRateScaled: Number(prepared.doc.fx_rate_scaled),
      });
    }

    // CN/DN: reduce original open item
    if (
      (prepared.doc.doc_type === "credit_note" || prepared.doc.doc_type === "debit_note") &&
      prepared.doc.original_document_id
    ) {
      const oi = await db.query(
        `SELECT id FROM books_open_items WHERE document_id = $1 AND client_id = $2`,
        [prepared.doc.original_document_id, clientId],
      );
      if (oi.rowCount) {
        const { applyAllocationToOpenItem } = await import("@/server/books/open-items");
        await applyAllocationToOpenItem(
          db,
          String(oi.rows[0].id),
          clientId,
          Number(prepared.doc.original_total_minor),
          Number(prepared.doc.aed_total_minor),
        );
      }
    }

    // Deferred revenue schedules
    if (prepared.doc.defer_revenue && prepared.doc.doc_type === "sales_invoice") {
      await scheduleDeferredReleases(db, clientId, prepared.doc);
    }

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "approve_post",
      entity: "books_document",
      entityId: documentId,
      before: { status: "draft" },
      after: { status: "posted", journalEntryId: created.id, entryNo: posted.entryNo },
    });
  });

  // C1b-2: optional apply of existing 2320 advance (never default). Dual control: preparer = creator.
  let advanceAllocation: { entryNo: string; amountOriginalMinor: number } | null = null;
  const applyRaw = opts?.applyAdvanceOriginalMinor;
  if (
    applyRaw != null &&
    applyRaw > 0 &&
    String(prepared.doc.doc_type) === "sales_invoice" &&
    prepared.doc.party_id
  ) {
    const { allocatePartyAdvance, getPartyAdvanceBalance } = await import(
      "@/server/books/settlements"
    );
    const currency = String(prepared.doc.currency || "AED");
    const advance = await getPartyAdvanceBalance(
      userId,
      clientId,
      String(prepared.doc.party_id),
      currency,
    );
    const oi = await withUser(userId, async (db) => {
      const row = await db.query(
        `SELECT id, open_original_minor FROM books_open_items
         WHERE document_id = $1 AND client_id = $2`,
        [documentId, clientId],
      );
      return row.rowCount ? row.rows[0] : null;
    });
    if (!oi) throw new BooksError("open_item_not_found", "not_found");
    const amount = Math.min(
      applyRaw,
      Number(advance.balanceOriginalMinor),
      Number(oi.open_original_minor),
      Number(prepared.doc.original_total_minor || prepared.doc.gross_minor),
    );
    if (amount > 0) {
      const alloc = await allocatePartyAdvance(preparerId, userId, clientId, {
        partyId: String(prepared.doc.party_id),
        openItemId: String(oi.id),
        periodId: prepared.periodId,
        issueDate: String(prepared.doc.issue_date).slice(0, 10),
        amountOriginalMinor: amount,
        currency,
      });
      advanceAllocation = { entryNo: String(alloc.entryNo), amountOriginalMinor: amount };
    }
  }

  return {
    documentId,
    journalEntryId: created.id,
    entryNo: posted.entryNo,
    advanceAllocation,
  };
}

/**
 * Soft-delete an unposted draft document (C1-3 bulk "Revert draft").
 * Posted / paid / void rows are rejected — never hard-delete.
 */
export async function softDeleteBooksDocumentDraft(
  userId: string,
  clientId: string,
  documentId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT id, status, document_number, deleted_at
       FROM books_documents WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [documentId, clientId],
    );
    if (!before.rowCount) throw new BooksError("document_not_found", "not_found");
    if (before.rows[0].status !== "draft") {
      throw new BooksError("not_draft", "conflict");
    }
    await db.query(
      `UPDATE books_documents
       SET deleted_at = now(), status = 'void', updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [documentId, clientId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "soft_delete_draft",
      entity: "books_document",
      entityId: documentId,
      before: {
        status: before.rows[0].status,
        document_number: before.rows[0].document_number,
        deleted_at: null,
      },
      after: { status: "void", deleted_at: "set" },
    });
    return { ok: true, documentId };
  });
}

/** Acknowledge check_vat warning so Approve may proceed (audited). */
export async function acknowledgeBooksDocumentCheckVat(
  userId: string,
  clientId: string,
  documentId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT id, status, check_vat_reason, check_vat_ack_by, check_vat_ack_at
       FROM books_documents WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [documentId, clientId],
    );
    if (!before.rowCount) throw new BooksError("document_not_found", "not_found");
    if (before.rows[0].status !== "draft") throw new BooksError("not_draft", "conflict");
    if (!before.rows[0].check_vat_reason) {
      throw new BooksError("check_vat_not_required", "conflict");
    }

    const updated = await db.query(
      `UPDATE books_documents SET
         check_vat_ack_by = $3, check_vat_ack_at = now(), updated_at = now()
       WHERE id = $1 AND client_id = $2
       RETURNING check_vat_reason, check_vat_ack_by, check_vat_ack_at`,
      [documentId, clientId, userId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "ack_check_vat",
      entity: "books_document",
      entityId: documentId,
      before: {
        check_vat_reason: before.rows[0].check_vat_reason,
        check_vat_ack_by: before.rows[0].check_vat_ack_by,
        check_vat_ack_at: before.rows[0].check_vat_ack_at,
      },
      after: {
        check_vat_reason: updated.rows[0].check_vat_reason,
        check_vat_ack_by: updated.rows[0].check_vat_ack_by,
        check_vat_ack_at: updated.rows[0].check_vat_ack_at,
      },
    });
    // Return from same transaction (nested withUser would not see uncommitted UPDATE).
    return {
      id: documentId,
      checkVatReason:
        updated.rows[0].check_vat_reason == null
          ? null
          : String(updated.rows[0].check_vat_reason),
      checkVatAckBy:
        updated.rows[0].check_vat_ack_by == null
          ? null
          : String(updated.rows[0].check_vat_ack_by),
      checkVatAckAt: updated.rows[0].check_vat_ack_at,
    };
  });
}

/** Update printed totals / payments-made on a draft (editable on review). */
export async function updateBooksDocumentPrintedFields(
  userId: string,
  clientId: string,
  documentId: string,
  body: {
    printedNetMinor?: number | null;
    printedVatMinor?: number | null;
    printedGrossMinor?: number | null;
    printedPaidMinor?: number | null;
    printedBalanceDueMinor?: number | null;
  },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_documents WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [documentId, clientId],
    );
    if (!before.rowCount) throw new BooksError("document_not_found", "not_found");
    if (before.rows[0].status !== "draft") throw new BooksError("not_draft", "conflict");

    const next = {
      printed_net_minor:
        body.printedNetMinor === undefined
          ? before.rows[0].printed_net_minor
          : optionalMinor(body.printedNetMinor),
      printed_vat_minor:
        body.printedVatMinor === undefined
          ? before.rows[0].printed_vat_minor
          : optionalMinor(body.printedVatMinor),
      printed_gross_minor:
        body.printedGrossMinor === undefined
          ? before.rows[0].printed_gross_minor
          : optionalMinor(body.printedGrossMinor),
      printed_paid_minor:
        body.printedPaidMinor === undefined
          ? before.rows[0].printed_paid_minor
          : optionalMinor(body.printedPaidMinor),
      printed_balance_due_minor:
        body.printedBalanceDueMinor === undefined
          ? before.rows[0].printed_balance_due_minor
          : optionalMinor(body.printedBalanceDueMinor),
    };

    await db.query(
      `UPDATE books_documents SET
         printed_net_minor = $3, printed_vat_minor = $4, printed_gross_minor = $5,
         printed_paid_minor = $6, printed_balance_due_minor = $7, updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [
        documentId,
        clientId,
        next.printed_net_minor,
        next.printed_vat_minor,
        next.printed_gross_minor,
        next.printed_paid_minor,
        next.printed_balance_due_minor,
      ],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update_printed_totals",
      entity: "books_document",
      entityId: documentId,
      before: {
        printed_net_minor: before.rows[0].printed_net_minor,
        printed_vat_minor: before.rows[0].printed_vat_minor,
        printed_gross_minor: before.rows[0].printed_gross_minor,
        printed_paid_minor: before.rows[0].printed_paid_minor,
        printed_balance_due_minor: before.rows[0].printed_balance_due_minor,
      },
      after: next,
    });
    const lines = await db.query(
      `SELECT id, line_no AS "lineNo", description, quantity_scaled AS "quantityScaled",
              unit_price_minor AS "unitPriceMinor", line_kind AS "lineKind",
              account_id AS "accountId", vat_code AS "vatCode",
              net_minor AS "netMinor", vat_minor AS "vatMinor", gross_minor AS "grossMinor",
              currency, original_minor AS "originalMinor", fx_rate_scaled AS "fxRateScaled",
              aed_minor AS "aedMinor", tags
       FROM books_document_lines WHERE document_id = $1 ORDER BY line_no`,
      [documentId],
    );
    const d = { ...before.rows[0], ...next };
    return {
      ...d,
      printedNetMinor: next.printed_net_minor == null ? null : Number(next.printed_net_minor),
      printedVatMinor: next.printed_vat_minor == null ? null : Number(next.printed_vat_minor),
      printedGrossMinor: next.printed_gross_minor == null ? null : Number(next.printed_gross_minor),
      printedPaidMinor: next.printed_paid_minor == null ? null : Number(next.printed_paid_minor),
      printedBalanceDueMinor:
        next.printed_balance_due_minor == null ? null : Number(next.printed_balance_due_minor),
      netMinor: Number(d.net_minor),
      vatMinor: Number(d.vat_minor),
      grossMinor: Number(d.gross_minor),
      lines: lines.rows,
    };
  });
}

export type JournalPreviewLine = {
  accountCode: string;
  accountName: string;
  vatCode: string | null;
  debitMinor: number;
  creditMinor: number;
  currency: string;
  aedMinor: number;
};

/** Read-only Dr/Cr preview of what Approve would post. No inserts / voucher / audit. */
export async function previewBooksDocumentJournal(
  userId: string,
  clientId: string,
  documentId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const docRes = await db.query(
      `SELECT * FROM books_documents WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [documentId, clientId],
    );
    if (!docRes.rowCount) throw new BooksError("document_not_found", "not_found");
    const doc = docRes.rows[0];
    const linesRes = await db.query(
      `SELECT * FROM books_document_lines WHERE document_id = $1 ORDER BY line_no`,
      [documentId],
    );
    const built = await buildPostingLines(db, clientId, doc, linesRes.rows);
    const accountIds = [...new Set(built.map((l) => l.accountId))];
    const accts = accountIds.length
      ? await db.query(
          `SELECT id, code, name FROM books_accounts WHERE client_id = $1 AND id = ANY($2::uuid[])`,
          [clientId, accountIds],
        )
      : { rows: [] as Array<{ id: string; code: string; name: string }> };
    const byId = new Map(accts.rows.map((a) => [String(a.id), a]));

    const lines: JournalPreviewLine[] = built.map((l) => {
      const acct = byId.get(l.accountId);
      const debit = Number(l.debitMinor ?? 0);
      const credit = Number(l.creditMinor ?? 0);
      const aed = Number(l.aedMinor ?? debit + credit);
      return {
        accountCode: acct?.code || "",
        accountName: acct?.name || "",
        vatCode: l.vatCode ?? null,
        debitMinor: debit,
        creditMinor: credit,
        currency: (l.currency || doc.currency || "AED").toString(),
        aedMinor: aed,
      };
    });
    // Balance in AED (FX lines store aedMinor on the posted side).
    const debitAed = lines.reduce((s, l) => s + (l.debitMinor > 0 ? l.aedMinor : 0), 0);
    const creditAed = lines.reduce((s, l) => s + (l.creditMinor > 0 ? l.aedMinor : 0), 0);
    return {
      documentId,
      lines,
      debitMinor: debitAed,
      creditMinor: creditAed,
      balanced: debitAed === creditAed,
    };
  });
}

async function scheduleDeferredReleases(
  db: PoolClient,
  clientId: string,
  doc: {
    id: string;
    service_start: string | null;
    service_end: string | null;
    net_minor: number;
    aed_total_minor: number;
    vat_minor: number;
  },
) {
  if (!doc.service_start || !doc.service_end) return;
  const months = monthsSpan(String(doc.service_start), String(doc.service_end));
  if (months <= 1) return;
  const revenue = await accountIdByCode(db, clientId, "4100");
  const deferred = await accountIdByCode(db, clientId, "2310");
  void deferred;
  const netAed = Number(doc.aed_total_minor) - Number(doc.vat_minor);
  const each = Math.floor(netAed / months);
  let allocated = 0;
  const start = new Date(`${doc.service_start}T12:00:00Z`);

  for (let i = 0; i < months; i++) {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() + i);
    const releaseDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const amount = i === months - 1 ? netAed - allocated : each;
    allocated += amount;
    const period = await db.query(
      `SELECT id, status FROM books_periods
       WHERE client_id = $1 AND period_start <= $2::date AND period_end >= $2::date`,
      [clientId, releaseDate],
    );
    const periodId = period.rowCount ? String(period.rows[0].id) : null;
    const blocked = period.rowCount && String(period.rows[0].status) === "LOCKED";
    const sched = await db.query(
      `INSERT INTO books_deferred_schedules (
         client_id, document_id, release_date, period_id, amount_aed_minor,
         revenue_account_id, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        clientId,
        doc.id,
        releaseDate,
        periodId,
        amount,
        revenue,
        blocked ? "blocked" : "pending",
      ],
    );
    if (!blocked && periodId) {
      await enqueueBooksJob(
        db,
        clientId,
        "deferred_release",
        { scheduleId: String(sched.rows[0].id), documentId: doc.id },
        new Date(`${releaseDate}T00:00:00Z`),
      );
    }
  }
}
