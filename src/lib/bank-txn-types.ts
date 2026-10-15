/** Shared bank transaction type codes (C3). Keep in sync with DB CHECK on books_bank_transactions.txn_type. */
export const BANK_TXN_TYPES = [
  "customer_receipt",
  "supplier_payment",
  "transfer",
  "card_repayment",
  "gateway_payout",
  "bank_charge",
  "owner_capital",
  "owner_drawings",
  "loan",
  "tax_payment",
  "other_income",
  "other_expense",
] as const;

export type BooksBankTxnType = (typeof BANK_TXN_TYPES)[number];

export const BANK_TXN_TYPE_LABEL: Record<BooksBankTxnType, string> = {
  customer_receipt: "Customer receipt",
  supplier_payment: "Supplier payment",
  transfer: "Transfer",
  card_repayment: "Card repayment",
  gateway_payout: "Gateway payout",
  bank_charge: "Bank charge",
  owner_capital: "Owner capital",
  owner_drawings: "Owner drawings",
  loan: "Loan",
  tax_payment: "Tax payment",
  other_income: "Other income",
  other_expense: "Other expense",
};
