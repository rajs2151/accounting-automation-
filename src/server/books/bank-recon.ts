/**
 * P2B-3: bank reconciliation check per bank/card/gateway account and monthly period.
 *
 *   ledger balance at period end (posted journal lines on the account, account currency)
 *     vs statement balance at period end (opening + credits − debits up to that date;
 *        the statement's closing balance when it ends exactly on that date)
 *
 * Read-only — never posts. The difference is explained by an unreconciled list:
 *  - statement_only: statement lines up to period end not yet in the ledger (not materialised,
 *    needs review, ready but not posted, or excluded);
 *  - ledger_only: posted journal lines on the account (from the first statement's start date to
 *    period end) that no posted bank transaction produced (manual journals, cheques not yet cleared, …).
 * unexplainedMinor = difference − (Σ statement_only − Σ ledger_only); non-zero means opening balances
 * disagree or a statement line and its journal differ in amount.
 *
 * Sign convention (same as statement recheck): statement balance = opening + credits − debits;
 * ledger = Σ debit − Σ credit. A card statement therefore shows money owed as a negative balance.
 */
import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { normalizeIban } from "@/lib/statement-coverage";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export type BankReconStatus = "reconciled" | "difference" | "no_statement";

export type BankReconItem = {
  kind: "statement_only" | "ledger_only";
  /** statement_only: not_materialized | needs_review | ready | excluded; ledger_only: journal */
  state: string;
  date: string | null;
  description: string;
  /** Signed, account currency: + money in (statement credit / ledger debit). */
  amountMinor: number;
  statementLineId: string | null;
  bankTransactionId: string | null;
  journalEntryId: string | null;
  entryNo: string | null;
};

export type BankReconSummary = {
  accountId: string;
  code: string;
  name: string;
  currency: string;
  periodId: string;
  periodLabel: string;
  asOf: string;
  status: BankReconStatus;
  ledgerBalanceMinor: number;
  statementBalanceMinor: number | null;
  differenceMinor: number | null;
  statementId: string | null;
  statementOnlyCount: number;
  statementOnlyNetMinor: number;
  ledgerOnlyCount: number;
  ledgerOnlyNetMinor: number;
  unexplainedMinor: number | null;
  /** Ledger lines on this account in another currency (cannot be compared to the statement). */
  foreignCurrencyLineCount: number;
};

export type BankReconDetail = BankReconSummary & { items: BankReconItem[] };

function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

const BANKISH = `(a.is_bank = true OR a.is_card = true OR a.is_gateway = true
  OR COALESCE(a.sub_type, '') IN ('bank','cash','card','gateway','clearing'))`;

async function loadPeriod(db: PoolClient, clientId: string, periodId: string) {
  const p = await db.query(
    `SELECT id, label, period_start, period_end FROM books_periods WHERE id = $1 AND client_id = $2`,
    [periodId, clientId],
  );
  if (!p.rowCount) throw new BooksError("period_not_found", "not_found");
  return {
    id: String(p.rows[0].id),
    label: String(p.rows[0].label),
    end: iso(p.rows[0].period_end)!,
  };
}

/** Statements linked to the account (explicit account_id, else IBAN match), usable for balances. */
async function linkedStatementIds(
  db: PoolClient,
  clientId: string,
  account: { id: string; iban: string | null },
) {
  const rows = await db.query(
    `SELECT id, account_id, iban FROM books_statement_extractions
     WHERE client_id = $1 AND status <> 'failed'`,
    [clientId],
  );
  const nib = normalizeIban(account.iban);
  return rows.rows
    .filter(
      (s) =>
        String(s.account_id || "") === account.id ||
        (!s.account_id && nib && normalizeIban(s.iban as string | null) === nib),
    )
    .map((s) => String(s.id));
}

