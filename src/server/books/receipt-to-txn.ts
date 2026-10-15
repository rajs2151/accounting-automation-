/**
 * B6: Add transaction via receipt — from extraction fields, either match an unmatched
 * bank/card line (same amount + date window) or create an expense draft.
 */
import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { createBooksExpense } from "@/server/books/expenses";
import { listBooksBankTransactions, updateBooksBankTransaction } from "@/server/books/bank-transactions";
import { assertSyntheticTenant } from "@/server/security-gate";

export type ReceiptToTxnInput = {
  expenseDate: string;
  periodId: string;
  description: string;
  vendorName?: string;
  vendorPartyId?: string | null;
  amountMinor: number;
  /** Prefer matching bank txn within ± days of expenseDate. */
  dateWindowDays?: number;
  /** Expense line account (opex); required when creating a draft. */
  expenseAccountId: string;
  vatCode?: string | null;
  vatMinor?: number;
  paidFromAccountId?: string | null;
  /** If set, force-link this bank txn instead of searching. */
  bankTxnId?: string | null;
  /** Prefer create expense even when a bank candidate exists. */
  forceExpenseDraft?: boolean;
};

export type ReceiptToTxnResult =
  | {
      kind: "matched_bank";
      bankTxnId: string;
      expenseId: string;
      description: string;
    }
  | {
      kind: "expense_draft";
      expenseId: string;
      candidates: Array<{ id: string; description: string; amountMinor: number; txnDate: string }>;
    };

function iso(d: string) {
  return String(d || "").slice(0, 10);
}

function daysBetween(a: string, b: string) {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.floor(ms / 86_400_000);
}

export async function addTransactionFromReceipt(
  userId: string,
  clientId: string,
  body: ReceiptToTxnInput,
): Promise<ReceiptToTxnResult> {
  if (!body.periodId) throw new BooksError("period_required", "invalid");
  if (!body.expenseAccountId) throw new BooksError("account_required", "invalid");
  const expenseDate = iso(body.expenseDate);
  if (!expenseDate) throw new BooksError("expense_date_required", "invalid");
  const amount = Math.trunc(Number(body.amountMinor) || 0);
  if (amount <= 0) throw new BooksError("amount_required", "invalid_money");
  const windowDays = Math.max(0, Math.trunc(body.dateWindowDays ?? 5));
  const net = Math.max(0, amount - Math.trunc(body.vatMinor ?? 0));
  const vat = Math.trunc(body.vatMinor ?? 0);

  const expense = await createBooksExpense(userId, clientId, {
    expenseDate,
    periodId: body.periodId,
    description: String(body.description || "Receipt").trim() || "Receipt",
    vendorName: body.vendorName,
    vendorPartyId: body.vendorPartyId ?? null,
    paidFromAccountId: body.paidFromAccountId ?? null,
    paidFromKind: body.paidFromAccountId ? "bank" : null,
    lines: [
      {
        description: String(body.description || "Receipt").trim() || "Receipt",
        accountId: body.expenseAccountId,
        vatCode: body.vatCode ?? null,
        netMinor: net,
        vatMinor: vat,
      },
    ],
  });

  // Find unmatched bank/card money-out lines with same absolute amount near the date.
  const txns = await listBooksBankTransactions(userId, clientId, {
    materialize: false,
    status: "needs_review",
  });
  const candidates = txns
    .filter((t) => {
      const abs = Math.max(Math.trunc(t.debitMinor || 0), Math.trunc(t.creditMinor || 0));
      if (abs !== amount) return false;
      if (!t.txnDate) return false;
      return daysBetween(iso(t.txnDate), expenseDate) <= windowDays;
    })
    .map((t) => ({
      id: t.id,
      description: t.description || "",
      amountMinor: Math.max(Math.trunc(t.debitMinor || 0), Math.trunc(t.creditMinor || 0)),
      txnDate: iso(t.txnDate || ""),
    }));

  const forced = body.bankTxnId ? candidates.find((c) => c.id === body.bankTxnId) || null : null;
  const pick = forced || (!body.forceExpenseDraft && candidates.length === 1 ? candidates[0] : null);

  if (pick) {
    await withUser(userId, async (db) => {
      await assertSyntheticTenant(db, clientId);
      await db.query(
        `UPDATE books_expenses SET bank_txn_id = $3, updated_at = now()
         WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
        [expense.id, clientId, pick.id],
      );
    });
    await updateBooksBankTransaction(userId, clientId, pick.id, {
      note: `Linked expense ${expense.expenseNo || expense.id}`,
    }).catch(() => undefined);
    return {
      kind: "matched_bank",
      bankTxnId: pick.id,
      expenseId: String(expense.id),
      description: pick.description,
    };
  }

  return {
    kind: "expense_draft",
    expenseId: String(expense.id),
    candidates,
  };
}
