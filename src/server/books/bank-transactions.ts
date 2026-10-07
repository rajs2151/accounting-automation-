import {
  BANK_TXN_ALLOC_KINDS,
  bankTxnUnallocatedMinor,
  type BankTxnAllocKind,
} from "@/lib/bank-txn-alloc";
import { scoreBankOpenItemMatch, subsetSumBundle } from "@/lib/bank-txn-match-score";
import { BANK_TXN_TYPES, type BooksBankTxnType } from "@/lib/bank-txn-types";
import { withUser } from "@/lib/db";
import { aedFromOriginal } from "@/lib/fx";
import { normalizeIban } from "@/lib/statement-coverage";
import { writeBooksAudit } from "@/server/books/audit";
import { requireDualControlActor } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { isBooksControlAccountCode } from "@/server/books/control-accounts";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createContra, createReceiptOrPayment } from "@/server/books/settlements";
import { assertSyntheticTenant } from "@/server/security-gate";
import type { PoolClient } from "pg";

export type { BooksBankTxnType, BankTxnAllocKind };
export { BANK_TXN_TYPES, BANK_TXN_ALLOC_KINDS, bankTxnUnallocatedMinor };
export type BooksBankTxnReviewStatus = "needs_review" | "ready" | "excluded" | "posted";

const HARD_BLOCK_FLAGS = [
  "iban_account_mismatch",
  "account_attribution_ambiguous",
  "closing_mismatch",
  "running_balance_break",
  "balances_not_found",
] as const;

function flagsArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Closing FX rate on/before txn date; AED → 1.0. Foreign without a rate → hard fail. */
async function resolveBankFxRateScaled(
  db: PoolClient,
  clientId: string,
  currency: string,
  txnDate: string,
): Promise<number> {
  const ccy = (currency || "AED").toUpperCase();
  if (ccy === "AED") return 100_000_000;
  const row = await db.query(
    `SELECT rate_scaled FROM books_fx_rates
     WHERE client_id = $1 AND currency = $2 AND rate_date <= $3::date
     ORDER BY rate_date DESC LIMIT 1`,
    [clientId, ccy, txnDate],
  );
  if (!row.rowCount) throw new BooksError(`fx_rate_required:${ccy}`, "invalid");
  return Number(row.rows[0].rate_scaled);
}

function bankMoneyLine(
  accountId: string,
  side: "debit" | "credit",
  originalMinor: number,
  currency: string,
  fxRateScaled: number,
) {
  const aed = aedFromOriginal(originalMinor, fxRateScaled);
  return {
    accountId,
    debitMinor: side === "debit" ? aed : 0,
    creditMinor: side === "credit" ? aed : 0,
    aedMinor: aed,
    currency,
    originalMinor,
    fxRateScaled,
  };
}

/** Only statements with a passing balance check may materialise bank lines. */
function statementEligible(status: string, flags: string[]): boolean {
  if (status !== "ready" && status !== "confirmed" && status !== "needs_review") return false;
  if (!flags.includes("balance_ok")) return false;
  for (const b of HARD_BLOCK_FLAGS) {
    if (flags.includes(b)) return false;
  }
  return true;
}

function isoDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

export type BooksBankTransactionRow = {
  id: string;
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  statementId: string;
  statementLineId: string;
  txnDate: string | null;
  valueDate: string | null;
  description: string;
  reference: string | null;
  currency: string;
  debitMinor: number;
  creditMinor: number;
  /** Credit = money in; debit = money out (bank statement convention). */
  amountSignedMinor: number;
  reviewStatus: BooksBankTxnReviewStatus;
  txnType: BooksBankTxnType | null;
  categoryAccountId: string | null;
  categoryAccountCode: string | null;
  categoryAccountName: string | null;
  note: string;
  excludeReason: string | null;
  monthKey: string | null;
  openItemId: string | null;
  openItemLabel: string | null;
  linkedTxnId: string | null;
  linkedTxnLabel: string | null;
  journalEntryId: string | null;
  entryNo: string | null;
  suggestionSource: string | null;
  payoutGroupKey: string | null;
};

const GATEWAY_CLEARING_CODES = ["1310", "1320", "1330"] as const;
const CARD_PAYABLE_CODE = "2150";
const DEFAULT_GATEWAY_CLEARING_CODE = "1310";

async function accountIdByCode(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: Array<{ id: string }> }> },
  clientId: string,
  code: string,
): Promise<string | null> {
  const r = await db.query(
    `SELECT id FROM books_accounts
     WHERE client_id = $1 AND code = $2 AND active = true AND is_postable = true`,
    [clientId, code],
  );
  return r.rowCount ? String(r.rows[0].id) : null;
}

/** Category JV must never hit AR/AP/VAT controls without settling a party open item. */
async function assertCategoryNotControlWithoutOpenItem(
  userId: string,
  clientId: string,
  categoryAccountId: string,
) {
  await withUser(userId, async (db) => {
    const r = await db.query(
      `SELECT code FROM books_accounts WHERE id = $1 AND client_id = $2`,
      [categoryAccountId, clientId],
    );
    if (r.rowCount && isBooksControlAccountCode(String(r.rows[0].code))) {
      throw new BooksError(`control_account_requires_open_item:${r.rows[0].code}`, "invalid");
    }
  });
}

async function hasPayoutGroupColumn(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;
}) {
  const col = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'books_bank_transactions' AND column_name = 'payout_group_key'`,
  );
  return Boolean(col.rowCount);
}

/**
 * Clearing impact for a payout group line (fils): gateway_payout credits clearing;
 * money-out lines categorised to a gateway clearing COA debit clearing.
 * When the group is complete (no needs_review left), net must be 0.
 */
function clearingImpactMinor(row: {
  txn_type?: unknown;
  debit_minor?: unknown;
  credit_minor?: unknown;
  category_code?: unknown;
}): number {
  const type = String(row.txn_type || "");
  const debit = Number(row.debit_minor || 0);
  const credit = Number(row.credit_minor || 0);
  const cat = row.category_code != null ? String(row.category_code) : "";
  if (type === "gateway_payout") return credit; // Cr clearing
  if (GATEWAY_CLEARING_CODES.includes(cat as (typeof GATEWAY_CLEARING_CODES)[number])) {
    // Dr clearing (money out vs clearing) − Cr clearing (money in vs clearing)
    return credit - debit;
  }
  return 0;
}

async function hasLinkedTxnColumn(db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> }) {
  const col = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'books_bank_transactions' AND column_name = 'linked_txn_id'`,
  );
  return Boolean(col.rowCount);
}

function txnAmountMinor(row: { debit_minor?: unknown; credit_minor?: unknown; debitMinor?: unknown; creditMinor?: unknown }) {
  const debit = Number(row.debit_minor ?? row.debitMinor ?? 0);
  const credit = Number(row.credit_minor ?? row.creditMinor ?? 0);
  return Math.max(debit, credit);
}

function isMoneyOut(row: { debit_minor?: unknown; credit_minor?: unknown }) {
  return Number(row.debit_minor || 0) > 0;
}

export type BankTxnAllocInput = {
  allocKind: BankTxnAllocKind;
  openItemId?: string | null;
  accountId?: string | null;
  partyId?: string | null;
  amountOriginalMinor: number;
  note?: string;
};

export type BankTxnAllocRow = BankTxnAllocInput & {
  id: string;
  bankTxnId: string;
};

async function hasAllocTable(db: {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
}) {
  const t = await db.query(`SELECT to_regclass('books_bank_txn_allocations') AS t`);
  return Boolean(t.rows[0]?.t);
}

function isMoneyIn(row: { debit_minor?: unknown; credit_minor?: unknown }) {
  return Number(row.credit_minor || 0) > 0;
}

function parseTxnType(raw: unknown): BooksBankTxnType | null {
  if (raw == null || raw === "") return null;
  const s = String(raw);
  return (BANK_TXN_TYPES as readonly string[]).includes(s) ? (s as BooksBankTxnType) : null;
}