async function reconcileOne(
  db: PoolClient,
  clientId: string,
  account: { id: string; code: string; name: string; currency: string; iban: string | null },
  period: { id: string; label: string; end: string },
  withItems: boolean,
): Promise<BankReconDetail> {
  const asOf = period.end;
  const currency = account.currency.toUpperCase();
  const stmtIds = await linkedStatementIds(db, clientId, account);

  // Ledger balance in the account's currency (AED accounts: debit − credit; foreign: original amounts).
  const ledger = await db.query(
    `SELECT
       COALESCE(SUM(CASE
         WHEN $3::text = 'AED' THEN l.debit_minor - l.credit_minor
         WHEN UPPER(l.currency) = $3::text THEN
           CASE WHEN l.debit_minor > 0 THEN COALESCE(l.original_minor, l.debit_minor)
                ELSE -COALESCE(l.original_minor, l.credit_minor) END
         ELSE 0 END), 0)::bigint AS bal,
       COUNT(*) FILTER (WHERE $3::text <> 'AED' AND UPPER(l.currency) <> $3::text)::int AS foreign_n
     FROM books_journal_lines l
     JOIN books_journal_entries e ON e.id = l.entry_id
     WHERE e.client_id = $1 AND l.account_id = $2
       AND e.status IN ('posted', 'reversed') AND e.deleted_at IS NULL
       AND e.entry_date <= $4::date`,
    [clientId, account.id, currency, asOf],
  );
  const ledgerBalanceMinor = Number(ledger.rows[0].bal);
  const foreignCurrencyLineCount = Number(ledger.rows[0].foreign_n);

  // Statement covering period end (latest-ending, most recently created wins).
  let statementId: string | null = null;
  let statementBalanceMinor: number | null = null;
  let firstFrom: string | null = null;
  if (stmtIds.length) {
    const cover = await db.query(
      `SELECT id, period_from, period_to, opening_balance_minor, closing_balance_minor
       FROM books_statement_extractions
       WHERE id = ANY($1::uuid[]) AND period_from <= $2::date AND period_to >= $2::date
         AND opening_balance_minor IS NOT NULL
       ORDER BY period_to DESC, created_at DESC
       LIMIT 1`,
      [stmtIds, asOf],
    );
    if (cover.rowCount) {
      const s = cover.rows[0];
      statementId = String(s.id);
      if (iso(s.period_to) === asOf && s.closing_balance_minor != null) {
        statementBalanceMinor = Number(s.closing_balance_minor);
      } else {
        const sum = await db.query(
          `SELECT COALESCE(SUM(credit_minor - debit_minor), 0)::bigint AS n
           FROM books_statement_lines WHERE statement_id = $1 AND line_date <= $2::date`,
          [statementId, asOf],
        );
        statementBalanceMinor = Number(s.opening_balance_minor) + Number(sum.rows[0].n);
      }
    }
    const first = await db.query(
      `SELECT MIN(period_from) AS f FROM books_statement_extractions WHERE id = ANY($1::uuid[])`,
      [stmtIds],
    );
    firstFrom = iso(first.rows[0].f);
  }

  const items: BankReconItem[] = [];
  let statementOnlyCount = 0;
  let statementOnlyNetMinor = 0;
  let ledgerOnlyCount = 0;
  let ledgerOnlyNetMinor = 0;

  if (stmtIds.length) {
    const stmtOnly = await db.query(
      `SELECT sl.id AS line_id, sl.line_date, sl.description,
              (sl.credit_minor - sl.debit_minor)::bigint AS amt,
              t.id AS txn_id, t.review_status
       FROM books_statement_lines sl
       LEFT JOIN books_bank_transactions t ON t.statement_line_id = sl.id
       WHERE sl.statement_id = ANY($1::uuid[]) AND sl.line_date <= $2::date
         AND (t.id IS NULL OR t.review_status <> 'posted')
       ORDER BY sl.line_date, sl.sort_index`,
      [stmtIds, asOf],
    );
    for (const r of stmtOnly.rows) {
      statementOnlyCount += 1;
      statementOnlyNetMinor += Number(r.amt);
      if (withItems) {
        items.push({
          kind: "statement_only",
          state: r.txn_id ? String(r.review_status) : "not_materialized",
          date: iso(r.line_date),
          description: String(r.description || ""),
          amountMinor: Number(r.amt),
          statementLineId: String(r.line_id),
          bankTransactionId: r.txn_id ? String(r.txn_id) : null,
          journalEntryId: null,
          entryNo: null,
        });
      }
    }
  }

  if (firstFrom) {
    const ledgerOnly = await db.query(
      `SELECT e.id, e.entry_no, e.entry_date, e.memo, l.line_memo,
              (CASE
                 WHEN $3::text = 'AED' THEN l.debit_minor - l.credit_minor
                 WHEN l.debit_minor > 0 THEN COALESCE(l.original_minor, l.debit_minor)
                 ELSE -COALESCE(l.original_minor, l.credit_minor) END)::bigint AS amt
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE e.client_id = $1 AND l.account_id = $2
         AND e.status IN ('posted', 'reversed') AND e.deleted_at IS NULL
         AND e.entry_date >= $4::date AND e.entry_date <= $5::date
         AND ($3::text = 'AED' OR UPPER(l.currency) = $3::text)
         AND NOT EXISTS (
           SELECT 1 FROM books_bank_transactions t
           WHERE t.client_id = $1 AND t.account_id = $2
             AND t.review_status = 'posted' AND t.journal_entry_id = e.id
         )
       ORDER BY e.entry_date, e.entry_no`,
      [clientId, account.id, currency, firstFrom, asOf],
    );
    for (const r of ledgerOnly.rows) {
      ledgerOnlyCount += 1;
      ledgerOnlyNetMinor += Number(r.amt);
      if (withItems) {
        items.push({
          kind: "ledger_only",
          state: "journal",
          date: iso(r.entry_date),
          description: String(r.line_memo || r.memo || ""),
          amountMinor: Number(r.amt),
          statementLineId: null,
          bankTransactionId: null,
          journalEntryId: String(r.id),
          entryNo: r.entry_no ? String(r.entry_no) : null,
        });
      }
    }
  }

  const differenceMinor =
    statementBalanceMinor == null ? null : statementBalanceMinor - ledgerBalanceMinor;
  const status: BankReconStatus =
    statementBalanceMinor == null ? "no_statement" : differenceMinor === 0 ? "reconciled" : "difference";

  return {
    accountId: account.id,
    code: account.code,
    name: account.name,
    currency,
    periodId: period.id,
    periodLabel: period.label,
    asOf,
    status,
    ledgerBalanceMinor,
    statementBalanceMinor,
    differenceMinor,
    statementId,
    statementOnlyCount,
    statementOnlyNetMinor,
    ledgerOnlyCount,
    ledgerOnlyNetMinor,
    unexplainedMinor:
      differenceMinor == null ? null : differenceMinor - (statementOnlyNetMinor - ledgerOnlyNetMinor),
    foreignCurrencyLineCount,
    items,
  };
}

