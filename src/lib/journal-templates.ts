/**
 * P4-3: Create Entry template builders + accounting-policy warnings.
 * Prepayments must hit asset 1410 (not Dr expense / Cr accrued) — CrossVal mistake to block.
 */

export type JournalTemplateKey =
  | "blank"
  | "accrual"
  | "prepayment"
  | "depreciation"
  | "reclassification"
  | "payroll"
  | "vat_settlement";

export type TemplateAccountRef = { id: string; code: string; accountType?: string };

export type TemplateLineSeed = {
  accountCode: string;
  side: "debit" | "credit";
  lineMemo: string;
};

export type TemplateApplyResult = {
  description: string;
  autoReverseNextPeriod: boolean;
  lines: TemplateLineSeed[];
  hint?: string;
  warning?: string;
};

const ACCRUED_CODE = "2120";
const PREPAID_CODE = "1410";

export function buildJournalTemplate(key: JournalTemplateKey): TemplateApplyResult {
  switch (key) {
    case "blank":
      return { description: "", autoReverseNextPeriod: false, lines: [] };
    case "accrual":
      return {
        description: "Month-end accrual",
        autoReverseNextPeriod: true,
        lines: [
          { accountCode: "6200", side: "debit", lineMemo: "Expense (accrued)" },
          { accountCode: ACCRUED_CODE, side: "credit", lineMemo: "Accrued expense" },
        ],
        hint: "Auto-reverse is on — reverses on the 1st of the next open period after post.",
      };
    case "prepayment":
      return {
        description: "Prepayment (asset)",
        autoReverseNextPeriod: false,
        lines: [
          { accountCode: PREPAID_CODE, side: "debit", lineMemo: "Prepaid asset" },
          { accountCode: "1120", side: "credit", lineMemo: "Bank / cash paid" },
        ],
        warning:
          "Prepayments are assets (1410). Do not book Dr expense / Cr accrued — that is an accrual, not a prepayment.",
        hint: "Amortise the prepaid asset to expense in later periods (or use schedule).",
      };
    case "depreciation":
      return {
        description: "Depreciation",
        autoReverseNextPeriod: false,
        lines: [
          { accountCode: "6800", side: "debit", lineMemo: "Depreciation expense" },
          { accountCode: "1690", side: "credit", lineMemo: "Accumulated depreciation" },
        ],
      };
    case "reclassification":
      return {
        description: "Reclassification",
        autoReverseNextPeriod: false,
        lines: [
          { accountCode: "6600", side: "debit", lineMemo: "To account" },
          { accountCode: "4100", side: "credit", lineMemo: "From account" },
        ],
      };
    case "payroll":
      return {
        description: "Payroll",
        autoReverseNextPeriod: false,
        lines: [
          { accountCode: "6100", side: "debit", lineMemo: "Salaries & wages" },
          { accountCode: "2120", side: "credit", lineMemo: "Payroll payable / accrued" },
        ],
      };
    case "vat_settlement":
      return {
        description: "VAT settlement",
        autoReverseNextPeriod: false,
        lines: [],
        hint: "Balances load from the period VAT controls when applied in the UI.",
      };
    default:
      return { description: "", autoReverseNextPeriod: false, lines: [] };
  }
}

/**
 * True when lines look like the CrossVal prepaid mistake:
 * expense account paired with accrued expenses (2120) instead of prepaid asset 1410.
 * Callers should skip this check for intentional accrual/payroll templates.
 */
export function warnPrepaymentBookedAsAccrual(
  lines: Array<{ accountId: string; debitMinor: number; creditMinor: number }>,
  accounts: TemplateAccountRef[],
): string | null {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  let hasExpense = false;
  let hasAccrued = false;
  let hasPrepaid = false;

  for (const line of lines) {
    if (!line.accountId) continue;
    const acct = byId.get(line.accountId);
    if (!acct) continue;
    if (acct.code === PREPAID_CODE) hasPrepaid = true;
    if (acct.code === ACCRUED_CODE) hasAccrued = true;
    if (acct.accountType === "expense" || /^[56]/.test(acct.code)) hasExpense = true;
  }

  if (hasPrepaid) return null;
  if (hasExpense && hasAccrued) {
    return "This looks like an accrual (Dr expense / Cr 2120). For a prepaid campaign or deposit, use the Prepayment template (Dr 1410 asset).";
  }
  return null;
}