/** Insert missing bank txns from eligible statement lines. Idempotent on statement_line_id. */
export async function materializeBooksBankTransactions(
  userId: string,
  clientId: string,
  opts?: { accountId?: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);

    const table = await db.query(`SELECT to_regclass('books_bank_transactions') AS t`);
    if (!table.rows[0]?.t) {
      throw new BooksError("c3_bank_transactions_migration_required", "invalid");
    }

    const accounts = await db.query(
      `SELECT id, iban FROM books_accounts
       WHERE client_id = $1 AND active = true
         AND (
           is_bank = true OR is_card = true OR is_gateway = true
           OR COALESCE(sub_type, '') IN ('bank','cash','card','gateway','clearing')
         )`,
      [clientId],
    );
    const byIban = new Map<string, string>();
    for (const a of accounts.rows) {
      const nib = normalizeIban(a.iban as string | null);
      if (nib && !byIban.has(nib)) byIban.set(nib, String(a.id));
    }

    const stmts = await db.query(
      `SELECT s.id, s.account_id AS "accountId", s.iban, s.status,
              s.validation_flags AS "validationFlags"
       FROM books_statement_extractions s
       WHERE s.client_id = $1
         AND ($2::uuid IS NULL OR s.account_id = $2
              OR REPLACE(UPPER(COALESCE(s.iban,'')), ' ', '') IN (
                SELECT REPLACE(UPPER(COALESCE(a.iban,'')), ' ', '')
                FROM books_accounts a
                WHERE a.id = $2 AND a.client_id = $1
              ))`,
      [clientId, opts?.accountId || null],
    );

    let inserted = 0;
    for (const s of stmts.rows) {
      const flags = flagsArray(s.validationFlags);
      if (!statementEligible(String(s.status), flags)) continue;

      let accountId = s.accountId ? String(s.accountId) : null;
      if (!accountId) {
        const nib = normalizeIban(s.iban as string | null);
        if (nib) accountId = byIban.get(nib) || null;
      }
      if (!accountId) continue;
      if (opts?.accountId && accountId !== opts.accountId) continue;

      const lines = await db.query(
        `SELECT l.id, l.line_date, l.value_date, l.description, l.reference,
                l.currency, l.debit_minor, l.credit_minor
         FROM books_statement_lines l
         WHERE l.statement_id = $1 AND l.client_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM books_bank_transactions t WHERE t.statement_line_id = l.id
           )
         ORDER BY l.sort_index`,
        [s.id, clientId],
      );

      for (const ln of lines.rows) {
        const debit = Number(ln.debit_minor || 0);
        const credit = Number(ln.credit_minor || 0);
        if (!Number.isInteger(debit) || !Number.isInteger(credit)) {
          throw new BooksError("non_integer_money", "invalid_money");
        }
        if (debit > 0 && credit > 0) continue;

        await db.query(
          `INSERT INTO books_bank_transactions (
             client_id, account_id, statement_id, statement_line_id,
             txn_date, value_date, description, reference, currency,
             debit_minor, credit_minor, review_status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'needs_review')
           ON CONFLICT (statement_line_id) DO NOTHING`,
          [
            clientId,
            accountId,
            s.id,
            ln.id,
            ln.line_date,
            ln.value_date,
            String(ln.description || ""),
            ln.reference,
            String(ln.currency || "AED"),
            debit,
            credit,
          ],
        );
        inserted += 1;
      }
    }

    if (inserted > 0) {
      await writeBooksAudit(db, {
        clientId,
        actor: userId,
        action: "materialize_bank_transactions",
        entity: "books_bank_transactions",
        entityId: clientId,
        after: { inserted, accountId: opts?.accountId || null },
      });
    }

    return { inserted };
  });
}

/**
 * Auto-link unique opposite-amount pairs across different accounts (±3 days).
 * Only when exactly one counterpart exists; sets txn_type=transfer on both.
 */
export async function autoLinkTransferPairs(userId: string, clientId: string) {
  if (!(await withUser(userId, (db) => hasLinkedTxnColumn(db)))) {
    return { linked: 0 };
  }
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const outs = await db.query(
      `SELECT id, account_id, debit_minor, credit_minor, txn_date, currency, linked_txn_id
       FROM books_bank_transactions
       WHERE client_id = $1
         AND review_status IN ('needs_review', 'ready')
         AND debit_minor > 0 AND credit_minor = 0
         AND linked_txn_id IS NULL
       ORDER BY txn_date NULLS LAST`,
      [clientId],
    );
    let linked = 0;
    for (const out of outs.rows) {
      if (out.linked_txn_id) continue;
      const amt = Number(out.debit_minor || 0);
      const d = isoDate(out.txn_date);
      const cands = await db.query(
        `SELECT id FROM books_bank_transactions
         WHERE client_id = $1
           AND review_status IN ('needs_review', 'ready')
           AND credit_minor = $2 AND debit_minor = 0
           AND account_id <> $3
           AND currency = $4
           AND linked_txn_id IS NULL
           AND ($5::date IS NULL OR txn_date BETWEEN $5::date - 3 AND $5::date + 3)`,
        [clientId, amt, out.account_id, out.currency || "AED", d],
      );
      if ((cands.rowCount ?? 0) !== 1) continue;
      const innId = String(cands.rows[0].id);
      await db.query(
        `UPDATE books_bank_transactions SET
           linked_txn_id = $3,
           txn_type = COALESCE(txn_type, 'transfer'),
           updated_at = now()
         WHERE client_id = $2 AND id = $1 AND linked_txn_id IS NULL`,
        [out.id, clientId, innId],
      );
      await db.query(
        `UPDATE books_bank_transactions SET
           linked_txn_id = $3,
           txn_type = COALESCE(txn_type, 'transfer'),
           updated_at = now()
         WHERE client_id = $2 AND id = $1 AND linked_txn_id IS NULL`,
        [innId, clientId, out.id],
      );
      linked += 1;
    }
    if (linked > 0) {
      await writeBooksAudit(db, {
        clientId,
        actor: userId,
        action: "auto_link_transfer_pairs",
        entity: "books_bank_transactions",
        entityId: clientId,
        after: { linked },
      });
    }
    return { linked };
  });
}

