/** Pure helpers for bank txn draft allocations (P2A-1). Safe for client + server. */

export const BANK_TXN_ALLOC_KINDS = [
  "against_item",
  "on_account",
  "advance",
  "bank_fee",
  "fx_difference",
  "discount",
] as const;
export type BankTxnAllocKind = (typeof BANK_TXN_ALLOC_KINDS)[number];

/** bank − explained; 0 means Ready-to-post for receipt/payment. */
export function bankTxnUnallocatedMinor(
  bankAmountMinor: number,
  lines: Array<{ allocKind: string; amountOriginalMinor: number }>,
  side: "receipt" | "payment",
): number {
  let against = 0;
  let rem = 0;
  let fees = 0;
  let discount = 0;
  for (const l of lines) {
    const amt = Number(l.amountOriginalMinor || 0);
    if (l.allocKind === "against_item") against += amt;
    else if (l.allocKind === "on_account" || l.allocKind === "advance") rem += amt;
    else if (l.allocKind === "discount") discount += amt;
    else if (l.allocKind === "bank_fee" || l.allocKind === "fx_difference") fees += amt;
  }
  const explained =
    side === "receipt" ? against + rem - fees - discount : against + rem + fees - discount;
  return bankAmountMinor - explained;
}
