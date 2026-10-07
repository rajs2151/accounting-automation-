/**
 * P6-2: draft reclass journal from a report drill-down.
 * Never edits the source entry — Dr new / Cr old for the stated amount (fils).
 */
import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal, getBooksJournal } from "@/server/books/journals";
import { assertSyntheticTenant } from "@/server/security-gate";

export type ReclassDraftInput = {
  periodId: string;
  entryDate: string;
  fromAccountId: string;
  toAccountId: string;
  /** Positive fils to move off the old account onto the new one. */
  amountMinor: number;
  sourceEntryId: string;
};

export async function createBooksReclassDraft(
  userId: string,
  clientId: string,
  input: ReclassDraftInput,
) {
  const amount = Math.trunc(Number(input.amountMinor));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BooksError("reclass_amount_invalid", "invalid");
  }
  if (!input.fromAccountId || !input.toAccountId) {
    throw new BooksError("reclass_accounts_required", "invalid");
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new BooksError("reclass_same_account", "invalid");
  }
  if (!input.sourceEntryId || !input.periodId || !input.entryDate) {
    throw new BooksError("reclass_fields_required", "invalid");
  }

  // Resolve source entry (RLS) for memo link — must exist for this tenant.
  const source = await getBooksJournal(userId, clientId, input.sourceEntryId);

  const codes = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, code FROM books_accounts
       WHERE client_id = $1 AND id = ANY($2::uuid[]) AND active = true AND is_postable = true`,
      [clientId, [input.fromAccountId, input.toAccountId]],
    );
    const byId = new Map(rows.rows.map((r) => [String(r.id), String(r.code)]));
    if (!byId.has(input.fromAccountId) || !byId.has(input.toAccountId)) {
      throw new BooksError("reclass_account_not_found", "not_found");
    }
    return {
      fromCode: byId.get(input.fromAccountId)!,
      toCode: byId.get(input.toAccountId)!,
    };
  });

  const entryLabel = source.entryNo || source.id.slice(0, 8);
  const memo = `Reclass from ${entryLabel}: ${codes.fromCode} → ${codes.toCode}`;

  // Locked periods / dual-control posting are enforced inside createBooksJournal / postBooksJournal.
  return createBooksJournal(userId, clientId, {
    periodId: input.periodId,
    entryDate: input.entryDate,
    memo,
    voucherType: "Journal",
    templateKey: "reclassification",
    post: false,
    lines: [
      {
        accountId: input.toAccountId,
        debitMinor: amount,
        creditMinor: 0,
        lineMemo: `Reclass from ${entryLabel}`,
      },
      {
        accountId: input.fromAccountId,
        debitMinor: 0,
        creditMinor: amount,
        lineMemo: `Reclass to ${codes.toCode}`,
      },
    ],
  });
}
