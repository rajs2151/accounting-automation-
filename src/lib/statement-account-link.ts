import { normalizeIban } from "@/lib/statement-coverage";

export type StatementAccountLinkResult = {
  /** COA account to store on books_statement_extractions.account_id */
  accountId: string | null;
  /** Extra validation flags to append */
  flags: string[];
  /** When true, statement status must stay needs_review (never ready). */
  forceNeedsReview: boolean;
};

/**
 * Decide which COA account a extracted statement row should link to.
 * Never links the intended account when its IBAN ≠ the file IBAN.
 */
export function resolveStatementAccountLink(opts: {
  extractedIban: string | null | undefined;
  intendedAccountId?: string | null;
  intendedAccountIban?: string | null;
  /** Unique normalised IBAN → account id (no intended path). */
  accountIdByIban?: Map<string, string> | Record<string, string>;
}): StatementAccountLinkResult {
  const extracted = normalizeIban(opts.extractedIban);
  const intendedId = opts.intendedAccountId ? String(opts.intendedAccountId) : null;
  const intendedIban = normalizeIban(opts.intendedAccountIban);

  const byIban =
    opts.accountIdByIban instanceof Map
      ? opts.accountIdByIban
      : new Map(Object.entries(opts.accountIdByIban || {}));

  if (intendedId) {
    if (!extracted) {
      // Cash / gateway may have no IBAN on file — allow intended link when account also has none.
      if (!intendedIban) {
        return { accountId: intendedId, flags: [], forceNeedsReview: false };
      }
      return {
        accountId: null,
        flags: ["iban_missing_for_selected_account"],
        forceNeedsReview: true,
      };
    }
    if (intendedIban && extracted !== intendedIban) {
      // Block wrong selected account; soft-link to the account that matches the file if unique.
      const correct = byIban.get(extracted) || null;
      return {
        accountId: correct && correct !== intendedId ? correct : null,
        flags: ["iban_account_mismatch"],
        forceNeedsReview: true,
      };
    }
    // Match, or intended has no IBAN to compare (card last4-only) — trust selection when IBANs agree or account has none.
    if (!intendedIban || extracted === intendedIban) {
      return { accountId: intendedId, flags: [], forceNeedsReview: false };
    }
  }

  if (extracted) {
    const hit = byIban.get(extracted) || null;
    return { accountId: hit, flags: [], forceNeedsReview: false };
  }
  return { accountId: null, flags: [], forceNeedsReview: false };
}
