/**
 * P6-2: draft reclass journal from a report drill-down.
 * Never edits the source entry — books a new draft that moves part (or all) of the source entry's
 * line on `fromAccountId` onto `toAccountId`, on the same side the source booked it:
 *   debit-side source line  → Dr to / Cr from
 *   credit-side source line → Dr from / Cr to
 *
 * Checks (P6-2 hardening):
 *  - the source entry belongs to this client, is posted (not reversed / deleted) and has a line on
 *    fromAccountId;
 *  - the amount is whole fils and at most that line's net minus what earlier reclasses of the same
 *    source + from-account already moved (non-deleted drafts / scheduled / posted);
 *  - both accounts sit on the same statement (P&L ↔ P&L, balance sheet ↔ balance sheet), and neither is
 *    a control account (AR / AP / VAT control / bank) — those balances belong to their subledgers;
 *  - the draft is dated in the period that contains entryDate (the client's sent periodId is only a
 *    fallback); a locked period is refused with period_locked.
 *
 * Link: the draft carries corrects_entry_id = source entry and template_key = 'reclassification'.
 * Drafts made before this link existed are matched by their memo ("Reclass from <entry>: …").
 */
import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal } from "@/server/books/journals";
import { assertUuid, isIsoDate } from "@/server/books/periods";
import { assertSyntheticTenant } from "@/server/security-gate";

export type ReclassDraftInput = {
  /** Fallback only: the server uses the period that contains entryDate. */
  periodId?: string;
  entryDate: string;
  fromAccountId: string;
  toAccountId: string;
  /** Positive whole fils to move off the old account onto the new one. */
  amountMinor: number;
  sourceEntryId: string;
};

const PNL_TYPES = new Set(["income", "expense"]);

type AcctRow = {
  id: string;
  code: string;
  accountType: string;
  isControl: boolean;
};

