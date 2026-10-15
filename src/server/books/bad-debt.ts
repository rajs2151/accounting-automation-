/**
 * Phase 3 rank 7: bad-debt write-off v1.
 * Dr 4900 / Cr 1210; reduce the linked AR open item.
 * Dual-control: prepare (draft) then a different approver posts.
 */
import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import {
  createBooksJournal,
  postBooksJournalInTx,
  softDeleteBooksJournalDraft,
} from "@/server/books/journals";
import { applyAllocationToOpenItem } from "@/server/books/open-items";
import { assertSyntheticTenant } from "@/server/security-gate";

const BAD_DEBT_EXPENSE_CODE = "4900";
const AR_CONTROL_CODE = "1210";
const OPEN_ITEM_TAG_PREFIX = "open_item:";

async function accountId(db: PoolClient, clientId: string, code: string): Promise<string> {
  const row = await db.query(
    `SELECT id FROM books_accounts WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  if (!row.rowCount) throw new BooksError(`account_missing:${code}`, "not_found");
  return String(row.rows[0].id);
}

function openItemTag(openItemId: string) {
  return `${OPEN_ITEM_TAG_PREFIX}${openItemId}`;
}

function parseOpenItemTag(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    const s = String(t);
    if (s.startsWith(OPEN_ITEM_TAG_PREFIX)) return s.slice(OPEN_ITEM_TAG_PREFIX.length);
  }
  return null;
}

export type BadDebtWriteOffInput = {
  openItemId: string;
  periodId: string;
  entryDate: string;
  /** Defaults to full open original. */
  amountOriginalMinor?: number;
  memo?: string;
};

/** Step 1: preparer creates a draft write-off journal (does not touch the open item yet). */
export async function prepareBadDebtWriteOff(
  preparerId: string,
  clientId: string,
  body: BadDebtWriteOffInput,
): Promise<{ journalEntryId: string; amountOriginalMinor: number; amountAedMinor: number }> {
  const p = await withUser(preparerId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const oi = await db.query(
      `SELECT oi.id, oi.side, oi.currency, oi.status,
              oi.open_original_minor, oi.open_aed_minor,
              p.name AS party_name
       FROM books_open_items oi
       JOIN books_parties p ON p.id = oi.party_id
       WHERE oi.id = $1 AND oi.client_id = $2`,
      [body.openItemId, clientId],
    );
    if (!oi.rowCount) throw new BooksError("open_item_not_found", "not_found");
    const row = oi.rows[0];
    if (String(row.side) !== "AR") throw new BooksError("bad_debt_ar_only", "invalid");
    if (!["open", "partial"].includes(String(row.status))) {
      throw new BooksError("open_item_not_open", "conflict");
    }
    const openOrig = Number(row.open_original_minor);
    const openAed = Number(row.open_aed_minor);
    if (openOrig <= 0) throw new BooksError("open_item_zero", "invalid");

    const amountOrig =
      body.amountOriginalMinor == null ? openOrig : Math.trunc(Number(body.amountOriginalMinor));
    if (!Number.isFinite(amountOrig) || amountOrig <= 0) {
      throw new BooksError("settlement_amount_required", "invalid");
    }
    if (amountOrig > openOrig) throw new BooksError("allocation_exceeds_open", "invalid");

    const amountAed =
      amountOrig === openOrig ? openAed : Math.floor((openAed * amountOrig) / openOrig);

    const expenseId = await accountId(db, clientId, BAD_DEBT_EXPENSE_CODE);
    const arId = await accountId(db, clientId, AR_CONTROL_CODE);
    const partyName = String(row.party_name || "customer");
    const memo = (body.memo || "").trim() || `Bad debt write-off — ${partyName}`;

    return {
      amountOrig,
      amountAed,
      expenseId,
      arId,
      memo,
      openItemId: body.openItemId,
      periodId: body.periodId,
      entryDate: body.entryDate,
    };
  });

  const created = await createBooksJournal(preparerId, clientId, {
    periodId: p.periodId,
    entryDate: p.entryDate,
    memo: p.memo,
    voucherType: "Journal",
    templateKey: "bad_debt",
    tags: ["bad_debt", openItemTag(p.openItemId)],
    allowControlAccounts: true,
    post: false,
    lines: [
      {
        accountId: p.expenseId,
        debitMinor: p.amountAed,
        creditMinor: 0,
        lineMemo: "Bad debt / write-off",
      },
      {
        accountId: p.arId,
        debitMinor: 0,
        creditMinor: p.amountAed,
        lineMemo: "Clear trade receivable",
      },
    ],
  });
  return {
    journalEntryId: created.id,
    amountOriginalMinor: p.amountOrig,
    amountAedMinor: p.amountAed,
  };
}

/** Step 2: approver posts the draft and closes/reduces the linked open item in one transaction. */
export async function postBadDebtWriteOff(
  approverId: string,
  clientId: string,
  journalEntryId: string,
): Promise<{ journalEntryId: string; entryNo: string; openItemId: string }> {
  return withUser(approverId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const entry = await db.query(
      `SELECT id, status, tags,
              (SELECT COALESCE(SUM(debit_minor),0)::bigint FROM books_journal_lines WHERE entry_id = e.id) AS debit_sum
       FROM books_journal_entries e
       WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [journalEntryId, clientId],
    );
    if (!entry.rowCount) throw new BooksError("journal_not_found", "not_found");
    if (!["draft", "scheduled"].includes(String(entry.rows[0].status))) {
      throw new BooksError("not_draft", "conflict");
    }
    const openItemId = parseOpenItemTag(entry.rows[0].tags);
    if (!openItemId) throw new BooksError("bad_debt_open_item_missing", "invalid");
    const amountAed = Number(entry.rows[0].debit_sum);
    if (amountAed <= 0) throw new BooksError("settlement_amount_required", "invalid");

    const oi = await db.query(
      `SELECT open_original_minor, open_aed_minor, side, status
       FROM books_open_items WHERE id = $1 AND client_id = $2 FOR UPDATE`,
      [openItemId, clientId],
    );
    if (!oi.rowCount) throw new BooksError("open_item_not_found", "not_found");
    if (String(oi.rows[0].side) !== "AR") throw new BooksError("bad_debt_ar_only", "invalid");
    const openOrig = Number(oi.rows[0].open_original_minor);
    const openAed = Number(oi.rows[0].open_aed_minor);
    if (openAed <= 0 || openOrig <= 0) throw new BooksError("open_item_zero", "invalid");
    if (amountAed > openAed) throw new BooksError("allocation_exceeds_open", "invalid");

    const amountOrig =
      amountAed === openAed ? openOrig : Math.floor((openOrig * amountAed) / openAed);

    const posted = await postBooksJournalInTx(db, approverId, clientId, journalEntryId);
    await applyAllocationToOpenItem(db, openItemId, clientId, amountOrig, amountAed);
    await writeBooksAudit(db, {
      clientId,
      actor: approverId,
      action: "bad_debt_write_off",
      entity: "books_open_item",
      entityId: openItemId,
      after: {
        journalEntryId,
        entryNo: posted.entryNo,
        amountOriginalMinor: amountOrig,
        amountAedMinor: amountAed,
      },
    });
    return {
      journalEntryId,
      entryNo: String(posted.entryNo),
      openItemId,
    };
  });
}

/** Test helper: prepare as preparer, post as approver. Discards draft if post fails. */
export async function createBadDebtWriteOff(
  preparerId: string,
  approverId: string,
  clientId: string,
  body: BadDebtWriteOffInput,
) {
  const draft = await prepareBadDebtWriteOff(preparerId, clientId, body);
  try {
    const posted = await postBadDebtWriteOff(approverId, clientId, draft.journalEntryId);
    return {
      ...posted,
      amountOriginalMinor: draft.amountOriginalMinor,
      amountAedMinor: draft.amountAedMinor,
    };
  } catch (error) {
    try {
      await softDeleteBooksJournalDraft(preparerId, clientId, draft.journalEntryId);
    } catch (cleanupError) {
      console.error(`[bad-debt] could not discard draft ${draft.journalEntryId}`, cleanupError);
    }
    throw error;
  }
}
