/**
 * P5-4: year-end close — zero P&L (income/expense) into 3200 Retained earnings.
 * Closing entry is entry_type=closing (exclude from P&L via excludeClosingEntries).
 * Two steps with dual control: closeBooksYearToRE prepares a draft, postBooksYearEndClose
 * (a different approver/admin) posts it. Only a posted, unreversed entry closes the year.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { fiscalYearForDate } from "@/lib/fiscal-year";
import { writeBooksAudit } from "@/server/books/audit";
import { getBooksCloseChecklist } from "@/server/books/close";
import { requireApproverOrAdmin } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import {
  createBooksJournal,
  postBooksJournalInTx,
  reverseBooksJournal,
} from "@/server/books/journals";
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

type ClosingLine = {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  lineMemo: string;
};

/** Serialise every year-end decision for one (client, fiscal year) inside the caller's tx. */
async function lockFiscalYear(db: PoolClient, clientId: string, fiscalYear: number) {
  await db.query(
    `SELECT pg_advisory_xact_lock(hashtext('books_year_end'), hashtext($1::text || ':' || $2::text))`,
    [clientId, String(fiscalYear)],
  );
}

/** Every period of the fiscal year other than the year-end month must be LOCKED. */
async function requireEarlierPeriodsLocked(
  db: PoolClient,
  clientId: string,
  yearEndPeriodId: string,
  fyStart: string,
  periodEnd: string,
) {
  const open = await db.query(
    `SELECT label FROM books_periods
     WHERE client_id = $1 AND id <> $2
       AND period_start <= $4::date AND period_end >= $3::date
       AND status <> 'LOCKED'
     ORDER BY period_start`,
    [clientId, yearEndPeriodId, fyStart, periodEnd],
  );
  if (open.rowCount) {
    const labels = open.rows.map((r) => String(r.label)).join(",");
    throw new BooksError(`year_has_open_periods:${labels}`, "conflict");
  }
}

/**
 * Closing lines that zero every income/expense account into 3200.
 * A contra balance (net < 0, e.g. sales returns with a debit balance) closes on the other side,
 * so every line stays positive and the entry still balances.
 */
