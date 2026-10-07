/**
 * P5-4: year-end close — zero P&L (income/expense) into 3200 Retained earnings.
 * Closing entry is entry_type=closing (exclude from P&L via excludeClosingEntries).
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { fiscalYearForDate } from "@/lib/fiscal-year";
import { writeBooksAudit } from "@/server/books/audit";
import { getBooksCloseChecklist } from "@/server/books/close";
import { requireApproverOrAdmin } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal, reverseBooksJournal } from "@/server/books/journals";
import { assertSyntheticTenant } from "@/server/security-gate";

const RE_CODE = "3200";

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Last calendar month of the fiscal year (1–12). */
export function fiscalYearLastMonth(fyStartMonth: number): number {
  const start = Math.min(12, Math.max(1, Math.floor(fyStartMonth) || 1));
  return start === 1 ? 12 : start - 1;
}

export function isFiscalYearEndPeriod(periodEnd: string, fyStartMonth: number): boolean {
  const m = Number(String(periodEnd).slice(5, 7));
  return m === fiscalYearLastMonth(fyStartMonth);
}

/** First day of the fiscal year that contains periodEnd. */
export function fiscalYearStartDate(periodEnd: string, fyStartMonth: number): string {
  const fy = fiscalYearForDate(periodEnd, fyStartMonth);
  const start = Math.min(12, Math.max(1, Math.floor(fyStartMonth) || 1));
  return `${fy}-${String(start).padStart(2, "0")}-01`;
}

/**
 * YTD net on income/expense (posted/reversed), optionally excluding closing entries.
 * Income net = credit − debit; expense net = debit − credit. Net income = income − expense.
 */
export async function booksYearPnlNets(
  db: PoolClient,
  clientId: string,
  fromDate: string,
  toDate: string,
  opts?: { excludeClosingEntries?: boolean },
): Promise<{
  byAccount: Array<{
    accountId: string;
    code: string;
    accountType: string;
    debitMinor: number;
    creditMinor: number;
    netMinor: number;
  }>;
  netIncomeMinor: number;
}> {
  const excludeClosing = Boolean(opts?.excludeClosingEntries);
  // Filter on the entry join must not leave orphan lines in the SUM (classic LEFT JOIN trap).
  const rows = await db.query(
    `SELECT a.id AS "accountId", a.code, a.account_type AS "accountType",
            COALESCE(SUM(x.debit_minor), 0)::bigint AS debit,
            COALESCE(SUM(x.credit_minor), 0)::bigint AS credit
     FROM books_accounts a
     LEFT JOIN (
       SELECT l.account_id, l.debit_minor, l.credit_minor
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE e.client_id = $1
         AND e.status IN ('posted', 'reversed')
         AND e.deleted_at IS NULL
         AND e.entry_date >= $2::date AND e.entry_date <= $3::date
         AND (
           $4::boolean = false
           OR (
             e.entry_type IS DISTINCT FROM 'closing'
             AND NOT EXISTS (
               SELECT 1 FROM books_journal_entries c
               WHERE c.id = e.reverses_entry_id AND c.entry_type = 'closing'
             )
           )
         )
     ) x ON x.account_id = a.id
     WHERE a.client_id = $1 AND a.active = true AND a.is_postable = true
       AND a.account_type IN ('income', 'expense')
     GROUP BY a.id, a.code, a.account_type
     HAVING COALESCE(SUM(x.debit_minor), 0) <> 0 OR COALESCE(SUM(x.credit_minor), 0) <> 0
     ORDER BY a.code`,
    [clientId, fromDate, toDate, excludeClosing],
  );

  const byAccount = rows.rows.map((r) => {
    const debitMinor = Number(r.debit);
    const creditMinor = Number(r.credit);
    const accountType = String(r.accountType);
    const netMinor =
      accountType === "income" ? creditMinor - debitMinor : debitMinor - creditMinor;
    return {
      accountId: String(r.accountId),
      code: String(r.code),
      accountType,
      debitMinor,
      creditMinor,
      netMinor,
    };
  });

  let income = 0;
  let expense = 0;
  for (const a of byAccount) {
    if (a.accountType === "income") income += a.netMinor;
    else expense += a.netMinor;
  }
  return { byAccount, netIncomeMinor: income - expense };
}

