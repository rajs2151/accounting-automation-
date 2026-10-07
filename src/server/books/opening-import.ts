import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { requireDualControlActor } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { upsertOpenItemFromDocument } from "@/server/books/open-items";
import { parseAmountToFils } from "@/server/books/parsing";
import { assertSyntheticTenant } from "@/server/security-gate";

export type OpeningLine = {
  accountCode: string;
  debitMinor?: number;
  creditMinor?: number;
  partyId?: string | null;
};

export type OpeningPartyItem = {
  partyId: string;
  side: "AR" | "AP";
  amountMinor: number;
  currency?: string;
};

function dayBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function createOpeningImport(
  preparerId: string,
  clientId: string,
  body: {
    lines: OpeningLine[];
    partyOpenItems?: OpeningPartyItem[];
    forceBooksStartPeriodId?: string;
  },
) {
  return withUser(preparerId, async (db) => {
    await assertSyntheticTenant(db, clientId);

    const client = await db.query(
      `SELECT books_start_period_id FROM clients WHERE id = $1`,
      [clientId],
    );
    const startPeriodId =
      body.forceBooksStartPeriodId || client.rows[0]?.books_start_period_id;
    if (!startPeriodId) throw new BooksError("books_start_period_unset", "invalid");

    const period = await db.query(
      `SELECT id, status, period_start, label FROM books_periods
       WHERE id = $1 AND client_id = $2`,
      [startPeriodId, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
      throw new BooksError(
        "opening_first_period_locked:unlock_or_set_books_start_to_open_month",
        "period_closed",
      );
    }

    const asOf = dayBefore(String(period.rows[0].period_start));
    let debit = 0;
    let credit = 0;
    const mapped: Array<{ accountId: string; debitMinor: number; creditMinor: number; code: string }> =
      [];

    for (const line of body.lines) {
      const acc = await db.query(
        `SELECT id, code, is_ar, is_ap FROM books_accounts
         WHERE client_id = $1 AND code = $2 AND active = true`,
        [clientId, line.accountCode],
      );
      if (!acc.rowCount) throw new BooksError(`unmapped_account:${line.accountCode}`, "invalid");
      const d = line.debitMinor ?? 0;
      const c = line.creditMinor ?? 0;
      if (d < 0 || c < 0 || (d > 0 && c > 0) || (d === 0 && c === 0)) {
        throw new BooksError("invalid_opening_line", "invalid");
      }
      if ((acc.rows[0].is_ar || acc.rows[0].is_ap) && !line.partyId) {
        // party detail required at import level via partyOpenItems
      }
      debit += d;
      credit += c;
      mapped.push({
        accountId: String(acc.rows[0].id),
        debitMinor: d,
        creditMinor: c,
        code: String(acc.rows[0].code),
      });
    }

    if (debit !== credit) throw new BooksError("opening_tb_unbalanced", "journal_unbalanced");

    const arAp = mapped.filter((m) => m.code === "1210" || m.code === "2110");
    const partyItems = body.partyOpenItems || [];
    for (const m of arAp) {
      const side = m.code === "1210" ? "AR" : "AP";
      const need = m.code === "1210" ? m.debitMinor : m.creditMinor;
      const sum = partyItems
        .filter((p) => p.side === side)
        .reduce((s, p) => s + p.amountMinor, 0);
      if (need > 0 && sum !== need) {
        throw new BooksError(`party_open_items_mismatch_${side}`, "invalid");
      }
    }

    const id = randomUUID();
    await db.query(
      `INSERT INTO books_opening_imports (
         id, client_id, as_of_date, period_id, status, mapping_json,
         balance_debit_minor, balance_credit_minor, created_by
       ) VALUES ($1,$2,$3,$4,'mapped',$5::jsonb,$6,$7,$8)`,
      [
        id,
        clientId,
        asOf,
        startPeriodId,
        JSON.stringify({ lines: body.lines, partyOpenItems: partyItems }),
        debit,
        credit,
        preparerId,
      ],
    );

    return {
      id,
      asOfDate: asOf,
      periodId: String(startPeriodId),
      periodLabel: String(period.rows[0].label),
      debitMinor: debit,
      creditMinor: credit,
    };
  });
}

export async function postOpeningImport(
  approverId: string,
  clientId: string,
  importId: string,
) {
  const prepared = await withUser(approverId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const row = await db.query(
      `SELECT * FROM books_opening_imports WHERE id = $1 AND client_id = $2`,
      [importId, clientId],
    );
    if (!row.rowCount) throw new BooksError("import_not_found", "not_found");
    if (row.rows[0].status !== "mapped") throw new BooksError("not_mapped", "conflict");
    await requireDualControlActor(db, approverId, String(row.rows[0].created_by), "post");

    const period = await db.query(
      `SELECT id, status, period_start FROM books_periods WHERE id = $1`,
      [row.rows[0].period_id],
    );
    if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
      throw new BooksError("opening_first_period_locked", "period_closed");
    }

    const mapping = row.rows[0].mapping_json as {
      lines: OpeningLine[];
      partyOpenItems?: OpeningPartyItem[];
    };

    const journalLines = [];
    for (const line of mapping.lines) {
      const acc = await db.query(
        `SELECT id FROM books_accounts WHERE client_id = $1 AND code = $2`,
        [clientId, line.accountCode],
      );
      journalLines.push({
        accountId: String(acc.rows[0].id),
        debitMinor: line.debitMinor ?? 0,
        creditMinor: line.creditMinor ?? 0,
        lineMemo: `Opening ${line.accountCode}`,
      });
    }

    return {
      importRow: row.rows[0],
      periodId: String(period.rows[0].id),
      asOf: String(row.rows[0].as_of_date).slice(0, 10),
      journalLines,
      mapping,
      preparerId: String(row.rows[0].created_by),
    };
  });

  const created = await createBooksJournal(prepared.preparerId, clientId, {
    periodId: prepared.periodId,
    entryDate: prepared.asOf,
    memo: "Opening balances",
    voucherType: "Opening",
    lines: prepared.journalLines,
    post: false,
    // AR/AP lines are matched to party open items above (party_open_items_mismatch_*).
    allowControlAccounts: true,
  });
  const posted = await postBooksJournal(approverId, clientId, created.id);

  const documentId = randomUUID();
  await withUser(approverId, async (db) => {
    await db.query(
      `INSERT INTO books_documents (
         id, client_id, doc_type, status, issue_date, currency, fx_rate_scaled,
         original_total_minor, aed_total_minor, net_minor, vat_minor, gross_minor,
         memo, journal_entry_id, voucher_type, created_by, approved_by
       ) VALUES (
         $1,$2,'opening','posted',$3,'AED',100000000,0,0,0,0,0,'Opening balances',$4,'Opening',$5,$6
       )`,
      [documentId, clientId, prepared.asOf, created.id, prepared.preparerId, approverId],
    );

    for (const p of prepared.mapping.partyOpenItems || []) {
      // Synthetic per-party opening document OI
      const partyDocId = randomUUID();
      await db.query(
        `INSERT INTO books_documents (
           id, client_id, doc_type, doc_kind, status, party_id, issue_date,
           currency, fx_rate_scaled, original_total_minor, aed_total_minor,
           net_minor, vat_minor, gross_minor, memo, journal_entry_id, voucher_type,
           created_by, approved_by
         ) VALUES (
           $1,$2,$3,$4,'posted',$5,$6,'AED',100000000,$7,$7,$7,0,$7,'Opening open item',$8,'Opening',$9,$10
         )`,
        [
          partyDocId,
          clientId,
          p.side === "AR" ? "sales_invoice" : "purchase_bill",
          p.side === "AR" ? "customer" : "supplier",
          p.partyId,
          prepared.asOf,
          p.amountMinor,
          created.id,
          prepared.preparerId,
          approverId,
        ],
      );
      await upsertOpenItemFromDocument(db, {
        clientId,
        partyId: p.partyId,
        documentId: partyDocId,
        journalEntryId: created.id,
        side: p.side,
        currency: p.currency || "AED",
        originalMinor: p.amountMinor,
        aedMinor: p.amountMinor,
        fxRateScaled: 100000000,
      });
    }

    await db.query(
      `UPDATE books_opening_imports SET status = 'posted', journal_entry_id = $3 WHERE id = $1 AND client_id = $2`,
      [importId, clientId, created.id],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: approverId,
      action: "post_opening",
      entity: "books_opening_import",
      entityId: importId,
      after: { entryNo: posted.entryNo },
    });
  });

  return { importId, journalEntryId: created.id, entryNo: posted.entryNo, documentId };
}

/** Parse simple CSV: code,debit,credit */
export function parseOpeningTbCsv(content: string): OpeningLine[] {
  const lines: OpeningLine[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const row = raw.trim();
    if (!row || /^account/i.test(row) || /^code/i.test(row)) continue;
    const parts = row.split(",").map((p) => p.trim());
    if (parts.length < 3) continue;
    const debit = parts[1] ? parseAmountToFils(parts[1]) : 0;
    const credit = parts[2] ? parseAmountToFils(parts[2]) : 0;
    lines.push({
      accountCode: parts[0],
      debitMinor: debit > 0 ? debit : 0,
      creditMinor: credit > 0 ? credit : 0,
    });
  }
  return lines;
}