export async function listBooksBankTransactions(
  userId: string,
  clientId: string,
  opts?: {
    accountId?: string;
    status?: string;
    q?: string;
    unmatchedOnly?: boolean;
    materialize?: boolean;
  },
) {
  if (opts?.materialize !== false) {
    await materializeBooksBankTransactions(userId, clientId, {
      accountId: opts?.accountId,
    });
    try {
      await autoLinkTransferPairs(userId, clientId);
    } catch {
      /* transfer link optional */
    }
    // P2A-3: suggest type/category from rules (Needs Review, unset type only).
    try {
      const { applyBooksBankRuleSuggestions } = await import("@/server/books/bank-rules");
      await applyBooksBankRuleSuggestions(userId, clientId, { accountId: opts?.accountId });
    } catch {
      /* rules migration optional */
    }
  }

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const status = opts?.status && opts.status !== "all" ? opts.status : null;
    const q = opts?.q?.trim() || null;
    const unmatchedOnly = Boolean(opts?.unmatchedOnly);
    const hasLink = await hasLinkedTxnColumn(db);
    const hasPayout = await hasPayoutGroupColumn(db);
    const sugCol = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'books_bank_transactions' AND column_name = 'suggestion_source'`,
    );
    const hasSug = Boolean(sugCol.rowCount);
    const linkSelect = hasLink
      ? `t.linked_txn_id AS "linkedTxnId",
              CASE WHEN lt.id IS NULL THEN NULL
                   ELSE COALESCE(la.code, '') || ' · ' || COALESCE(lt.description, '')
              END AS "linkedTxnLabel",`
      : `NULL::uuid AS "linkedTxnId", NULL::text AS "linkedTxnLabel",`;
    const sugSelect = hasSug
      ? `t.suggestion_source AS "suggestionSource",`
      : `NULL::text AS "suggestionSource",`;
    const payoutSelect = hasPayout
      ? `t.payout_group_key AS "payoutGroupKey",`
      : `NULL::text AS "payoutGroupKey",`;
    const linkJoin = hasLink
      ? `LEFT JOIN books_bank_transactions lt ON lt.id = t.linked_txn_id
       LEFT JOIN books_accounts la ON la.id = lt.account_id`
      : "";
    const rows = await db.query(
      `SELECT t.id, t.account_id AS "accountId",
              a.code AS "accountCode", a.name AS "accountName",
              t.statement_id AS "statementId",
              t.statement_line_id AS "statementLineId",
              t.txn_date AS "txnDate", t.value_date AS "valueDate",
              t.description, t.reference, t.currency,
              t.debit_minor AS "debitMinor", t.credit_minor AS "creditMinor",
              t.review_status AS "reviewStatus", t.txn_type AS "txnType",
              t.category_account_id AS "categoryAccountId",
              ca.code AS "categoryAccountCode", ca.name AS "categoryAccountName",
              t.note, t.exclude_reason AS "excludeReason",
              t.open_item_id AS "openItemId",
              ${linkSelect}
              ${sugSelect}
              ${payoutSelect}
              t.journal_entry_id AS "journalEntryId",
              je.entry_no AS "entryNo",
              CASE WHEN oi.id IS NULL THEN NULL
                   ELSE COALESCE(d.document_number, '') || ' · ' || COALESCE(p.name, '')
                        || ' · open ' || oi.open_original_minor::text
              END AS "openItemLabel"
       FROM books_bank_transactions t
       JOIN books_accounts a ON a.id = t.account_id
       LEFT JOIN books_accounts ca ON ca.id = t.category_account_id
       LEFT JOIN books_open_items oi ON oi.id = t.open_item_id
       LEFT JOIN books_parties p ON p.id = oi.party_id
       LEFT JOIN books_documents d ON d.id = oi.document_id
       LEFT JOIN books_journal_entries je ON je.id = t.journal_entry_id
       ${linkJoin}
       WHERE t.client_id = $1
         AND ($2::uuid IS NULL OR t.account_id = $2)
         AND ($3::text IS NULL OR t.review_status = $3)
         AND (
           $4::text IS NULL
           OR t.description ILIKE '%' || $4 || '%'
           OR COALESCE(t.reference,'') ILIKE '%' || $4 || '%'
         )
         AND (
           NOT $5::boolean
           OR (t.review_status = 'needs_review' AND t.open_item_id IS NULL)
         )
       ORDER BY t.txn_date DESC NULLS LAST, t.created_at DESC`,
      [clientId, opts?.accountId || null, status, q, unmatchedOnly],
    );

    return rows.rows.map((r): BooksBankTransactionRow => {
      const debit = Number(r.debitMinor || 0);
      const credit = Number(r.creditMinor || 0);
      const txnDate = isoDate(r.txnDate);
      return {
        id: String(r.id),
        accountId: String(r.accountId),
        accountCode: r.accountCode ? String(r.accountCode) : null,
        accountName: r.accountName ? String(r.accountName) : null,
        statementId: String(r.statementId),
        statementLineId: String(r.statementLineId),
        txnDate,
        valueDate: isoDate(r.valueDate),
        description: String(r.description || ""),
        reference: r.reference == null ? null : String(r.reference),
        currency: String(r.currency || "AED"),
        debitMinor: debit,
        creditMinor: credit,
        amountSignedMinor: credit - debit,
        reviewStatus: String(r.reviewStatus) as BooksBankTxnReviewStatus,
        txnType: parseTxnType(r.txnType),
        categoryAccountId: r.categoryAccountId ? String(r.categoryAccountId) : null,
        categoryAccountCode: r.categoryAccountCode ? String(r.categoryAccountCode) : null,
        categoryAccountName: r.categoryAccountName ? String(r.categoryAccountName) : null,
        note: String(r.note || ""),
        excludeReason: r.excludeReason == null ? null : String(r.excludeReason),
        monthKey: txnDate ? txnDate.slice(0, 7) : null,
        openItemId: r.openItemId ? String(r.openItemId) : null,
        openItemLabel: r.openItemLabel ? String(r.openItemLabel).trim() : null,
        linkedTxnId: r.linkedTxnId ? String(r.linkedTxnId) : null,
        linkedTxnLabel: r.linkedTxnLabel ? String(r.linkedTxnLabel).trim() : null,
        journalEntryId: r.journalEntryId ? String(r.journalEntryId) : null,
        entryNo: r.entryNo != null ? String(r.entryNo) : null,
        suggestionSource: r.suggestionSource ? String(r.suggestionSource) : null,
        payoutGroupKey: r.payoutGroupKey ? String(r.payoutGroupKey) : null,
      };
    });
  });
}

export async function updateBooksBankTransaction(
  userId: string,
  clientId: string,
  id: string,
  body: {
    txnType?: string | null;
    categoryAccountId?: string | null;
    note?: string;
    payoutGroupKey?: string | null;
  },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!before.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const row = before.rows[0];
    if (!["needs_review", "ready"].includes(String(row.review_status))) {
      throw new BooksError("bank_txn_not_editable", "conflict");
    }

    let txnType = row.txn_type;
    if (body.txnType !== undefined) {
      if (body.txnType == null || body.txnType === "") {
        txnType = null;
      } else {
        const parsed = parseTxnType(body.txnType);
        if (!parsed) throw new BooksError("invalid_txn_type", "invalid");
        txnType = parsed;
      }
    }

    let categoryAccountId = row.category_account_id;
    if (body.categoryAccountId !== undefined) {
      if (body.categoryAccountId == null || body.categoryAccountId === "") {
        categoryAccountId = null;
      } else {
        const acc = await db.query(
          `SELECT id FROM books_accounts
           WHERE id = $1 AND client_id = $2 AND active = true AND is_postable = true`,
          [body.categoryAccountId, clientId],
        );
        if (!acc.rowCount) throw new BooksError("account_not_found", "not_found");
        // Control codes (1210/2110/…) may be staged as the category for receipt/payment
        // matching; posting still refuses a bare category JV to those accounts.
        categoryAccountId = acc.rows[0].id;
      }
    }

    const note = body.note !== undefined ? String(body.note) : String(row.note || "");

    const hasPayout = await hasPayoutGroupColumn(db);
    let payoutGroupKey =
      hasPayout && row.payout_group_key != null ? String(row.payout_group_key) : null;
    if (hasPayout && body.payoutGroupKey !== undefined) {
      const raw = body.payoutGroupKey == null ? "" : String(body.payoutGroupKey).trim();
      payoutGroupKey = raw || null;
    }

    // Editing a Ready row after category change drops back to Needs Review.
    let reviewStatus = String(row.review_status);
    if (
      reviewStatus === "ready" &&
      (body.txnType !== undefined ||
        body.categoryAccountId !== undefined ||
        body.payoutGroupKey !== undefined)
    ) {
      reviewStatus = "needs_review";
    }

    const typeChangedAwayFromTransfer =
      body.txnType !== undefined && String(row.txn_type) === "transfer" && txnType !== "transfer";
    if (typeChangedAwayFromTransfer && row.linked_txn_id && (await hasLinkedTxnColumn(db))) {
      await db.query(
        `UPDATE books_bank_transactions SET linked_txn_id = NULL, updated_at = now()
         WHERE client_id = $1 AND (id = $2 OR id = $3 OR linked_txn_id = $2 OR linked_txn_id = $3)`,
        [clientId, id, row.linked_txn_id],
      );
    }

    if (hasPayout) {
      await db.query(
        `UPDATE books_bank_transactions SET
           txn_type = $3,
           category_account_id = $4,
           note = $5,
           review_status = $6,
           payout_group_key = $7,
           reviewed_by = CASE WHEN $6 = 'needs_review' THEN NULL ELSE reviewed_by END,
           reviewed_at = CASE WHEN $6 = 'needs_review' THEN NULL ELSE reviewed_at END,
           updated_at = now()
         WHERE id = $1 AND client_id = $2`,
        [id, clientId, txnType, categoryAccountId, note, reviewStatus, payoutGroupKey],
      );
    } else {
      await db.query(
        `UPDATE books_bank_transactions SET
           txn_type = $3,
           category_account_id = $4,
           note = $5,
           review_status = $6,
           reviewed_by = CASE WHEN $6 = 'needs_review' THEN NULL ELSE reviewed_by END,
           reviewed_at = CASE WHEN $6 = 'needs_review' THEN NULL ELSE reviewed_at END,
           updated_at = now()
         WHERE id = $1 AND client_id = $2`,
        [id, clientId, txnType, categoryAccountId, note, reviewStatus],
      );
    }

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update_bank_transaction",
      entity: "books_bank_transaction",
      entityId: id,
      before: {
        txn_type: row.txn_type,
        category_account_id: row.category_account_id,
        note: row.note,
        review_status: row.review_status,
        payout_group_key: hasPayout ? row.payout_group_key : undefined,
      },
      after: {
        txn_type: txnType,
        category_account_id: categoryAccountId,
        note,
        review_status: reviewStatus,
        payout_group_key: hasPayout ? payoutGroupKey : undefined,
      },
    });

    return { id, txnType, categoryAccountId, note, reviewStatus, payoutGroupKey };
  });
}

export async function markBooksBankTransactionReviewed(
  userId: string,
  clientId: string,
  id: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!before.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const row = before.rows[0];
    if (String(row.review_status) === "excluded") {
      throw new BooksError("bank_txn_excluded", "conflict");
    }
    if (String(row.review_status) === "posted") {
      throw new BooksError("bank_txn_posted", "conflict");
    }
    if (!row.txn_type) throw new BooksError("txn_type_required", "invalid");
    const txnType = String(row.txn_type);
    // Transfers / card / gateway resolve counterpart at post (COA 2150 / 1310 defaults).
    if (
      txnType !== "transfer" &&
      txnType !== "customer_receipt" &&
      txnType !== "supplier_payment" &&
      txnType !== "card_repayment" &&
      txnType !== "gateway_payout"
    ) {
      if (!row.category_account_id) throw new BooksError("category_account_required", "invalid");
    }
    if (txnType === "customer_receipt" || txnType === "supplier_payment") {
      if (!(await hasAllocTable(db))) {
        if (!row.category_account_id) throw new BooksError("category_account_required", "invalid");
      } else {
        const allocs = await db.query(
          `SELECT alloc_kind AS "allocKind", amount_original_minor AS "amountOriginalMinor"
           FROM books_bank_txn_allocations WHERE client_id = $1 AND bank_txn_id = $2`,
          [clientId, id],
        );
        if (allocs.rowCount && allocs.rowCount > 0) {
          const bankAmt =
            txnType === "customer_receipt"
              ? Number(row.credit_minor || 0)
              : Number(row.debit_minor || 0);
          const unallocated = bankTxnUnallocatedMinor(
            bankAmt,
            allocs.rows.map((r) => ({
              allocKind: String(r.allocKind),
              amountOriginalMinor: Number(r.amountOriginalMinor),
            })),
            txnType === "customer_receipt" ? "receipt" : "payment",
          );
          if (unallocated !== 0) throw new BooksError("settlement_unallocated_nonzero", "invalid");
        } else if (!row.category_account_id && !row.open_item_id) {
          throw new BooksError("category_account_required", "invalid");
        }
      }
    }

    await db.query(
      `UPDATE books_bank_transactions SET
         review_status = 'ready', reviewed_by = $3, reviewed_at = now(), updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [id, clientId, userId],
    );

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "mark_bank_transaction_reviewed",
      entity: "books_bank_transaction",
      entityId: id,
      before: { review_status: row.review_status },
      after: { review_status: "ready" },
    });

    return { id, reviewStatus: "ready" as const };
  });
}