export async function closeBooksYearToRE(
  userId: string,
  clientId: string,
  periodId: string,
  note = "",
): Promise<{
  journalEntryId: string;
  fiscalYear: number;
  netIncomeMinor: number;
  entryNo: string | null;
}> {
  // Validate FYE + role before the heavy checklist (clearer error for wrong month).
  const meta = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireApproverOrAdmin(db, userId, "year_end_close");
    const period = await db.query(
      `SELECT id, label, status, period_start, period_end FROM books_periods
       WHERE id = $1 AND client_id = $2`,
      [periodId, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
      throw new BooksError("period_locked", "period_closed");
    }
    const periodEnd = iso(period.rows[0].period_end);
    const client = await db.query(
      `SELECT fiscal_year_start_month FROM clients WHERE id = $1`,
      [clientId],
    );
    const fyStartMonth = Number(client.rows[0]?.fiscal_year_start_month || 1);
    if (!isFiscalYearEndPeriod(periodEnd, fyStartMonth)) {
      throw new BooksError("not_fiscal_year_end_period", "invalid");
    }
    return {
      periodEnd,
      fyStartMonth,
      fiscalYear: fiscalYearForDate(periodEnd, fyStartMonth),
      periodLabel: String(period.rows[0].label),
    };
  });

  const checklist = await getBooksCloseChecklist(userId, clientId, periodId);
  if (!checklist.ready) {
    throw new BooksError("close_checklist_incomplete", "conflict");
  }

  const prepared = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const periodEnd = meta.periodEnd;
    const fyStartMonth = meta.fyStartMonth;
    const fiscalYear = meta.fiscalYear;
    const existing = await db.query(
      `SELECT id, journal_entry_id, reversed_at FROM books_year_end_closes
       WHERE client_id = $1 AND fiscal_year = $2`,
      [clientId, fiscalYear],
    );
    if (existing.rowCount && existing.rows[0].reversed_at == null) {
      throw new BooksError("year_end_already_closed", "conflict");
    }

    const fyStart = fiscalYearStartDate(periodEnd, fyStartMonth);
    const pnl = await booksYearPnlNets(db, clientId, fyStart, periodEnd, {
      excludeClosingEntries: true,
    });
    if (pnl.netIncomeMinor === 0 && pnl.byAccount.every((a) => a.netMinor === 0)) {
      throw new BooksError("nothing_to_close", "invalid");
    }

    const re = await db.query(
      `SELECT id FROM books_accounts WHERE client_id = $1 AND code = $2 AND active = true`,
      [clientId, RE_CODE],
    );
    if (!re.rowCount) throw new BooksError(`account_missing:${RE_CODE}`, "not_found");
    const reId = String(re.rows[0].id);

    type Line = {
      accountId: string;
      debitMinor: number;
      creditMinor: number;
      lineMemo: string;
    };
    const lines: Line[] = [];
    for (const a of pnl.byAccount) {
      if (a.netMinor === 0) continue;
      if (a.accountType === "income") {
        lines.push({
          accountId: a.accountId,
          debitMinor: a.netMinor,
          creditMinor: 0,
          lineMemo: `YE close ${a.code}`,
        });
      } else {
        lines.push({
          accountId: a.accountId,
          debitMinor: 0,
          creditMinor: a.netMinor,
          lineMemo: `YE close ${a.code}`,
        });
      }
    }
    const ni = pnl.netIncomeMinor;
    if (ni > 0) {
      lines.push({
        accountId: reId,
        debitMinor: 0,
        creditMinor: ni,
        lineMemo: "YE close to RE",
      });
    } else if (ni < 0) {
      lines.push({
        accountId: reId,
        debitMinor: -ni,
        creditMinor: 0,
        lineMemo: "YE close to RE",
      });
    }

    let debit = 0;
    let credit = 0;
    for (const l of lines) {
      debit += l.debitMinor;
      credit += l.creditMinor;
    }
    if (debit !== credit || debit === 0) {
      throw new BooksError("journal_unbalanced", "journal_unbalanced");
    }

    return {
      lines,
      ni,
      periodEnd,
      fiscalYear,
      existingId: existing.rowCount ? String(existing.rows[0].id) : null,
    };
  });

  // Outside withUser — nested withUser inside createBooksJournal breaks ref-sequence RLS.
  const draft = await createBooksJournal(userId, clientId, {
    periodId,
    entryDate: prepared.periodEnd,
    memo: `Year-end close FY${prepared.fiscalYear}`,
    // Explicit reference skips books_next_display_ref (RLS on books_ref_sequences is picky).
    reference: `YE-${prepared.fiscalYear}`,
    voucherType: "Closing",
    entryType: "closing",
    lines: prepared.lines,
    post: false,
  });

  return withUser(userId, async (db) => {
    const voucherRow = await db.query(`SELECT books_next_voucher_no($1::uuid, $2, $3) AS n`, [
      clientId,
      "Closing",
      prepared.fiscalYear,
    ]);
    const entryNo = String(voucherRow.rows[0].n);
    const posted = await db.query(
      `UPDATE books_journal_entries
       SET status = 'posted', posted_at = now(), entry_no = $3, voucher_type = 'Closing',
           entry_type = 'closing'
       WHERE id = $1 AND client_id = $2 AND status = 'draft'
       RETURNING id`,
      [draft.id, clientId, entryNo],
    );
    if (!posted.rowCount) throw new BooksError("year_end_post_failed", "conflict");

    if (prepared.existingId) {
      await db.query(
        `UPDATE books_year_end_closes SET
           period_id = $2,
           journal_entry_id = $3,
           net_income_minor = $4,
           closed_by = $5,
           closed_at = now(),
           note = $6,
           reversed_at = NULL,
           reversed_by = NULL,
           reverse_reason = NULL
         WHERE id = $1`,
        [prepared.existingId, periodId, draft.id, prepared.ni, userId, note.trim()],
      );
    } else {
      await db.query(
        `INSERT INTO books_year_end_closes (
           id, client_id, fiscal_year, period_id, journal_entry_id, net_income_minor, closed_by, note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          clientId,
          prepared.fiscalYear,
          periodId,
          draft.id,
          prepared.ni,
          userId,
          note.trim(),
        ],
      );
    }

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "year_end_close",
      entity: "books_year_end_close",
      entityId: draft.id,
      after: {
        fiscalYear: prepared.fiscalYear,
        netIncomeMinor: prepared.ni,
        periodId,
        entryNo,
      },
    });

    return {
      journalEntryId: draft.id,
      fiscalYear: prepared.fiscalYear,
      netIncomeMinor: prepared.ni,
      entryNo,
    };
  });
}

export async function reverseBooksYearEndClose(
  userId: string,
  clientId: string,
  fiscalYear: number,
  reason: string,
  entryDate: string,
): Promise<{ reversalId: string }> {
  const reasonTrim = String(reason || "").trim();
  if (!reasonTrim) throw new BooksError("reversal_reason_required", "invalid");

  const row = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireApproverOrAdmin(db, userId, "year_end_reverse");
    const existing = await db.query(
      `SELECT id, journal_entry_id, reversed_at, closed_by
       FROM books_year_end_closes
       WHERE client_id = $1 AND fiscal_year = $2`,
      [clientId, fiscalYear],
    );
    if (!existing.rowCount) throw new BooksError("year_end_not_found", "not_found");
    if (existing.rows[0].reversed_at != null) {
      throw new BooksError("year_end_already_reversed", "conflict");
    }
    return {
      id: String(existing.rows[0].id),
      journalEntryId: String(existing.rows[0].journal_entry_id),
      closedBy: String(existing.rows[0].closed_by),
    };
  });

  // Dual control: reverse cannot be the same as closer when possible — reverseBooksJournal enforces.
  const rev = await reverseBooksJournal(userId, clientId, row.journalEntryId, entryDate, reasonTrim);

  await withUser(userId, async (db) => {
    await db.query(
      `UPDATE books_year_end_closes
       SET reversed_at = now(), reversed_by = $2, reverse_reason = $3
       WHERE id = $1`,
      [row.id, userId, reasonTrim],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "year_end_reverse",
      entity: "books_year_end_close",
      entityId: row.id,
      after: { fiscalYear, reversalId: rev.reversalId, reason: reasonTrim },
    });
  });

  return { reversalId: rev.reversalId };
}