async function buildClosingLines(
  db: PoolClient,
  clientId: string,
  fyStart: string,
  periodEnd: string,
): Promise<{ lines: ClosingLine[]; ni: number }> {
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

  const lines: ClosingLine[] = [];
  for (const a of pnl.byAccount) {
    if (a.netMinor === 0) continue;
    const amount = Math.abs(a.netMinor);
    // Income normally has a credit balance → debit to close; expense the opposite.
    const debitToClose = (a.accountType === "income") === a.netMinor > 0;
    lines.push({
      accountId: a.accountId,
      debitMinor: debitToClose ? amount : 0,
      creditMinor: debitToClose ? 0 : amount,
      lineMemo: `YE close ${a.code}`,
    });
  }
  const ni = pnl.netIncomeMinor;
  if (ni > 0) {
    lines.push({ accountId: reId, debitMinor: 0, creditMinor: ni, lineMemo: "YE close to RE" });
  } else if (ni < 0) {
    lines.push({ accountId: reId, debitMinor: -ni, creditMinor: 0, lineMemo: "YE close to RE" });
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
  return { lines, ni };
}

function lineKeys(lines: Array<{ accountId: string; debitMinor: number; creditMinor: number }>) {
  return lines
    .map((l) => `${l.accountId}:${Number(l.debitMinor)}:${Number(l.creditMinor)}`)
    .sort();
}

async function loadYearEndPeriod(db: PoolClient, clientId: string, periodId: string) {
  const period = await db.query(
    `SELECT id, label, status, period_start, period_end FROM books_periods
     WHERE id = $1 AND client_id = $2`,
    [periodId, clientId],
  );
  if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
  const periodEnd = iso(period.rows[0].period_end);
  const client = await db.query(`SELECT fiscal_year_start_month FROM clients WHERE id = $1`, [
    clientId,
  ]);
  const fyStartMonth = Number(client.rows[0]?.fiscal_year_start_month || 1);
  return {
    status: String(period.rows[0].status),
    label: String(period.rows[0].label),
    periodEnd,
    fyStartMonth,
    fiscalYear: fiscalYearForDate(periodEnd, fyStartMonth),
    fyStart: fiscalYearStartDate(periodEnd, fyStartMonth),
    isYearEnd: isFiscalYearEndPeriod(periodEnd, fyStartMonth),
  };
}

/**
 * Step 1 of 2 (approver/admin): prepare the year-end closing entry as a DRAFT and record it on
 * books_year_end_closes. The year is not closed until a different approver/admin posts it with
 * postBooksYearEndClose. Row semantics (no status column): closed_by/closed_at = preparer;
 * "closed" = journal_entry_id is posted and reversed_at IS NULL.
 */
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
  status: "draft";
}> {
  // Validate FYE + role before the heavy checklist (clearer error for wrong month).
  const meta = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireApproverOrAdmin(db, userId, "year_end_close");
    const p = await loadYearEndPeriod(db, clientId, periodId);
    if (!["OPEN", "REOPENED"].includes(p.status)) {
      throw new BooksError("period_locked", "period_closed");
    }
    if (!p.isYearEnd) throw new BooksError("not_fiscal_year_end_period", "invalid");
    return p;
  });

  const checklist = await getBooksCloseChecklist(userId, clientId, periodId);
  if (!checklist.ready) {
    throw new BooksError("close_checklist_incomplete", "conflict");
  }

  const prepared = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireEarlierPeriodsLocked(db, clientId, periodId, meta.fyStart, meta.periodEnd);
    // Fast refusal before creating a draft; the authoritative check runs again under the lock.
    const existing = await db.query(
      `SELECT y.reversed_at, e.status AS journal_status, e.deleted_at AS journal_deleted_at
       FROM books_year_end_closes y
       LEFT JOIN books_journal_entries e ON e.id = y.journal_entry_id
       WHERE y.client_id = $1 AND y.fiscal_year = $2`,
      [clientId, meta.fiscalYear],
    );
    if (existing.rowCount && existing.rows[0].reversed_at == null) {
      if (existing.rows[0].journal_deleted_at == null) {
        throw new BooksError(
          existing.rows[0].journal_status === "draft"
            ? "year_end_pending_post"
            : "year_end_already_closed",
          "conflict",
        );
      }
    }
    return buildClosingLines(db, clientId, meta.fyStart, meta.periodEnd);
  });

  // Outside withUser — nested withUser inside createBooksJournal breaks ref-sequence RLS.
  const draft = await createBooksJournal(userId, clientId, {
    periodId,
    entryDate: meta.periodEnd,
    memo: `Year-end close FY${meta.fiscalYear}`,
    // Explicit reference skips books_next_display_ref (RLS on books_ref_sequences is picky).
    reference: `YE-${meta.fiscalYear}`,
    voucherType: "Closing",
    entryType: "closing",
    lines: prepared.lines,
    post: false,
  });

  try {
    await withUser(userId, async (db) => {
      await assertSyntheticTenant(db, clientId);
      await lockFiscalYear(db, clientId, meta.fiscalYear);
      await requireEarlierPeriodsLocked(db, clientId, periodId, meta.fyStart, meta.periodEnd);
      const existing = await db.query(
        `SELECT y.id, y.journal_entry_id, y.reversed_at,
                e.status AS journal_status, e.deleted_at AS journal_deleted_at
         FROM books_year_end_closes y
         LEFT JOIN books_journal_entries e ON e.id = y.journal_entry_id
         WHERE y.client_id = $1 AND y.fiscal_year = $2
         FOR UPDATE OF y`,
        [clientId, meta.fiscalYear],
      );
      if (!existing.rowCount) {
        await db.query(
          `INSERT INTO books_year_end_closes (
             id, client_id, fiscal_year, period_id, journal_entry_id, net_income_minor, closed_by, note
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            clientId,
            meta.fiscalYear,
            periodId,
            draft.id,
            prepared.ni,
            userId,
            note.trim(),
          ],
        );
      } else {
        const row = existing.rows[0];
        const reversed = row.reversed_at != null;
        const discarded = row.journal_deleted_at != null;
        if (!reversed && !discarded) {
          throw new BooksError(
            row.journal_status === "draft" ? "year_end_pending_post" : "year_end_already_closed",
            "conflict",
          );
        }
        // Re-prepare only after a reverse (or a discarded draft); compare-and-swap on the old
        // journal so a concurrent re-close cannot both win.
        const updated = await db.query(
          `UPDATE books_year_end_closes SET
             period_id = $3,
             journal_entry_id = $4,
             net_income_minor = $5,
             closed_by = $6,
             closed_at = now(),
             note = $7,
             reversed_at = NULL,
             reversed_by = NULL,
             reverse_reason = NULL
           WHERE id = $1 AND journal_entry_id = $2
             AND (
               reversed_at IS NOT NULL
               OR EXISTS (
                 SELECT 1 FROM books_journal_entries d
                 WHERE d.id = $2 AND d.deleted_at IS NOT NULL
               )
             )`,
          [
            String(row.id),
            String(row.journal_entry_id),
            periodId,
            draft.id,
            prepared.ni,
            userId,
            note.trim(),
          ],
        );
        if (!updated.rowCount) throw new BooksError("year_end_already_closed", "conflict");
      }

      await writeBooksAudit(db, {
        clientId,
        actor: userId,
        action: "year_end_prepare",
        entity: "books_year_end_close",
        entityId: draft.id,
        after: { fiscalYear: meta.fiscalYear, netIncomeMinor: prepared.ni, periodId },
      });
    });
  } catch (err) {
    // Lost the race (or the year changed under us): do not leave an orphan draft behind.
    await withUser(userId, async (db) => {
      await db.query(
        `UPDATE books_journal_entries SET deleted_at = now()
         WHERE id = $1 AND client_id = $2 AND status = 'draft' AND deleted_at IS NULL`,
        [draft.id, clientId],
      );
      await writeBooksAudit(db, {
        clientId,
        actor: userId,
        action: "soft_delete",
        entity: "books_journal_entry",
        entityId: draft.id,
        after: { reason: "year_end_prepare_failed" },
      });
    }).catch(() => undefined);
    throw err;
  }

  return {
    journalEntryId: draft.id,
    fiscalYear: meta.fiscalYear,
    netIncomeMinor: prepared.ni,
    entryNo: null,
    status: "draft",
  };
}

/**
 * Step 2 of 2: a DIFFERENT approver/admin posts the prepared closing entry (postBooksJournal
 * checks: dual control vs the draft's created_by, writable period/date, changed-since-close).
 * Refuses if the P&L moved since the draft was prepared (discard the draft and re-prepare).
 */
export async function postBooksYearEndClose(
  userId: string,
  clientId: string,
  fiscalYear: number,
): Promise<{
  journalEntryId: string;
  fiscalYear: number;
  netIncomeMinor: number;
  entryNo: string;
  status: "posted";
}> {
  if (!Number.isInteger(fiscalYear)) throw new BooksError("fiscal_year_required", "invalid");

  const pending = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireApproverOrAdmin(db, userId, "year_end_post");
    const row = await db.query(
      `SELECT y.id, y.period_id, y.journal_entry_id, y.reversed_at,
              e.status AS journal_status, e.deleted_at AS journal_deleted_at, e.created_by
       FROM books_year_end_closes y
       JOIN books_journal_entries e ON e.id = y.journal_entry_id
       WHERE y.client_id = $1 AND y.fiscal_year = $2`,
      [clientId, fiscalYear],
    );
    if (!row.rowCount) throw new BooksError("year_end_not_found", "not_found");
    const r = row.rows[0];
    if (r.reversed_at != null || r.journal_deleted_at != null) {
      throw new BooksError("year_end_not_prepared", "conflict");
    }
    if (r.journal_status !== "draft") throw new BooksError("year_end_already_closed", "conflict");
    if (String(r.created_by) === userId) {
      throw new BooksError("post_preparer_cannot_approve", "forbidden");
    }
    return { periodId: String(r.period_id), journalEntryId: String(r.journal_entry_id) };
  });

  const checklist = await getBooksCloseChecklist(userId, clientId, pending.periodId);
  if (!checklist.ready) {
    throw new BooksError("close_checklist_incomplete", "conflict");
  }

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await lockFiscalYear(db, clientId, fiscalYear);
    const row = await db.query(
      `SELECT id, period_id, journal_entry_id, reversed_at, net_income_minor
       FROM books_year_end_closes
       WHERE client_id = $1 AND fiscal_year = $2
       FOR UPDATE`,
      [clientId, fiscalYear],
    );
    if (
      !row.rowCount ||
      row.rows[0].reversed_at != null ||
      String(row.rows[0].journal_entry_id) !== pending.journalEntryId
    ) {
      throw new BooksError("year_end_changed", "conflict");
    }
    const p = await loadYearEndPeriod(db, clientId, pending.periodId);
    await requireEarlierPeriodsLocked(db, clientId, pending.periodId, p.fyStart, p.periodEnd);

    const expected = await buildClosingLines(db, clientId, p.fyStart, p.periodEnd);
    const draftLines = await db.query(
      `SELECT account_id AS "accountId", debit_minor AS "debitMinor", credit_minor AS "creditMinor"
       FROM books_journal_lines WHERE entry_id = $1`,
      [pending.journalEntryId],
    );
    const want = lineKeys(expected.lines);
    const have = lineKeys(draftLines.rows);
    if (want.length !== have.length || want.some((k, i) => k !== have[i])) {
      throw new BooksError("year_end_draft_stale", "conflict");
    }

    const posted = await postBooksJournalInTx(db, userId, clientId, pending.journalEntryId);
    const netIncomeMinor = Number(row.rows[0].net_income_minor);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "year_end_close",
      entity: "books_year_end_close",
      entityId: pending.journalEntryId,
      after: {
        fiscalYear,
        netIncomeMinor,
        periodId: pending.periodId,
        entryNo: posted.entryNo,
      },
    });
    return {
      journalEntryId: pending.journalEntryId,
      fiscalYear,
      netIncomeMinor,
      entryNo: posted.entryNo,
      status: "posted",
    };
  });
}

export type BooksYearEndStatus = {
  isYearEndPeriod: boolean;
  fiscalYear: number;
  state: "none" | "draft" | "posted" | "reversed" | "discarded";
  journalEntryId: string | null;
  netIncomeMinor: number | null;
  preparedBy: string | null;
  preparedByName: string | null;
  entryNo: string | null;
  /** Current user may post the prepared draft (approver/admin and not the preparer). */
  canPost: boolean;
};

export async function getBooksYearEndStatus(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<BooksYearEndStatus> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const p = await loadYearEndPeriod(db, clientId, periodId);
    const row = await db.query(
      `SELECT y.journal_entry_id, y.net_income_minor, y.closed_by, y.reversed_at,
              u.name AS closed_by_name,
              e.status AS journal_status, e.deleted_at AS journal_deleted_at, e.entry_no
       FROM books_year_end_closes y
       LEFT JOIN books_journal_entries e ON e.id = y.journal_entry_id
       LEFT JOIN users u ON u.id = y.closed_by
       WHERE y.client_id = $1 AND y.fiscal_year = $2`,
      [clientId, p.fiscalYear],
    );
    const role = await db.query(`SELECT role FROM users WHERE id = $1`, [userId]);
    const isApprover = ["admin", "approver"].includes(String(role.rows[0]?.role || ""));
    if (!row.rowCount) {
      return {
        isYearEndPeriod: p.isYearEnd,
        fiscalYear: p.fiscalYear,
        state: "none",
        journalEntryId: null,
        netIncomeMinor: null,
        preparedBy: null,
        preparedByName: null,
        entryNo: null,
        canPost: false,
      };
    }
    const r = row.rows[0];
    const state: BooksYearEndStatus["state"] =
      r.reversed_at != null
        ? "reversed"
        : r.journal_deleted_at != null
          ? "discarded"
          : r.journal_status === "draft"
            ? "draft"
            : "posted";
    return {
      isYearEndPeriod: p.isYearEnd,
      fiscalYear: p.fiscalYear,
      state,
      journalEntryId: String(r.journal_entry_id),
      netIncomeMinor: Number(r.net_income_minor),
      preparedBy: String(r.closed_by),
      preparedByName: r.closed_by_name ? String(r.closed_by_name) : null,
      entryNo: r.entry_no ? String(r.entry_no) : null,
      canPost: state === "draft" && isApprover && String(r.closed_by) !== userId,
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
      `SELECT y.id, y.journal_entry_id, y.reversed_at, y.closed_by, e.status AS journal_status
       FROM books_year_end_closes y
       JOIN books_journal_entries e ON e.id = y.journal_entry_id
       WHERE y.client_id = $1 AND y.fiscal_year = $2`,
      [clientId, fiscalYear],
    );
    if (!existing.rowCount) throw new BooksError("year_end_not_found", "not_found");
    if (existing.rows[0].reversed_at != null) {
      throw new BooksError("year_end_already_reversed", "conflict");
    }
    if (existing.rows[0].journal_status !== "posted") {
      throw new BooksError("year_end_not_posted", "conflict");
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
    await lockFiscalYear(db, clientId, fiscalYear);
    const marked = await db.query(
      `UPDATE books_year_end_closes
       SET reversed_at = now(), reversed_by = $2, reverse_reason = $3
       WHERE id = $1 AND reversed_at IS NULL AND journal_entry_id = $4`,
      [row.id, userId, reasonTrim, row.journalEntryId],
    );
    if (!marked.rowCount) throw new BooksError("year_end_already_reversed", "conflict");
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