export async function excludeBooksBankTransaction(
  userId: string,
  clientId: string,
  id: string,
  reason: string,
) {
  const excludeReason = String(reason || "").trim();
  if (!excludeReason) throw new BooksError("exclude_reason_required", "invalid");

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!before.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const row = before.rows[0];
    if (String(row.review_status) === "posted") {
      throw new BooksError("bank_txn_posted", "conflict");
    }

    const hasLink = await hasLinkedTxnColumn(db);
    if (hasLink && row.linked_txn_id) {
      await db.query(
        `UPDATE books_bank_transactions SET linked_txn_id = NULL, updated_at = now()
         WHERE client_id = $1 AND (id = $2 OR id = $3 OR linked_txn_id = $2 OR linked_txn_id = $3)`,
        [clientId, id, row.linked_txn_id],
      );
    }

    await db.query(
      hasLink
        ? `UPDATE books_bank_transactions SET
             review_status = 'excluded', exclude_reason = $3,
             reviewed_by = $4, reviewed_at = now(), updated_at = now(),
             linked_txn_id = NULL
           WHERE id = $1 AND client_id = $2`
        : `UPDATE books_bank_transactions SET
             review_status = 'excluded', exclude_reason = $3,
             reviewed_by = $4, reviewed_at = now(), updated_at = now()
           WHERE id = $1 AND client_id = $2`,
      [id, clientId, excludeReason, userId],
    );

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "exclude_bank_transaction",
      entity: "books_bank_transaction",
      entityId: id,
      before: { review_status: row.review_status },
      after: { review_status: "excluded", exclude_reason: excludeReason },
    });

    return { id, reviewStatus: "excluded" as const, excludeReason };
  });
}

export async function listBooksBankTxnAllocations(
  userId: string,
  clientId: string,
  txnId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasAllocTable(db))) return [];
    const rows = await db.query(
      `SELECT id, bank_txn_id AS "bankTxnId", alloc_kind AS "allocKind",
              open_item_id AS "openItemId", account_id AS "accountId",
              party_id AS "partyId", amount_original_minor AS "amountOriginalMinor",
              note
       FROM books_bank_txn_allocations
       WHERE client_id = $1 AND bank_txn_id = $2
       ORDER BY created_at, id`,
      [clientId, txnId],
    );
    return rows.rows.map(
      (r): BankTxnAllocRow => ({
        id: String(r.id),
        bankTxnId: String(r.bankTxnId),
        allocKind: String(r.allocKind) as BankTxnAllocKind,
        openItemId: r.openItemId ? String(r.openItemId) : null,
        accountId: r.accountId ? String(r.accountId) : null,
        partyId: r.partyId ? String(r.partyId) : null,
        amountOriginalMinor: Number(r.amountOriginalMinor),
        note: String(r.note || ""),
      }),
    );
  });
}

/** Replace draft allocations for a bank txn. Enforces kinds + party consistency. */
export async function setBooksBankTxnAllocations(
  userId: string,
  clientId: string,
  txnId: string,
  lines: BankTxnAllocInput[],
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasAllocTable(db))) {
      throw new BooksError("p2a_bank_txn_alloc_migration_required", "invalid");
    }
    const txn = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [txnId, clientId],
    );
    if (!txn.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const row = txn.rows[0];
    if (!["needs_review", "ready"].includes(String(row.review_status))) {
      throw new BooksError("bank_txn_not_editable", "conflict");
    }
    const txnType = String(row.txn_type || "");
    if (txnType !== "customer_receipt" && txnType !== "supplier_payment") {
      throw new BooksError("match_requires_receipt_or_payment", "invalid");
    }
    const side = txnType === "customer_receipt" ? "AR" : "AP";
    const bankAmt =
      side === "AR" ? Number(row.credit_minor || 0) : Number(row.debit_minor || 0);
    if (bankAmt <= 0) throw new BooksError("match_amount_direction", "invalid");

    let partyId: string | null = null;
    const normalized: BankTxnAllocInput[] = [];
    for (const raw of lines) {
      const kind = String(raw.allocKind || "") as BankTxnAllocKind;
      if (!(BANK_TXN_ALLOC_KINDS as readonly string[]).includes(kind)) {
        throw new BooksError("invalid_alloc_kind", "invalid");
      }
      const amount = Number(raw.amountOriginalMinor);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new BooksError("invalid_money", "invalid_money");
      }
      if (kind === "against_item") {
        if (!raw.openItemId) throw new BooksError("open_item_required", "invalid");
        const oi = await db.query(
          `SELECT id, party_id, side, currency, open_original_minor, status
           FROM books_open_items WHERE id = $1 AND client_id = $2`,
          [raw.openItemId, clientId],
        );
        if (!oi.rowCount) throw new BooksError("open_item_not_found", "not_found");
        if (String(oi.rows[0].side) !== side) throw new BooksError("side_mismatch", "invalid");
        if (!["open", "partial"].includes(String(oi.rows[0].status))) {
          throw new BooksError("open_item_not_open", "invalid");
        }
        if (String(oi.rows[0].currency) !== String(row.currency || "AED")) {
          throw new BooksError("currency_mismatch", "invalid");
        }
        if (amount > Number(oi.rows[0].open_original_minor)) {
          throw new BooksError("allocation_exceeds_open", "invalid");
        }
        const p = String(oi.rows[0].party_id);
        if (partyId && partyId !== p) throw new BooksError("party_mismatch", "invalid");
        partyId = p;
        normalized.push({
          allocKind: kind,
          openItemId: String(oi.rows[0].id),
          partyId: p,
          amountOriginalMinor: amount,
          note: raw.note || "",
        });
      } else if (kind === "on_account" || kind === "advance") {
        if (!raw.partyId) throw new BooksError("party_required", "invalid");
        const p = String(raw.partyId);
        const party = await db.query(
          `SELECT id FROM books_parties WHERE id = $1 AND client_id = $2`,
          [p, clientId],
        );
        if (!party.rowCount) throw new BooksError("party_not_found", "not_found");
        if (partyId && partyId !== p) throw new BooksError("party_mismatch", "invalid");
        partyId = p;
        normalized.push({
          allocKind: kind,
          partyId: p,
          amountOriginalMinor: amount,
          note: raw.note || "",
        });
      } else {
        if (!raw.accountId) throw new BooksError("account_not_found", "invalid");
        const acc = await db.query(
          `SELECT id FROM books_accounts
           WHERE id = $1 AND client_id = $2 AND active = true AND is_postable = true`,
          [raw.accountId, clientId],
        );
        if (!acc.rowCount) throw new BooksError("account_not_found", "not_found");
        normalized.push({
          allocKind: kind,
          accountId: String(acc.rows[0].id),
          amountOriginalMinor: amount,
          note: raw.note || "",
        });
      }
    }

    const unallocated = bankTxnUnallocatedMinor(
      bankAmt,
      normalized,
      side === "AR" ? "receipt" : "payment",
    );

    await db.query(`DELETE FROM books_bank_txn_allocations WHERE client_id = $1 AND bank_txn_id = $2`, [
      clientId,
      txnId,
    ]);
    for (const n of normalized) {
      await db.query(
        `INSERT INTO books_bank_txn_allocations (
           client_id, bank_txn_id, alloc_kind, open_item_id, account_id, party_id,
           amount_original_minor, note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          clientId,
          txnId,
          n.allocKind,
          n.openItemId || null,
          n.accountId || null,
          n.partyId || null,
          n.amountOriginalMinor,
          n.note || "",
        ],
      );
    }

    const firstItem = normalized.find((n) => n.allocKind === "against_item");
    // Demote Ready only when the plan no longer balances (unallocated ≠ 0).
    await db.query(
      `UPDATE books_bank_transactions SET
         open_item_id = $3,
         review_status = CASE
           WHEN review_status = 'ready' AND $4::bigint <> 0 THEN 'needs_review'
           ELSE review_status
         END,
         reviewed_by = CASE
           WHEN review_status = 'ready' AND $4::bigint <> 0 THEN NULL
           ELSE reviewed_by
         END,
         reviewed_at = CASE
           WHEN review_status = 'ready' AND $4::bigint <> 0 THEN NULL
           ELSE reviewed_at
         END,
         updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [txnId, clientId, firstItem?.openItemId || null, unallocated],
    );

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "set_bank_txn_allocations",
      entity: "books_bank_transaction",
      entityId: txnId,
      after: { lines: normalized.length, unallocatedMinor: unallocated },
    });

    return {
      id: txnId,
      unallocatedMinor: unallocated,
      lines: await listBooksBankTxnAllocations(userId, clientId, txnId),
    };
  });
}