export async function createBooksReclassDraft(
  userId: string,
  clientId: string,
  input: ReclassDraftInput,
) {
  const amount = Number(input.amountMinor);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new BooksError("reclass_amount_invalid", "invalid");
  }
  if (!input.fromAccountId || !input.toAccountId) {
    throw new BooksError("reclass_accounts_required", "invalid");
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new BooksError("reclass_same_account", "invalid");
  }
  if (!input.sourceEntryId || !input.entryDate) {
    throw new BooksError("reclass_fields_required", "invalid");
  }
  assertUuid(input.fromAccountId, "invalid_account_id");
  assertUuid(input.toAccountId, "invalid_account_id");
  assertUuid(input.sourceEntryId, "reclass_source_not_found");
  if (!isIsoDate(input.entryDate)) throw new BooksError("invalid_date", "invalid");
  if (input.periodId) assertUuid(input.periodId, "invalid_period_id");

  const plan = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);

    // Accounts: postable, active, same statement, not a subledger control.
    const acctRows = await db.query(
      `SELECT id, code, account_type,
              (is_ar OR is_ap OR is_vat_control
                OR (is_bank AND account_type IN ('asset', 'liability'))) AS is_control
       FROM books_accounts
       WHERE client_id = $1 AND id = ANY($2::uuid[]) AND active = true AND is_postable = true`,
      [clientId, [input.fromAccountId, input.toAccountId]],
    );
    const byId = new Map<string, AcctRow>(
      acctRows.rows.map((r) => [
        String(r.id),
        {
          id: String(r.id),
          code: String(r.code),
          accountType: String(r.account_type),
          isControl: Boolean(r.is_control),
        },
      ]),
    );
    const from = byId.get(input.fromAccountId);
    const to = byId.get(input.toAccountId);
    if (!from || !to) throw new BooksError("reclass_account_not_found", "not_found");
    if (PNL_TYPES.has(from.accountType) !== PNL_TYPES.has(to.accountType)) {
      throw new BooksError("reclass_cross_statement", "invalid");
    }
    if (from.isControl || to.isControl) {
      throw new BooksError("reclass_control_account", "invalid");
    }

    // Period: the one containing entryDate for this client; sent periodId only as a fallback.
    const p = await db.query(
      `SELECT id, status FROM books_periods
       WHERE client_id = $1 AND period_start <= $2::date AND period_end >= $2::date
       ORDER BY period_start DESC LIMIT 1`,
      [clientId, input.entryDate],
    );
    let periodId = input.periodId || "";
    if (p.rowCount) {
      if (String(p.rows[0].status) === "LOCKED") {
        throw new BooksError("period_locked", "period_closed");
      }
      periodId = String(p.rows[0].id);
    }
    if (!periodId) throw new BooksError("period_not_found", "not_found");

    // Source entry: this client's, posted, not deleted, with a line on the from-account.
    const src = await db.query(
      `SELECT id, entry_no, status, deleted_at FROM books_journal_entries
       WHERE id = $1 AND client_id = $2`,
      [input.sourceEntryId, clientId],
    );
    if (!src.rowCount) throw new BooksError("reclass_source_not_found", "not_found");
    const source = src.rows[0];
    if (source.deleted_at || String(source.status) !== "posted") {
      throw new BooksError("reclass_source_not_posted", "conflict");
    }
    const line = await db.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(debit_minor - credit_minor), 0)::bigint AS net
       FROM books_journal_lines WHERE entry_id = $1 AND account_id = $2`,
      [input.sourceEntryId, input.fromAccountId],
    );
    const sourceNet = Number(line.rows[0].net);
    if (!Number(line.rows[0].n)) throw new BooksError("reclass_source_no_line", "invalid");
    if (sourceNet === 0) throw new BooksError("reclass_source_line_zero", "invalid");
    const sourceSide = Math.sign(sourceNet); // +1 debit-side, −1 credit-side

    // Earlier reclasses of this source + from-account (linked, or legacy memo link).
    const entryLabel = source.entry_no ? String(source.entry_no) : String(source.id).slice(0, 8);
    const legacyPrefix = `Reclass from ${entryLabel}:`;
    const prior = await db.query(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::bigint AS net
       FROM books_journal_entries e
       JOIN books_journal_lines l ON l.entry_id = e.id AND l.account_id = $3
       WHERE e.client_id = $1
         AND e.template_key = 'reclassification'
         AND e.deleted_at IS NULL
         AND e.status IN ('draft', 'scheduled', 'posted')
         AND (e.corrects_entry_id = $2
              OR (e.corrects_entry_id IS NULL AND left(e.memo, length($4)) = $4))`,
      [clientId, input.sourceEntryId, input.fromAccountId, legacyPrefix],
    );
    // A reclass moves the from-account against the source side; count only that direction.
    const alreadyMoved = Math.max(0, -sourceSide * Number(prior.rows[0].net));
    const available = Math.abs(sourceNet) - alreadyMoved;
    if (amount > available) {
      throw new BooksError(`reclass_amount_exceeds_source:${Math.max(0, available)}`, "invalid");
    }

    return { from, to, sourceSide, entryLabel, periodId, sourceId: String(source.id) };
  });

  const memo = `Reclass from ${plan.entryLabel}: ${plan.from.code} → ${plan.to.code}`;
  const fromLine = {
    accountId: input.fromAccountId,
    lineMemo: `Reclass to ${plan.to.code}`,
  };
  const toLine = {
    accountId: input.toAccountId,
    lineMemo: `Reclass from ${plan.entryLabel}`,
  };
  // Same side as the source: a debit-side line moves Dr to / Cr from; a credit-side line the reverse.
  const lines =
    plan.sourceSide > 0
      ? [
          { ...toLine, debitMinor: amount, creditMinor: 0 },
          { ...fromLine, debitMinor: 0, creditMinor: amount },
        ]
      : [
          { ...fromLine, debitMinor: amount, creditMinor: 0 },
          { ...toLine, debitMinor: 0, creditMinor: amount },
        ];

  // Locked periods / dual-control posting are enforced inside createBooksJournal / postBooksJournal.
  return createBooksJournal(userId, clientId, {
    periodId: plan.periodId,
    entryDate: input.entryDate,
    memo,
    voucherType: "Journal",
    templateKey: "reclassification",
    correctsEntryId: plan.sourceId,
    post: false,
    lines,
  });
}
