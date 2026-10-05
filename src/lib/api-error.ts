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
