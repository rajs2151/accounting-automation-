import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { parseAmountToFils, parseDateUae } from "@/server/books/parsing";
import { assertSyntheticTenant } from "@/server/security-gate";

export type StatementLineInput = {
  lineDate?: string | null;
  valueDate?: string | null;
  description?: string;
  debitMinor?: number;
  creditMinor?: number;
  runningBalanceMinor?: number | null;
  reference?: string | null;
  currency?: string;
  confidence?: number | null;
  flags?: string[];
};

export async function listStatementExtractions(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, file_id AS "fileId", account_label AS "accountLabel", iban,
              bank_name AS "bankName", currency, period_from AS "periodFrom",
              period_to AS "periodTo", opening_balance_minor AS "openingBalanceMinor",
              closing_balance_minor AS "closingBalanceMinor", status,
              validation_flags AS "validationFlags"
       FROM books_statement_extractions
       WHERE client_id = $1
       ORDER BY created_at DESC`,
      [clientId],
    );
    return rows.rows;
  });
}

export async function getStatementExtraction(
  userId: string,
  clientId: string,
  statementId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const header = await db.query(
      `SELECT id, file_id AS "fileId", account_label AS "accountLabel", iban,
              bank_name AS "bankName", currency, period_from AS "periodFrom",
              period_to AS "periodTo",
              opening_balance_minor AS "openingBalanceMinor",
              closing_balance_minor AS "closingBalanceMinor",
              status, validation_flags AS "validationFlags"
       FROM books_statement_extractions WHERE id = $1 AND client_id = $2`,
      [statementId, clientId],
    );
    if (!header.rowCount) throw new BooksError("statement_not_found", "not_found");
    const lines = await db.query(
      `SELECT id, line_date AS "lineDate", value_date AS "valueDate", description,
              debit_minor AS "debitMinor", credit_minor AS "creditMinor",
              running_balance_minor AS "runningBalanceMinor", reference, currency,
              source_bbox AS "sourceBbox", confidence, flags, sort_index AS "sortIndex"
       FROM books_statement_lines
       WHERE statement_id = $1
       ORDER BY sort_index`,
      [statementId],
    );
    return { ...header.rows[0], lines: lines.rows };
  });
}

export function recheckStatementBalances(args: {
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  lines: Array<{
    debitMinor: number;
    creditMinor: number;
    runningBalanceMinor: number | null;
  }>;
}) {
  const flags: string[] = [];
  let sumDr = 0;
  let sumCr = 0;
  let expected = args.openingBalanceMinor;
  const lineFlags: string[][] = [];

  for (const line of args.lines) {
    const lf: string[] = [];
    sumDr += line.debitMinor;
    sumCr += line.creditMinor;
    expected = expected + line.creditMinor - line.debitMinor;
    if (line.runningBalanceMinor != null && line.runningBalanceMinor !== expected) {
      lf.push("balance_break");
    }
    lineFlags.push(lf);
  }

  if (expected !== args.closingBalanceMinor) flags.push("closing_mismatch");
  if (args.openingBalanceMinor + sumCr - sumDr !== args.closingBalanceMinor) {
    if (!flags.includes("closing_mismatch")) flags.push("closing_mismatch");
  }

  return {
    flags,
    lineFlags,
    sumDebitMinor: sumDr,
    sumCreditMinor: sumCr,
    computedClosingMinor: args.openingBalanceMinor + sumCr - sumDr,
  };
}

export async function updateStatementLines(
  userId: string,
  clientId: string,
  statementId: string,
  body: {
    openingBalanceMinor?: number;
    closingBalanceMinor?: number;
    lines: StatementLineInput[];
  },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const header = await db.query(
      `SELECT * FROM books_statement_extractions WHERE id = $1 AND client_id = $2`,
      [statementId, clientId],
    );
    if (!header.rowCount) throw new BooksError("statement_not_found", "not_found");

    const opening =
      body.openingBalanceMinor ?? Number(header.rows[0].opening_balance_minor ?? 0);
    const closing =
      body.closingBalanceMinor ?? Number(header.rows[0].closing_balance_minor ?? 0);

    await db.query(`DELETE FROM books_statement_lines WHERE statement_id = $1`, [statementId]);

    const normalized = body.lines.map((l, i) => ({
      debitMinor: l.debitMinor ?? 0,
      creditMinor: l.creditMinor ?? 0,
      runningBalanceMinor: l.runningBalanceMinor ?? null,
      lineDate: l.lineDate || null,
      valueDate: l.valueDate || null,
      description: l.description || "",
      reference: l.reference || null,
      currency: l.currency || String(header.rows[0].currency || "AED"),
      confidence: l.confidence ?? null,
      sortIndex: i,
    }));

    const check = recheckStatementBalances({
      openingBalanceMinor: opening,
      closingBalanceMinor: closing,
      lines: normalized,
    });

    for (let i = 0; i < normalized.length; i++) {
      const l = normalized[i];
      const flags = [...(body.lines[i].flags || []), ...check.lineFlags[i]];
      await db.query(
        `INSERT INTO books_statement_lines (
           id, statement_id, client_id, line_date, value_date, description,
           debit_minor, credit_minor, running_balance_minor, reference, currency,
           confidence, flags, sort_index
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          randomUUID(),
          statementId,
          clientId,
          l.lineDate,
          l.valueDate,
          l.description,
          l.debitMinor,
          l.creditMinor,
          l.runningBalanceMinor,
          l.reference,
          l.currency,
          l.confidence,
          flags,
          l.sortIndex,
        ],
      );
    }

    await db.query(
      `UPDATE books_statement_extractions SET
         opening_balance_minor = $3, closing_balance_minor = $4,
         validation_flags = $5::jsonb,
         status = CASE WHEN cardinality($6::text[]) = 0 THEN 'ready' ELSE 'needs_review' END,
         updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [
        statementId,
        clientId,
        opening,
        closing,
        JSON.stringify(check.flags),
        check.flags,
      ],
    );

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update_statement_lines",
      entity: "books_statement_extraction",
      entityId: statementId,
      after: check,
    });

    return getStatementExtraction(userId, clientId, statementId);
  });
}

export async function listCsvProfiles(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, issuer_key AS "issuerKey", doc_type AS "docType", file_type AS "fileType",
              header_fingerprint AS "headerFingerprint", column_map AS "columnMap",
              date_format AS "dateFormat", client_id AS "clientId"
       FROM books_source_profiles
       WHERE (client_id IS NULL OR client_id = $1) AND file_type IN ('csv','xlsx')
       ORDER BY issuer_key`,
      [clientId],
    );
    return rows.rows;
  });
}