/** Suggest open AR/AP items with weighted score breakdown (P2A-2). */
export async function listBooksBankTxnMatchCandidates(
  userId: string,
  clientId: string,
  txnId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const txn = await db.query(
      `SELECT id, txn_type, currency, debit_minor, credit_minor, review_status,
              txn_date, description, reference
       FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [txnId, clientId],
    );
    if (!txn.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const row = txn.rows[0];
    const txnType = String(row.txn_type || "");
    let side: "AR" | "AP" | null = null;
    if (txnType === "customer_receipt") side = "AR";
    if (txnType === "supplier_payment") side = "AP";
    if (!side) return { candidates: [], bundle: null as null };

    const amount =
      side === "AR" ? Number(row.credit_minor || 0) : Number(row.debit_minor || 0);
    const currency = String(row.currency || "AED");
    const directionOk =
      (side === "AR" && Number(row.credit_minor || 0) > 0) ||
      (side === "AP" && Number(row.debit_minor || 0) > 0);

    const rejected = await db.query(
      `SELECT open_item_id FROM books_bank_txn_rejected_matches
       WHERE client_id = $1 AND bank_txn_id = $2`,
      [clientId, txnId],
    ).catch(() => ({ rows: [] as Array<{ open_item_id: unknown }> }));
    const rejectedIds = new Set(rejected.rows.map((r) => String(r.open_item_id)));

    const rows = await db.query(
      `SELECT oi.id, oi.party_id AS "partyId", p.name AS "partyName",
              oi.open_original_minor AS "openOriginalMinor",
              oi.currency, d.document_number AS "documentNumber",
              d.issue_date AS "issueDate"
       FROM books_open_items oi
       JOIN books_parties p ON p.id = oi.party_id
       LEFT JOIN books_documents d ON d.id = oi.document_id
       WHERE oi.client_id = $1 AND oi.side = $2 AND oi.status IN ('open','partial')
         AND oi.currency = $3 AND oi.open_original_minor > 0
       ORDER BY oi.open_original_minor ASC
       LIMIT 80`,
      [clientId, side, currency],
    );

    const scored = rows.rows
      .filter((r) => !rejectedIds.has(String(r.id)))
      .map((r) => {
        const fit = scoreBankOpenItemMatch({
          bankAmountMinor: amount,
          openAmountMinor: Number(r.openOriginalMinor),
          bankDateIso: isoDate(row.txn_date),
          openDateIso: isoDate(r.issueDate),
          bankDescription: String(row.description || ""),
          partyName: String(r.partyName),
          bankReference: row.reference == null ? null : String(row.reference),
          documentNumber: r.documentNumber ? String(r.documentNumber) : null,
          directionOk,
        });
        return {
          openItemId: String(r.id),
          partyId: String(r.partyId),
          partyName: String(r.partyName),
          documentNumber: r.documentNumber ? String(r.documentNumber) : null,
          openOriginalMinor: Number(r.openOriginalMinor),
          currency: String(r.currency),
          score: fit.score,
          band: fit.band,
          breakdown: fit.breakdown,
          source: "score" as const,
        };
      })
      .filter((c) => c.band !== "none")
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);

    const opens = rows.rows
      .filter((r) => !rejectedIds.has(String(r.id)))
      .map((r) => Number(r.openOriginalMinor));
    const bundleIdx = subsetSumBundle(amount, opens, 0);
    let bundle: {
      openItemIds: string[];
      totalMinor: number;
      label: string;
    } | null = null;
    if (bundleIdx && bundleIdx.length >= 2) {
      const ids = bundleIdx.map((i) => String(rows.rows[i]!.id));
      const total = bundleIdx.reduce((s, i) => s + Number(rows.rows[i]!.openOriginalMinor), 0);
      bundle = {
        openItemIds: ids,
        totalMinor: total,
        label: `Bundle ${ids.length} items = ${total}`,
      };
    }

    // Persist top score on the txn when columns exist (best effort).
    if (scored[0]) {
      await db
        .query(
          `UPDATE books_bank_transactions SET
             match_score = $3, match_score_breakdown = $4::jsonb, match_band = $5, updated_at = now()
           WHERE id = $1 AND client_id = $2`,
          [
            txnId,
            clientId,
            scored[0].score,
            JSON.stringify(scored[0].breakdown),
            scored[0].band,
          ],
        )
        .catch(() => undefined);
    }

    return { candidates: scored, bundle };
  });
}

export async function rejectBooksBankTxnMatchSuggestion(
  userId: string,
  clientId: string,
  txnId: string,
  openItemId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const txn = await db.query(
      `SELECT id FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [txnId, clientId],
    );
    if (!txn.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const table = await db.query(`SELECT to_regclass('books_bank_txn_rejected_matches') AS t`);
    if (!table.rows[0]?.t) {
      throw new BooksError("p2a_match_suggestions_migration_required", "invalid");
    }
    await db.query(
      `INSERT INTO books_bank_txn_rejected_matches (client_id, bank_txn_id, open_item_id, rejected_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (bank_txn_id, open_item_id) DO NOTHING`,
      [clientId, txnId, openItemId, userId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "reject_bank_txn_match_suggestion",
      entity: "books_bank_transaction",
      entityId: txnId,
      after: { openItemId },
    });
    return { id: txnId, openItemId, rejected: true };
  });
}

/** Counterpart transfer candidates: other account, opposite direction, same amount/currency. */
export async function listBooksBankTxnTransferCandidates(
  userId: string,
  clientId: string,
  txnId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasLinkedTxnColumn(db))) {
      throw new BooksError("c3_bank_txn_transfer_migration_required", "invalid");
    }
    const txn = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [txnId, clientId],
    );
    if (!txn.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const row = txn.rows[0];
    if (String(row.txn_type || "") !== "transfer") return [];

    const amount = txnAmountMinor(row);
    if (amount <= 0) return [];
    const wantIn = isMoneyOut(row);
    const wantOut = isMoneyIn(row);
    if (!wantIn && !wantOut) return [];

    const rows = await db.query(
      `SELECT t.id, t.account_id AS "accountId", a.code AS "accountCode", a.name AS "accountName",
              t.txn_date AS "txnDate", t.description, t.currency,
              t.debit_minor AS "debitMinor", t.credit_minor AS "creditMinor",
              t.review_status AS "reviewStatus"
       FROM books_bank_transactions t
       JOIN books_accounts a ON a.id = t.account_id
       WHERE t.client_id = $1
         AND t.id <> $2
         AND t.account_id <> $3
         AND t.txn_type = 'transfer'
         AND t.linked_txn_id IS NULL
         AND t.review_status IN ('needs_review', 'ready')
         AND t.currency = $4
         AND GREATEST(t.debit_minor, t.credit_minor) = $5
         AND (
           ($6::boolean AND t.credit_minor = $5) OR
           ($7::boolean AND t.debit_minor = $5)
         )
       ORDER BY t.txn_date DESC NULLS LAST
       LIMIT 25`,
      [
        clientId,
        txnId,
        row.account_id,
        String(row.currency || "AED"),
        amount,
        wantIn,
        wantOut,
      ],
    );
    return rows.rows.map((r) => ({
      txnId: String(r.id),
      accountId: String(r.accountId),
      accountCode: r.accountCode ? String(r.accountCode) : null,
      accountName: r.accountName ? String(r.accountName) : null,
      txnDate: isoDate(r.txnDate),
      description: String(r.description || ""),
      currency: String(r.currency || "AED"),
      debitMinor: Number(r.debitMinor || 0),
      creditMinor: Number(r.creditMinor || 0),
      reviewStatus: String(r.reviewStatus),
    }));
  });
}

export async function linkBooksBankTransferPair(
  userId: string,
  clientId: string,
  txnId: string,
  counterpartTxnId: string,
) {
  if (txnId === counterpartTxnId) throw new BooksError("transfer_same_txn", "invalid");

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasLinkedTxnColumn(db))) {
      throw new BooksError("c3_bank_txn_transfer_migration_required", "invalid");
    }

    const a = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [txnId, clientId],
    );
    const b = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [counterpartTxnId, clientId],
    );
    if (!a.rowCount || !b.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const left = a.rows[0];
    const right = b.rows[0];

    for (const row of [left, right]) {
      if (String(row.txn_type || "") !== "transfer") {
        throw new BooksError("transfer_type_required", "invalid");
      }
      if (!["needs_review", "ready"].includes(String(row.review_status))) {
        throw new BooksError("bank_txn_not_editable", "conflict");
      }
      if (row.linked_txn_id) throw new BooksError("transfer_already_linked", "conflict");
    }
    if (String(left.account_id) === String(right.account_id)) {
      throw new BooksError("transfer_same_account", "invalid");
    }
    if (String(left.currency || "AED") !== String(right.currency || "AED")) {
      throw new BooksError("currency_mismatch", "invalid");
    }
    if (txnAmountMinor(left) !== txnAmountMinor(right) || txnAmountMinor(left) <= 0) {
      throw new BooksError("transfer_amount_mismatch", "invalid");
    }
    const opposite =
      (isMoneyOut(left) && isMoneyIn(right)) || (isMoneyIn(left) && isMoneyOut(right));
    if (!opposite) throw new BooksError("transfer_direction_mismatch", "invalid");

    await db.query(
      `UPDATE books_bank_transactions SET linked_txn_id = $2, updated_at = now()
       WHERE id = $1 AND client_id = $3`,
      [txnId, counterpartTxnId, clientId],
    );
    await db.query(
      `UPDATE books_bank_transactions SET linked_txn_id = $2, updated_at = now()
       WHERE id = $1 AND client_id = $3`,
      [counterpartTxnId, txnId, clientId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "link_bank_transfer_pair",
      entity: "books_bank_transaction",
      entityId: txnId,
      after: { linkedTxnId: counterpartTxnId },
    });
    return { id: txnId, linkedTxnId: counterpartTxnId };
  });
}

