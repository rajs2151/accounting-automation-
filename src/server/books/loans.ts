/**
 * Phase 3 rank 9: loan register + monthly interest accrual (Dr 7400 / Cr 2420).
 * Monthly interest = floor(principal × annual_rate_bps / 12 / 10_000) fils.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal, softDeleteBooksJournalDraft } from "@/server/books/journals";
import { assertSyntheticTenant } from "@/server/security-gate";

const DEFAULT_LIABILITY = "2420";
const DEFAULT_EXPENSE = "7400";

export type LoanRow = {
  id: string;
  name: string;
  lender: string;
  principalMinor: number;
  annualRateBps: number;
  startDate: string;
  endDate: string | null;
  liabilityAccountId: string;
  interestExpenseAccountId: string;
  active: boolean;
  monthlyInterestMinor: number;
};

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Floor fils: principal × rate_bps / 12 / 10_000. */
export function monthlyLoanInterestMinor(principalMinor: number, annualRateBps: number): number {
  const p = Math.trunc(Number(principalMinor) || 0);
  const bps = Math.trunc(Number(annualRateBps) || 0);
  if (p <= 0 || bps < 0) return 0;
  return Math.floor((p * bps) / (12 * 10_000));
}

function loanActiveInPeriod(loan: { startDate: string; endDate: string | null; active: boolean }, periodEnd: string) {
  if (!loan.active) return false;
  if (loan.startDate > periodEnd) return false;
  if (loan.endDate && loan.endDate < periodEnd.slice(0, 8) + "01") return false;
  return true;
}

async function accountIdByCode(db: PoolClient, clientId: string, code: string): Promise<string> {
  const row = await db.query(
    `SELECT id FROM books_accounts WHERE client_id = $1 AND code = $2 AND postable = true`,
    [clientId, code],
  );
  if (!row.rowCount) throw new BooksError(`account_missing:${code}`, "not_found");
  return String(row.rows[0].id);
}

export async function listBooksLoans(userId: string, clientId: string): Promise<LoanRow[]> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const ready = await db.query(`SELECT to_regclass('books_loans') AS t`);
    if (!ready.rows[0]?.t) return [];
    const rows = await db.query(
      `SELECT id, name, lender, principal_minor, annual_rate_bps, start_date, end_date,
              liability_account_id, interest_expense_account_id, active
       FROM books_loans WHERE client_id = $1 ORDER BY start_date, name`,
      [clientId],
    );
    return rows.rows.map((r) => {
      const principalMinor = Number(r.principal_minor);
      const annualRateBps = Number(r.annual_rate_bps);
      return {
        id: String(r.id),
        name: String(r.name),
        lender: String(r.lender || ""),
        principalMinor,
        annualRateBps,
        startDate: iso(r.start_date),
        endDate: r.end_date == null ? null : iso(r.end_date),
        liabilityAccountId: String(r.liability_account_id),
        interestExpenseAccountId: String(r.interest_expense_account_id),
        active: Boolean(r.active),
        monthlyInterestMinor: monthlyLoanInterestMinor(principalMinor, annualRateBps),
      };
    });
  });
}

