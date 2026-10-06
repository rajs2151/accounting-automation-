/** Readable messages for API error codes. Pages call apiErrorMessage(data) instead of showing raw codes. */
const MESSAGES: Record<string, string> = {
  request_failed: "Something went wrong. Please try again.",
  unauthorized: "Your session has ended. Please sign in again.",
  forbidden: "You don't have permission to do that.",
  not_found: "That item no longer exists.",
  invalid_money: "One of the amounts is not a valid number.",
  upload_failed: "The upload did not complete. Please try again.",
  no_files: "Choose at least one file to upload.",
  period_locked: "That period is locked. Reopen it before posting.",
  period_not_found: "There is no accounting period for that date.",
  not_draft: "Only draft documents can be changed or approved.",
  printed_totals_mismatch: "The totals do not match the printed totals on the document.",
  vat_exceeds_rate: "VAT is more than 5% of the taxable amount. Check the VAT lines.",
  check_vat_unacknowledged: "The supplier has a TRN but a line has no VAT. Acknowledge the VAT check first.",
  post_requires_approver: "Only an approver or admin can approve and post.",
  post_preparer_cannot_approve: "You prepared this document, so someone else must approve it.",
  party_and_period_required: "Choose a party and a period first.",
  bank_account_not_set_up: "Set up bank name / IBAN before uploading to this account.",
  account_not_found: "That bank account was not found.",
  account_requires_client: "Choose a company before uploading to a bank account.",
  txn_type_required: "Choose a transaction type before marking reviewed.",
  category_account_required: "Choose a COA account before marking reviewed.",
  exclude_reason_required: "Give a reason when excluding a transaction.",
  bank_txn_not_found: "That bank transaction was not found.",
  bank_txn_not_editable: "That transaction can no longer be edited.",
  c3_bank_transactions_migration_required: "Database migration db/35 is required for Transactions.",
  c3_bank_txn_match_migration_required: "Database migration db/36 is required for match/post.",
  c3_bank_txn_transfer_migration_required: "Database migration db/37 is required for transfer pairs.",
  bank_txn_not_ready: "Only Ready transactions can be posted.",
  bank_txn_not_reviewed: "Mark the transaction reviewed before posting.",
  match_requires_receipt_or_payment: "Match is only for customer receipts or supplier payments.",
  match_amount_direction: "Amount direction does not match this transaction type.",
  transfer_link_required: "Link the other account’s transfer before posting.",
  transfer_counterpart_not_ready: "Mark the linked transfer Ready before posting.",
  transfer_same_account: "Transfer pair must be between two different accounts.",
  transfer_amount_mismatch: "Transfer amounts must match exactly.",
  transfer_direction_mismatch: "Link an outgoing transfer to an incoming one.",
  transfer_already_linked: "That transfer is already linked.",
  transfer_type_required: "Both sides must be typed as Transfer.",
  void_reason_required: "Give a reason for voiding this document.",
  void_requires_posted: "Only posted documents can be voided.",
  already_void: "This document is already void.",
  void_has_settlements: "Receipts or payments are allocated to this document. Unallocate them before voiding.",
  void_has_linked_notes: "A credit or debit note is linked to this document. Void the note first.",
  void_has_posted_releases: "Deferred revenue has already been released from this invoice.",
  reverse_requires_approver: "Only an approver or admin can reverse or void a posted entry.",
  reverse_preparer_cannot_approve: "You prepared this, so someone else must reverse or void it.",
  original_wrong_type: "A credit note must link to a sales invoice, a debit note to a purchase bill.",
  original_not_posted: "The original document must be posted first.",
  original_party_mismatch: "The note's party must match the original document.",
  original_currency_mismatch: "The note's currency must match the original document.",
  exceeds_original_balance: "The note is more than the original's open balance.",
};

export function apiErrorMessage(data: unknown, fallback = "Something went wrong. Please try again."): string {
  const body = (data && typeof data === "object" ? data : {}) as { error?: unknown; ref?: unknown; message?: unknown };
  const code = typeof body.error === "string" ? body.error : "";
  if (code === "internal_error") {
    return body.ref ? `Something went wrong (ref ${String(body.ref)}). Please try again.` : fallback;
  }
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (code) return code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return fallback;
}