export async function unlinkBooksBankTransferPair(
  userId: string,
  clientId: string,
  txnId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasLinkedTxnColumn(db))) {
      throw new BooksError("c3_bank_txn_transfer_migration_required", "invalid");
    }
    const before = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [txnId, clientId],
    );
    if (!before.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const row = before.rows[0];
    if (String(row.review_status) === "posted") {
      throw new BooksError("bank_txn_posted", "conflict");
    }
    const otherId = row.linked_txn_id ? String(row.linked_txn_id) : null;
    await db.query(
      `UPDATE books_bank_transactions SET linked_txn_id = NULL, updated_at = now()
       WHERE client_id = $1 AND (id = $2 OR id = $3 OR linked_txn_id = $2 OR linked_txn_id = $3)`,
      [clientId, txnId, otherId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "unlink_bank_transfer_pair",
      entity: "books_bank_transaction",
      entityId: txnId,
      before: { linkedTxnId: otherId },
      after: { linkedTxnId: null },
    });
    return { id: txnId, linkedTxnId: null };
  });
}

export async function matchBooksBankTransaction(
  userId: string,
  clientId: string,
  txnId: string,
  openItemId: string | null,
) {
  // P2A-1: 1:1 match is a single against_item allocation for the full bank amount.
  const txn = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [txnId, clientId],
    );
    if (!before.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    return before.rows[0];
  });
  if (!(await withUser(userId, (db) => hasAllocTable(db)))) {
    // Pre-migration fallback (C3-2 behaviour).
    return withUser(userId, async (db) => {
      if (openItemId == null || openItemId === "") {
        await db.query(
          `UPDATE books_bank_transactions SET open_item_id = NULL, updated_at = now()
           WHERE id = $1 AND client_id = $2`,
          [txnId, clientId],
        );
        return { id: txnId, openItemId: null };
      }
      await db.query(
        `UPDATE books_bank_transactions SET open_item_id = $3, updated_at = now()
         WHERE id = $1 AND client_id = $2`,
        [txnId, clientId, openItemId],
      );
      return { id: txnId, openItemId };
    });
  }
  if (openItemId == null || openItemId === "") {
    await setBooksBankTxnAllocations(userId, clientId, txnId, []);
    return { id: txnId, openItemId: null };
  }
  const txnType = String(txn.txn_type || "");
  const amount =
    txnType === "customer_receipt"
      ? Number(txn.credit_minor || 0)
      : Number(txn.debit_minor || 0);
  await setBooksBankTxnAllocations(userId, clientId, txnId, [
    {
      allocKind: "against_item",
      openItemId,
      amountOriginalMinor: amount,
    },
  ]);
  return { id: txnId, openItemId };
}

/**
 * Dual-control post: approver ≠ reviewed_by.
 * Transfer pair → one Contra; matched receipt/payment → createReceiptOrPayment;
 * else bank vs category journal.
 */