async function loadAccounts(db: PoolClient, clientId: string, accountId?: string) {
  const rows = await db.query(
    `SELECT a.id, a.code, a.name, a.currency, a.iban
     FROM books_accounts a
     WHERE a.client_id = $1 AND a.active = true AND a.is_postable = true AND ${BANKISH}
       AND ($2::uuid IS NULL OR a.id = $2::uuid)
     ORDER BY a.code`,
    [clientId, accountId || null],
  );
  return rows.rows.map((a) => ({
    id: String(a.id),
    code: String(a.code),
    name: String(a.name),
    currency: String(a.currency || "AED"),
    iban: (a.iban as string | null) || null,
  }));
}

/** Reconciliation detail (with the unreconciled list) for one account + period. */
export async function getBankReconciliation(
  userId: string,
  clientId: string,
  opts: { accountId: string; periodId: string },
): Promise<BankReconDetail> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const [account] = await loadAccounts(db, clientId, opts.accountId);
    if (!account) throw new BooksError("account_not_found", "not_found");
    const period = await loadPeriod(db, clientId, opts.periodId);
    return reconcileOne(db, clientId, account, period, true);
  });
}

/** Summary row per bank/card/gateway account for one period (Banking page column, dashboard). */
export async function listBankReconciliations(
  userId: string,
  clientId: string,
  opts: { periodId: string },
): Promise<BankReconSummary[]> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const period = await loadPeriod(db, clientId, opts.periodId);
    const out: BankReconSummary[] = [];
    for (const account of await loadAccounts(db, clientId)) {
      const { items: _items, ...summary } = await reconcileOne(db, clientId, account, period, false);
      void _items;
      out.push(summary);
    }
    return out;
  });
}