export async function saveCsvProfile(
  userId: string,
  clientId: string,
  body: {
    issuerKey: string;
    docType: string;
    fileType?: string;
    headerFingerprint?: string;
    columnMap: Record<string, unknown>;
    dateFormat?: string;
  },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const id = randomUUID();
    await db.query(
      `INSERT INTO books_source_profiles (
         id, client_id, issuer_key, doc_type, file_type, header_fingerprint, column_map, date_format
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (issuer_key, doc_type, file_type, header_fingerprint) DO UPDATE SET
         column_map = EXCLUDED.column_map,
         date_format = EXCLUDED.date_format,
         client_id = COALESCE(books_source_profiles.client_id, EXCLUDED.client_id)
       RETURNING id`,
      [
        id,
        clientId,
        body.issuerKey,
        body.docType,
        body.fileType || "csv",
        body.headerFingerprint || "",
        JSON.stringify(body.columnMap),
        body.dateFormat || "dd/mm/yyyy",
      ],
    );
    return { ok: true };
  });
}

/** Apply Stripe/generic CSV using column map → statement staging rows (no journal). */
export async function ingestCsvToStatement(
  userId: string,
  clientId: string,
  body: {
    fileId?: string;
    csvText: string;
    issuerKey?: string;
    openingBalanceMinor?: number;
    closingBalanceMinor?: number;
  },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const profile = await db.query(
      `SELECT column_map, date_format FROM books_source_profiles
       WHERE issuer_key = $1 AND file_type = 'csv'
       ORDER BY CASE WHEN client_id = $2 THEN 0 WHEN client_id IS NULL THEN 1 ELSE 2 END
       LIMIT 1`,
      [body.issuerKey || "stripe", clientId],
    );
    const map = (profile.rows[0]?.column_map || {}) as Record<string, string | null>;
    const dateFmt = (profile.rows[0]?.date_format || "yyyy-mm-dd") as "yyyy-mm-dd";

    const rows = body.csvText.trim().split(/\r?\n/);
    if (rows.length < 2) throw new BooksError("empty_csv", "invalid");
    const headers = rows[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const idx = (name: string | null | undefined) =>
      name ? headers.findIndex((h) => h === name) : -1;

    const dateI = idx(map.date);
    const descI = idx(map.description);
    const amountI = idx(map.debit || map.amount || null);
    const refI = idx(map.reference);

    const lines: StatementLineInput[] = [];
    for (const row of rows.slice(1)) {
      if (!row.trim()) continue;
      const cols = row.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      const amountRaw = amountI >= 0 ? cols[amountI] : "0";
      let amount = 0;
      try {
        amount = parseAmountToFils(amountRaw);
      } catch {
        continue;
      }
      const debit = amount < 0 ? -amount : 0;
      const credit = amount > 0 ? amount : 0;
      let lineDate: string | null = null;
      try {
        lineDate = dateI >= 0 ? parseDateUae(cols[dateI], dateFmt === "yyyy-mm-dd" ? "yyyy-mm-dd" : "dd/mm/yyyy") : null;
      } catch {
        lineDate = null;
      }
      lines.push({
        lineDate,
        description: descI >= 0 ? cols[descI] : "",
        debitMinor: debit,
        creditMinor: credit,
        reference: refI >= 0 ? cols[refI] : null,
        currency: "AED",
      });
    }

    const statementId = randomUUID();
    const opening = body.openingBalanceMinor ?? 0;
    let running = opening;
    const withRb = lines.map((l) => {
      running = running + (l.creditMinor || 0) - (l.debitMinor || 0);
      return { ...l, runningBalanceMinor: running };
    });
    const closing = body.closingBalanceMinor ?? running;

    let fileId = body.fileId;
    if (!fileId) {
      fileId = randomUUID();
      const sha = randomUUID().replace(/-/g, "");
      await db.query(
        `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
         VALUES ($1,$2,$3,$4,'upload.csv','text/csv',$5,$6)`,
        [
          fileId,
          clientId,
          sha,
          `books/${clientId}/csv/${fileId}.csv`,
          Buffer.byteLength(body.csvText),
          userId,
        ],
      );
    }

    await db.query(
      `INSERT INTO books_statement_extractions (
         id, client_id, file_id, bank_name, currency, opening_balance_minor, closing_balance_minor, status
       ) VALUES ($1,$2,$3,$4,'AED',$5,$6,'needs_review')`,
      [statementId, clientId, fileId, body.issuerKey || "csv", opening, closing],
    );

    return updateStatementLines(userId, clientId, statementId, {
      openingBalanceMinor: opening,
      closingBalanceMinor: closing,
      lines: withRb,
    });
  });
}