export async function createBooksLoan(
  userId: string,
  clientId: string,
  body: {
    name: string;
    lender?: string;
    principalMinor: number;
    annualRateBps: number;
    startDate: string;
    endDate?: string | null;
    liabilityAccountId?: string;
    interestExpenseAccountId?: string;
  },
): Promise<LoanRow> {
  const name = String(body.name || "").trim();
  if (!name) throw new BooksError("name_required", "invalid");
  const principalMinor = Math.trunc(Number(body.principalMinor));
  const annualRateBps = Math.trunc(Number(body.annualRateBps));
  if (!Number.isFinite(principalMinor) || principalMinor <= 0) {
    throw new BooksError("bad_loan_principal", "invalid");
  }
  if (!Number.isFinite(annualRateBps) || annualRateBps < 0) {
    throw new BooksError("bad_loan_rate", "invalid");
  }
  const startDate = String(body.startDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new BooksError("invalid_date", "invalid");

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const ready = await db.query(`SELECT to_regclass('books_loans') AS t`);
    if (!ready.rows[0]?.t) throw new BooksError("loans_not_migrated", "not_found");

    const liabilityAccountId =
      body.liabilityAccountId || (await accountIdByCode(db, clientId, DEFAULT_LIABILITY));
    const interestExpenseAccountId =
      body.interestExpenseAccountId || (await accountIdByCode(db, clientId, DEFAULT_EXPENSE));
    const id = randomUUID();
    await db.query(
      `INSERT INTO books_loans (
         id, client_id, name, lender, principal_minor, annual_rate_bps, start_date, end_date,
         liability_account_id, interest_expense_account_id, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        clientId,
        name,
        String(body.lender || "").trim(),
        principalMinor,
        annualRateBps,
        startDate,
        body.endDate ? String(body.endDate).slice(0, 10) : null,
        liabilityAccountId,
        interestExpenseAccountId,
        userId,
      ],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_loan",
      entityId: id,
      after: { name, principalMinor, annualRateBps, startDate },
    });
    return {
      id,
      name,
      lender: String(body.lender || "").trim(),
      principalMinor,
      annualRateBps,
      startDate,
      endDate: body.endDate ? String(body.endDate).slice(0, 10) : null,
      liabilityAccountId,
      interestExpenseAccountId,
      active: true,
      monthlyInterestMinor: monthlyLoanInterestMinor(principalMinor, annualRateBps),
    };
  });
}

export async function missingLoanInterest(
  db: PoolClient,
  clientId: string,
  periodId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Array<{ id: string; name: string; amountMinor: number }>> {
  const ready = await db.query(`SELECT to_regclass('books_loans') AS t`);
  if (!ready.rows[0]?.t) return [];
  const loans = await db.query(
    `SELECT l.id, l.name, l.principal_minor, l.annual_rate_bps, l.start_date, l.end_date, l.active
     FROM books_loans l
     WHERE l.client_id = $1 AND l.active = true
       AND NOT EXISTS (
         SELECT 1 FROM books_loan_interest_runs r
         WHERE r.loan_id = l.id AND r.period_id = $2
       )`,
    [clientId, periodId],
  );
  const missing: Array<{ id: string; name: string; amountMinor: number }> = [];
  for (const r of loans.rows) {
    const loan = {
      startDate: iso(r.start_date),
      endDate: r.end_date == null ? null : iso(r.end_date),
      active: Boolean(r.active),
    };
    if (!loanActiveInPeriod(loan, periodEnd)) continue;
    if (loan.startDate > periodEnd) continue;
    // First interest month = month containing start_date (full month).
    if (loan.startDate.slice(0, 7) > periodStart.slice(0, 7)) continue;
    const amountMinor = monthlyLoanInterestMinor(Number(r.principal_minor), Number(r.annual_rate_bps));
    if (amountMinor <= 0) continue;
    missing.push({ id: String(r.id), name: String(r.name), amountMinor });
  }
  return missing;
}

export async function runBooksLoanInterest(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<{ posted: number; skipped: number; entryIds: string[] }> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const ready = await db.query(`SELECT to_regclass('books_loans') AS t`);
    if (!ready.rows[0]?.t) throw new BooksError("loans_not_migrated", "not_found");

    const period = await db.query(
      `SELECT id, period_start, period_end, status, label FROM books_periods
       WHERE id = $1 AND client_id = $2`,
      [periodId, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    if (String(period.rows[0].status) === "LOCKED") {
      throw new BooksError("period_locked", "period_closed");
    }
    const periodStart = iso(period.rows[0].period_start);
    const periodEnd = iso(period.rows[0].period_end);
    const label = String(period.rows[0].label);

    const due = await missingLoanInterest(db, clientId, periodId, periodStart, periodEnd);
    let posted = 0;
    let skipped = 0;
    const entryIds: string[] = [];

    for (const loan of due) {
      const full = await db.query(
        `SELECT liability_account_id, interest_expense_account_id FROM books_loans
         WHERE id = $1 AND client_id = $2`,
        [loan.id, clientId],
      );
      if (!full.rowCount) {
        skipped += 1;
        continue;
      }
      const draft = await createBooksJournal(userId, clientId, {
        periodId,
        entryDate: periodEnd,
        memo: `Loan interest — ${loan.name} (${label})`,
        voucherType: "Journal",
        templateKey: "loan_interest",
        tags: ["loan_interest"],
        post: false,
        lines: [
          {
            accountId: String(full.rows[0].interest_expense_account_id),
            debitMinor: loan.amountMinor,
            creditMinor: 0,
            lineMemo: "Interest expense",
          },
          {
            accountId: String(full.rows[0].liability_account_id),
            debitMinor: 0,
            creditMinor: loan.amountMinor,
            lineMemo: "Accrue loan interest",
          },
        ],
      });
      try {
        // Post requires dual control — leave as draft if creator can't post; still record run after post.
        // For close gate, we require a posted run. Use allow: mark run only when posted by a second actor.
        // Minimal: create draft and insert run linked after soft post attempt fails → keep draft for approver.
        // Simpler product rule: insert run when draft created? No — gate would pass without posting.
        // Match depreciation: depreciation posts in same flow with dual control bypass for system runs?
        // Looking at FA — runBooksDepreciation posts with allowControl and dual control of creator...
        // For loans: create draft only; gate fails until posted. Track pending via missing = no run row.
        // So we need post. Use post:false and tell UI to approve. Gate checks for posted run.
        // Insert run only after successful post by calling postBooksJournal — needs different user.
        // Practical approach: create+post as draft then require approver via journals UI; gate looks for
        // either a run OR a draft with template loan_interest for the period.
        // Cleanest for today: insert run with journal_entry_id of draft; gate requires journal status=posted.
        await db.query(
          `INSERT INTO books_loan_interest_runs (id, client_id, loan_id, period_id, amount_minor, journal_entry_id)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (loan_id, period_id) DO NOTHING`,
          [randomUUID(), clientId, loan.id, periodId, loan.amountMinor, draft.id],
        );
        entryIds.push(draft.id);
        posted += 1;
      } catch (err) {
        try {
          await softDeleteBooksJournalDraft(userId, clientId, draft.id);
        } catch {
          /* ignore */
        }
        throw err;
      }
    }
    return { posted, skipped, entryIds };
  });
}

/** Close gate helper: active loans due this period without a *posted* interest journal. */
export async function loanInterestGateState(
  db: PoolClient,
  clientId: string,
  periodId: string,
  periodStart: string,
  periodEnd: string,
): Promise<{ status: "pass" | "fail"; count: number; detail: string }> {
  const ready = await db.query(`SELECT to_regclass('books_loans') AS t`);
  if (!ready.rows[0]?.t) {
    return { status: "pass", count: 0, detail: "Loan register not set up" };
  }
  const due = await missingLoanInterest(db, clientId, periodId, periodStart, periodEnd);
  // Also fail if a run exists but journal is still draft.
  const unposted = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM books_loan_interest_runs r
     JOIN books_journal_entries e ON e.id = r.journal_entry_id
     WHERE r.client_id = $1 AND r.period_id = $2
       AND e.status IN ('draft','scheduled') AND e.deleted_at IS NULL`,
    [clientId, periodId],
  );
  const unpostedN = Number(unposted.rows[0].n);
  const missingN = due.length;
  const count = missingN + unpostedN;
  if (count === 0) {
    return { status: "pass", count: 0, detail: "Loan interest posted (or no loans due)" };
  }
  const parts = [
    missingN ? `${missingN} loan(s) missing interest accrual` : null,
    unpostedN ? `${unpostedN} interest draft(s) still unposted` : null,
  ].filter(Boolean);
  return { status: "fail", count, detail: parts.join("; ") };
}