export async function postBooksBankTransaction(
  approverId: string,
  clientId: string,
  txnId: string,
) {
  const loaded = await withUser(approverId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const col = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'books_bank_transactions' AND column_name = 'open_item_id'`,
    );
    if (!col.rowCount) throw new BooksError("c3_bank_txn_match_migration_required", "invalid");

    const txn = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [txnId, clientId],
    );
    if (!txn.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const row = txn.rows[0];
    if (String(row.review_status) !== "ready") {
      throw new BooksError("bank_txn_not_ready", "conflict");
    }
    if (!row.reviewed_by) throw new BooksError("bank_txn_not_reviewed", "conflict");
    await requireDualControlActor(db, approverId, String(row.reviewed_by), "post");

    let counterpart: typeof row | null = null;
    if (String(row.txn_type || "") === "transfer") {
      if (!(await hasLinkedTxnColumn(db))) {
        throw new BooksError("c3_bank_txn_transfer_migration_required", "invalid");
      }
      if (!row.linked_txn_id) throw new BooksError("transfer_link_required", "invalid");
      const other = await db.query(
        `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
        [row.linked_txn_id, clientId],
      );
      if (!other.rowCount) throw new BooksError("transfer_counterpart_missing", "not_found");
      counterpart = other.rows[0];
      if (String(counterpart.review_status) !== "ready") {
        throw new BooksError("transfer_counterpart_not_ready", "conflict");
      }
      if (!counterpart.reviewed_by) throw new BooksError("bank_txn_not_reviewed", "conflict");
      if (String(counterpart.reviewed_by) !== String(row.reviewed_by)) {
        await requireDualControlActor(db, approverId, String(counterpart.reviewed_by), "post");
      }
      if (String(counterpart.linked_txn_id) !== String(row.id)) {
        throw new BooksError("transfer_link_broken", "conflict");
      }
    }

    const txnDate = isoDate(row.txn_date);
    if (!txnDate) throw new BooksError("txn_date_required", "invalid");
    const period = await db.query(
      `SELECT id FROM books_periods
       WHERE client_id = $1 AND period_start <= $2::date AND period_end >= $2::date
         AND status IN ('OPEN','REOPENED')`,
      [clientId, txnDate],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "period_closed");

    return {
      row,
      counterpart,
      periodId: String(period.rows[0].id),
      txnDate,
      preparerId: String(row.reviewed_by),
    };
  });

  const { row, counterpart, periodId, txnDate, preparerId } = loaded;
  const txnType = String(row.txn_type || "");
  const debit = Number(row.debit_minor || 0);
  const credit = Number(row.credit_minor || 0);
  const currency = String(row.currency || "AED").toUpperCase();
  const bankAccountId = String(row.account_id);
  const memo = String(row.description || txnType || "Bank transaction");
  const fxRateScaled = await withUser(approverId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    return resolveBankFxRateScaled(db, clientId, currency, txnDate);
  });

  let journalEntryId: string;
  let entryNo: string;
  let settlementDocumentId: string | null = null;
  let pairedTxnId: string | null = null;

  if (txnType === "transfer" && counterpart) {
    const out = isMoneyOut(row) ? row : isMoneyOut(counterpart) ? counterpart : null;
    const inn = isMoneyIn(row) ? row : isMoneyIn(counterpart) ? counterpart : null;
    if (!out || !inn) throw new BooksError("transfer_direction_mismatch", "invalid");
    const amount = txnAmountMinor(out);
    if (amount !== txnAmountMinor(inn) || amount <= 0) {
      throw new BooksError("transfer_amount_mismatch", "invalid");
    }
    const outDate = isoDate(out.txn_date) || txnDate;
    const contra = await createContra(preparerId, approverId, clientId, {
      issueDate: outDate,
      periodId,
      fromAccountId: String(out.account_id),
      toAccountId: String(inn.account_id),
      currency,
      fxRateScaled,
      originalAmountMinor: amount,
      memo: memo || "Transfer",
    });
    journalEntryId = contra.journalEntryId;
    entryNo = String(contra.entryNo);
    settlementDocumentId = contra.documentId;
    pairedTxnId = String(counterpart.id);
  } else if (txnType === "customer_receipt" || txnType === "supplier_payment") {
    const amount = txnType === "customer_receipt" ? credit : debit;
    if (amount <= 0) throw new BooksError("match_amount_direction", "invalid");
    const draft = await listBooksBankTxnAllocations(approverId, clientId, txnId);
    const unallocated = bankTxnUnallocatedMinor(
      amount,
      draft,
      txnType === "customer_receipt" ? "receipt" : "payment",
    );
    if (draft.length > 0 && unallocated !== 0) {
      throw new BooksError("settlement_unallocated_nonzero", "invalid");
    }

    if (draft.length > 0) {
      const against = draft.filter((l) => l.allocKind === "against_item");
      const remLines = draft.filter(
        (l) => l.allocKind === "advance" || l.allocKind === "on_account",
      );
      const diffs = draft.filter((l) =>
        ["bank_fee", "fx_difference", "discount"].includes(l.allocKind),
      );
      const partyId =
        against[0]?.partyId ||
        remLines[0]?.partyId ||
        (
          await withUser(approverId, async (db) => {
            if (!row.open_item_id) return null;
            const r = await db.query(
              `SELECT party_id FROM books_open_items WHERE id = $1 AND client_id = $2`,
              [row.open_item_id, clientId],
            );
            return r.rowCount ? String(r.rows[0].party_id) : null;
          })
        );
      if (!partyId) throw new BooksError("party_required", "invalid");

      const remAdvance = remLines
        .filter((l) => l.allocKind === "advance")
        .reduce((s, l) => s + l.amountOriginalMinor, 0);
      const remOnAccount = remLines
        .filter((l) => l.allocKind === "on_account")
        .reduce((s, l) => s + l.amountOriginalMinor, 0);
      // Thin: one remainder kind per post (prefer advance if both — flag VAT TBD on advance).
      const remainderOriginalMinor = remAdvance + remOnAccount;
      const remainderKind =
        remAdvance > 0 ? "advance" : remOnAccount > 0 ? "on_account" : undefined;

      const settlement = await createReceiptOrPayment(preparerId, approverId, clientId, {
        docType: txnType === "customer_receipt" ? "receipt" : "payment",
        partyId,
        issueDate: txnDate,
        periodId,
        bankAccountId,
        currency,
        fxRateScaled,
        originalAmountMinor: amount,
        memo,
        allocations: against.map((l) => ({
          openItemId: String(l.openItemId),
          allocatedOriginalMinor: l.amountOriginalMinor,
        })),
        remainderKind,
        remainderOriginalMinor: remainderOriginalMinor || undefined,
        differenceLines: diffs.map((l) => ({
          kind: l.allocKind as "bank_fee" | "fx_difference" | "discount",
          accountId: String(l.accountId),
          amountOriginalMinor: l.amountOriginalMinor,
        })),
      });
      journalEntryId = settlement.journalEntryId;
      entryNo = String(settlement.entryNo);
      settlementDocumentId = settlement.documentId;
    } else if (row.open_item_id) {
      // Legacy single open_item_id (C3-2) when no draft allocation rows.
      const oi = await withUser(approverId, async (db) => {
        const r = await db.query(
          `SELECT id, party_id, open_original_minor FROM books_open_items
           WHERE id = $1 AND client_id = $2`,
          [row.open_item_id, clientId],
        );
        if (!r.rowCount) throw new BooksError("open_item_not_found", "not_found");
        return r.rows[0];
      });
      const settlement = await createReceiptOrPayment(preparerId, approverId, clientId, {
        docType: txnType === "customer_receipt" ? "receipt" : "payment",
        partyId: String(oi.party_id),
        issueDate: txnDate,
        periodId,
        bankAccountId,
        currency,
        fxRateScaled,
        originalAmountMinor: amount,
        memo,
        allocations: [
          {
            openItemId: String(oi.id),
            allocatedOriginalMinor: Math.min(amount, Number(oi.open_original_minor)),
          },
        ],
      });
      journalEntryId = settlement.journalEntryId;
      entryNo = String(settlement.entryNo);
      settlementDocumentId = settlement.documentId;
    } else {
      // Categorise-only receipt/payment without match → fall through to category JV.
      if (!row.category_account_id) throw new BooksError("category_account_required", "invalid");
      const categoryId = String(row.category_account_id);
      // Staging may set 1210/2110 for later match; posting without an open-item settlement is blocked.
      await assertCategoryNotControlWithoutOpenItem(approverId, clientId, categoryId);
      const amt = credit > 0 ? credit : debit;
      const lines =
        credit > 0
          ? [
              bankMoneyLine(bankAccountId, "debit", amt, currency, fxRateScaled),
              bankMoneyLine(categoryId, "credit", amt, currency, fxRateScaled),
            ]
          : [
              bankMoneyLine(categoryId, "debit", amt, currency, fxRateScaled),
              bankMoneyLine(bankAccountId, "credit", amt, currency, fxRateScaled),
            ];
      const created = await createBooksJournal(preparerId, clientId, {
        periodId,
        entryDate: txnDate,
        memo,
        voucherType: "Journal",
        lines,
        post: false,
      });
      const posted = await postBooksJournal(approverId, clientId, created.id);
      journalEntryId = created.id;
      entryNo = String(posted.entryNo);
    }
  } else if (txnType === "card_repayment") {
    // Dr Card Payable (2150) / Cr Bank — money out only.
    if (debit <= 0 || credit > 0) throw new BooksError("match_amount_direction", "invalid");
    const payableId =
      (row.category_account_id && String(row.category_account_id)) ||
      (await withUser(approverId, async (db) =>
        accountIdByCode(db, clientId, CARD_PAYABLE_CODE),
      ));
    if (!payableId) throw new BooksError("card_payable_account_missing", "invalid");
    const created = await createBooksJournal(preparerId, clientId, {
      periodId,
      entryDate: txnDate,
      memo: memo || "Card repayment",
      voucherType: "Journal",
      lines: [
        bankMoneyLine(payableId, "debit", debit, currency, fxRateScaled),
        bankMoneyLine(bankAccountId, "credit", debit, currency, fxRateScaled),
      ],
      post: false,
    });
    const posted = await postBooksJournal(approverId, clientId, created.id);
    journalEntryId = created.id;
    entryNo = String(posted.entryNo);
  } else if (txnType === "gateway_payout") {
    // Dr Bank / Cr Gateway Clearing (1310 default) — money in; never book as sales.
    if (credit <= 0 || debit > 0) throw new BooksError("match_amount_direction", "invalid");
    const clearingId =
      (row.category_account_id && String(row.category_account_id)) ||
      (await withUser(approverId, async (db) =>
        accountIdByCode(db, clientId, DEFAULT_GATEWAY_CLEARING_CODE),
      ));
    if (!clearingId) throw new BooksError("gateway_clearing_account_missing", "invalid");

    await withUser(approverId, async (db) => {
      if (!(await hasPayoutGroupColumn(db))) return;
      const groupKey = row.payout_group_key != null ? String(row.payout_group_key).trim() : "";
      if (!groupKey) return;
      const peers = await db.query(
        `SELECT t.id, t.txn_type, t.debit_minor, t.credit_minor, t.review_status,
                ca.code AS category_code
         FROM books_bank_transactions t
         LEFT JOIN books_accounts ca ON ca.id = t.category_account_id
         WHERE t.client_id = $1 AND t.payout_group_key = $2
           AND t.review_status <> 'excluded'`,
        [clientId, groupKey],
      );
      if ((peers.rowCount ?? 0) < 2) return; // singleton / incomplete — charges may be off-bank
      const pending = peers.rows.filter(
        (r) => String(r.review_status) === "needs_review" && String(r.id) !== txnId,
      );
      if (pending.length > 0) return; // wait until group is fully reviewed
      let net = 0;
      for (const r of peers.rows) {
        net += clearingImpactMinor(r);
      }
      if (net !== 0) throw new BooksError("gateway_payout_not_balanced", "conflict");
    });

    const created = await createBooksJournal(preparerId, clientId, {
      periodId,
      entryDate: txnDate,
      memo: memo || "Gateway payout",
      voucherType: "Journal",
      lines: [
        bankMoneyLine(bankAccountId, "debit", credit, currency, fxRateScaled),
        bankMoneyLine(clearingId, "credit", credit, currency, fxRateScaled),
      ],
      post: false,
    });
    const posted = await postBooksJournal(approverId, clientId, created.id);
    journalEntryId = created.id;
    entryNo = String(posted.entryNo);
  } else {
    if (!row.category_account_id) throw new BooksError("category_account_required", "invalid");
    if (debit <= 0 && credit <= 0) throw new BooksError("zero_amount", "invalid_money");
    const categoryId = String(row.category_account_id);
    await assertCategoryNotControlWithoutOpenItem(approverId, clientId, categoryId);
    const amt = credit > 0 ? credit : debit;
    // Money in (credit on statement) → Dr bank / Cr category; money out → Dr category / Cr bank.
    const lines =
      credit > 0
        ? [
            bankMoneyLine(bankAccountId, "debit", amt, currency, fxRateScaled),
            bankMoneyLine(categoryId, "credit", amt, currency, fxRateScaled),
          ]
        : [
            bankMoneyLine(categoryId, "debit", amt, currency, fxRateScaled),
            bankMoneyLine(bankAccountId, "credit", amt, currency, fxRateScaled),
          ];
    const created = await createBooksJournal(preparerId, clientId, {
      periodId,
      entryDate: txnDate,
      memo,
      voucherType: "Journal",
      lines,
      post: false,
    });
    const posted = await postBooksJournal(approverId, clientId, created.id);
    journalEntryId = created.id;
    entryNo = String(posted.entryNo);
  }

  await withUser(approverId, async (db) => {
    const ids = pairedTxnId ? [txnId, pairedTxnId] : [txnId];
    await db.query(
      `UPDATE books_bank_transactions SET
         review_status = 'posted',
         journal_entry_id = $3,
         settlement_document_id = $4,
         posted_by = $5,
         posted_at = now(),
         updated_at = now()
       WHERE client_id = $2 AND id = ANY($1::uuid[]) AND review_status = 'ready'`,
      [ids, clientId, journalEntryId, settlementDocumentId, approverId],
    );
    for (const id of ids) {
      await writeBooksAudit(db, {
        clientId,
        actor: approverId,
        action: "post_bank_transaction",
        entity: "books_bank_transaction",
        entityId: id,
        before: { review_status: "ready" },
        after: {
          review_status: "posted",
          journalEntryId,
          entryNo,
          settlementDocumentId,
          pairedTxnId,
        },
      });
    }
  });

  return { id: txnId, journalEntryId, entryNo, settlementDocumentId, pairedTxnId };
}

export type BankTxnPreviewLine = {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitMinor: number;
  creditMinor: number;
};

export type BankTxnPostPreview = {
  txnId: string;
  description: string;
  txnType: string | null;
  voucherType: "Receipt" | "Payment" | "Contra" | "Journal";
  amountMinor: number;
  lines: BankTxnPreviewLine[];
  balanced: boolean;
  error?: string;
};

async function acctMeta(
  db: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
  },
  clientId: string,
  accountId: string,
): Promise<{ id: string; code: string; name: string } | null> {
  const r = await db.query(
    `SELECT id, code, name FROM books_accounts WHERE id = $1 AND client_id = $2`,
    [accountId, clientId],
  );
  if (!r.rowCount) return null;
  return {
    id: String(r.rows[0].id),
    code: String(r.rows[0].code),
    name: String(r.rows[0].name),
  };
}

function previewLine(
  acct: { id: string; code: string; name: string },
  debitMinor: number,
  creditMinor: number,
): BankTxnPreviewLine {
  return {
    accountId: acct.id,
    accountCode: acct.code,
    accountName: acct.name,
    debitMinor,
    creditMinor,
  };
}

