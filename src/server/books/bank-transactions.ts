import { BANK_TXN_TYPES, type BooksBankTxnType } from "@/lib/bank-txn-types";
import { withUser } from "@/lib/db";
import { normalizeIban } from "@/lib/statement-coverage";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export type { BooksBankTxnType };
export { BANK_TXN_TYPES };
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

function statementEligible(status: string, flags: string[]): boolean {
  if (status === "ready" || status === "confirmed") return true;
  if (status !== "needs_review") return false;
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
};

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

export async function listBooksBankTransactions(
  userId: string,
  clientId: string,
  opts?: { accountId?: string; status?: string; q?: string; materialize?: boolean },
) {
  if (opts?.materialize !== false) {
    await materializeBooksBankTransactions(userId, clientId, {
      accountId: opts?.accountId,
    });
  }

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const status = opts?.status && opts.status !== "all" ? opts.status : null;
    const q = opts?.q?.trim() || null;
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
              t.note, t.exclude_reason AS "excludeReason"
       FROM books_bank_transactions t
       JOIN books_accounts a ON a.id = t.account_id
       LEFT JOIN books_accounts ca ON ca.id = t.category_account_id
       WHERE t.client_id = $1
         AND ($2::uuid IS NULL OR t.account_id = $2)
         AND ($3::text IS NULL OR t.review_status = $3)
         AND (
           $4::text IS NULL
           OR t.description ILIKE '%' || $4 || '%'
           OR COALESCE(t.reference,'') ILIKE '%' || $4 || '%'
         )
       ORDER BY t.txn_date DESC NULLS LAST, t.created_at DESC`,
      [clientId, opts?.accountId || null, status, q],
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
        categoryAccountId = acc.rows[0].id;
      }
    }

    const note = body.note !== undefined ? String(body.note) : String(row.note || "");

    // Editing a Ready row after category change drops back to Needs Review.
    let reviewStatus = String(row.review_status);
    if (reviewStatus === "ready" && (body.txnType !== undefined || body.categoryAccountId !== undefined)) {
      reviewStatus = "needs_review";
    }

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
      },
      after: {
        txn_type: txnType,
        category_account_id: categoryAccountId,
        note,
        review_status: reviewStatus,
      },
    });

    return { id, txnType, categoryAccountId, note, reviewStatus };
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
    if (!row.category_account_id) throw new BooksError("category_account_required", "invalid");

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

    await db.query(
      `UPDATE books_bank_transactions SET
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

/** Exported for unit tests of eligibility without DB. */
export function __testStatementEligible(status: string, flags: string[]): boolean {
  return statementEligible(status, flags);
}