/** Dry-run journal lines for a Ready bank txn (no writes). */
export async function previewBooksBankTransactionPost(
  userId: string,
  clientId: string,
  txnId: string,
): Promise<BankTxnPostPreview> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const txn = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [txnId, clientId],
    );
    if (!txn.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const row = txn.rows[0];
    const description = String(row.description || "");
    const txnType = row.txn_type ? String(row.txn_type) : null;
    const debit = Number(row.debit_minor || 0);
    const credit = Number(row.credit_minor || 0);
    const amountMinor = Math.max(debit, credit);
    const bank = await acctMeta(db, clientId, String(row.account_id));
    if (!bank) {
      return {
        txnId,
        description,
        txnType,
        voucherType: "Journal",
        amountMinor,
        lines: [],
        balanced: false,
        error: "account_not_found",
      };
    }

    const fail = (error: string, voucherType: BankTxnPostPreview["voucherType"] = "Journal") => ({
      txnId,
      description,
      txnType,
      voucherType,
      amountMinor,
      lines: [] as BankTxnPreviewLine[],
      balanced: false,
      error,
    });

    if (String(row.review_status) !== "ready") return fail("bank_txn_not_ready");

    const finish = (voucherType: BankTxnPostPreview["voucherType"], lines: BankTxnPreviewLine[]) => {
      const dr = lines.reduce((s, l) => s + l.debitMinor, 0);
      const cr = lines.reduce((s, l) => s + l.creditMinor, 0);
      return {
        txnId,
        description,
        txnType,
        voucherType,
        amountMinor,
        lines,
        balanced: dr === cr && dr > 0,
      };
    };

    if (txnType === "transfer") {
      if (!row.linked_txn_id) return fail("transfer_link_required", "Contra");
      const other = await db.query(
        `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
        [row.linked_txn_id, clientId],
      );
      if (!other.rowCount) return fail("transfer_counterpart_missing", "Contra");
      const counterpart = other.rows[0];
      const out = isMoneyOut(row) ? row : isMoneyOut(counterpart) ? counterpart : null;
      const inn = isMoneyIn(row) ? row : isMoneyIn(counterpart) ? counterpart : null;
      if (!out || !inn) return fail("transfer_direction_mismatch", "Contra");
      const amt = txnAmountMinor(out);
      if (amt !== txnAmountMinor(inn) || amt <= 0) return fail("transfer_amount_mismatch", "Contra");
      const from = await acctMeta(db, clientId, String(out.account_id));
      const to = await acctMeta(db, clientId, String(inn.account_id));
      if (!from || !to) return fail("account_not_found", "Contra");
      return finish("Contra", [
        previewLine(to, amt, 0),
        previewLine(from, 0, amt),
      ]);
    }

    if (txnType === "card_repayment") {
      if (debit <= 0) return fail("match_amount_direction");
      const payableId =
        (row.category_account_id && String(row.category_account_id)) ||
        (await accountIdByCode(db, clientId, CARD_PAYABLE_CODE));
      const payable = payableId ? await acctMeta(db, clientId, payableId) : null;
      if (!payable) return fail("card_payable_account_missing");
      return finish("Journal", [previewLine(payable, debit, 0), previewLine(bank, 0, debit)]);
    }

    if (txnType === "gateway_payout") {
      if (credit <= 0) return fail("match_amount_direction");
      const clearingId =
        (row.category_account_id && String(row.category_account_id)) ||
        (await accountIdByCode(db, clientId, DEFAULT_GATEWAY_CLEARING_CODE));
      const clearing = clearingId ? await acctMeta(db, clientId, clearingId) : null;
      if (!clearing) return fail("gateway_clearing_account_missing");
      return finish("Journal", [previewLine(bank, credit, 0), previewLine(clearing, 0, credit)]);
    }

    if (txnType === "customer_receipt" || txnType === "supplier_payment") {
      const voucherType = txnType === "customer_receipt" ? "Receipt" : "Payment";
      const bankAmt = txnType === "customer_receipt" ? credit : debit;
      if (bankAmt <= 0) return fail("match_amount_direction", voucherType);

      const controlCode = txnType === "customer_receipt" ? "1210" : "2110";
      let controlId: string | null = null;
      if (row.open_item_id) {
        const oi = await db.query(
          `SELECT oi.party_id, p.default_account_id
           FROM books_open_items oi
           LEFT JOIN books_parties p ON p.id = oi.party_id
           WHERE oi.id = $1 AND oi.client_id = $2`,
          [row.open_item_id, clientId],
        );
        if (oi.rowCount && oi.rows[0].default_account_id) {
          controlId = String(oi.rows[0].default_account_id);
        }
      }
      if (!controlId && row.category_account_id) controlId = String(row.category_account_id);
      if (!controlId) controlId = await accountIdByCode(db, clientId, controlCode);
      const control = controlId ? await acctMeta(db, clientId, controlId) : null;
      if (!control) return fail("account_not_found", voucherType);

      const lines: BankTxnPreviewLine[] =
        txnType === "customer_receipt"
          ? [previewLine(bank, bankAmt, 0), previewLine(control, 0, bankAmt)]
          : [previewLine(control, bankAmt, 0), previewLine(bank, 0, bankAmt)];

      if (await hasAllocTable(db)) {
        const allocs = await db.query(
          `SELECT alloc_kind, amount_original_minor, account_id
           FROM books_bank_txn_allocations WHERE client_id = $1 AND bank_txn_id = $2`,
          [clientId, txnId],
        );
        for (const a of allocs.rows) {
          const kind = String(a.alloc_kind);
          const amt = Number(a.amount_original_minor || 0);
          if (!["bank_fee", "fx_difference", "discount"].includes(kind) || !a.account_id) continue;
          const diffAcct = await acctMeta(db, clientId, String(a.account_id));
          if (!diffAcct) continue;
          if (kind === "discount") {
            if (txnType === "customer_receipt") lines.push(previewLine(diffAcct, amt, 0));
            else lines.push(previewLine(diffAcct, 0, amt));
          } else if (txnType === "customer_receipt") {
            lines.push(previewLine(diffAcct, amt, 0));
          } else {
            lines.push(previewLine(diffAcct, amt, 0));
          }
        }
      }
      return finish(voucherType, lines);
    }

    if (!row.category_account_id) return fail("category_account_required");
    const cat = await acctMeta(db, clientId, String(row.category_account_id));
    if (!cat) return fail("account_not_found");
    const lines =
      credit > 0
        ? [previewLine(bank, credit, 0), previewLine(cat, 0, credit)]
        : [previewLine(cat, debit, 0), previewLine(bank, 0, debit)];
    return finish("Journal", lines);
  });
}

export async function previewBooksBankTransactionsBulk(
  userId: string,
  clientId: string,
  txnIds: string[],
) {
  const ids = [...new Set(txnIds.map(String).filter(Boolean))];
  if (ids.length === 0) throw new BooksError("txn_ids_required", "invalid");
  if (ids.length > 50) throw new BooksError("bulk_limit_exceeded", "invalid");
  const previews: BankTxnPostPreview[] = [];
  for (const id of ids) {
    previews.push(await previewBooksBankTransactionPost(userId, clientId, id));
  }
  return {
    previews,
    allBalanced: previews.every((p) => p.balanced && !p.error),
    count: previews.length,
  };
}

export async function bulkMarkBooksBankTransactionsReviewed(
  userId: string,
  clientId: string,
  txnIds: string[],
) {
  const ids = [...new Set(txnIds.map(String).filter(Boolean))];
  if (ids.length === 0) throw new BooksError("txn_ids_required", "invalid");
  if (ids.length > 50) throw new BooksError("bulk_limit_exceeded", "invalid");
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of ids) {
    try {
      await markBooksBankTransactionReviewed(userId, clientId, id);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({
        id,
        ok: false,
        error: e instanceof BooksError ? e.message : "mark_reviewed_failed",
      });
    }
  }
  return {
    results,
    marked: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

/** Approver posts selected Ready rows after preview. Dual control enforced per row. */
export async function bulkPostBooksBankTransactions(
  approverId: string,
  clientId: string,
  txnIds: string[],
) {
  const ids = [...new Set(txnIds.map(String).filter(Boolean))];
  if (ids.length === 0) throw new BooksError("txn_ids_required", "invalid");
  if (ids.length > 50) throw new BooksError("bulk_limit_exceeded", "invalid");

  // Skip transfer counterparts already posted by pairing.
  const postedPair = new Set<string>();
  const results: Array<{
    id: string;
    ok: boolean;
    entryNo?: string;
    journalEntryId?: string;
    error?: string;
  }> = [];

  for (const id of ids) {
    if (postedPair.has(id)) {
      results.push({ id, ok: true, entryNo: "(paired)" });
      continue;
    }
    try {
      const posted = await postBooksBankTransaction(approverId, clientId, id);
      if (posted.pairedTxnId) postedPair.add(posted.pairedTxnId);
      results.push({
        id,
        ok: true,
        entryNo: posted.entryNo,
        journalEntryId: posted.journalEntryId,
      });
    } catch (e) {
      results.push({
        id,
        ok: false,
        error: e instanceof BooksError ? e.message : "post_failed",
      });
    }
  }
  return {
    results,
    posted: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

/** Exported for unit tests of eligibility without DB. */
export function __testStatementEligible(status: string, flags: string[]): boolean {
  return statementEligible(status, flags);
}
