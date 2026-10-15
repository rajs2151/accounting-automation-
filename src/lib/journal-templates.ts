/**
 * P4-3: Create Entry template builders + accounting-policy warnings.
 * Prepayments must hit asset 1410 (not Dr expense / Cr accrued) — CrossVal mistake to block.
 */

export type JournalTemplateKey =
  | "blank"
  | "accrual"
  | "income_accrual"
  | "prepayment"
  | "depreciation"
  | "reclassification"
  | "payroll"
  | "vat_settlement"
  | "ct_accrual"
  | "bad_debt"
  | "eosb_accrual"
  | "loan_interest"
  | "staff_advance"
  | "staff_advance_recovery";

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
    case "income_accrual":
      return {
        description: "Month-end revenue accrual",
        autoReverseNextPeriod: true,
        lines: [
          { accountCode: "1210", side: "debit", lineMemo: "Trade receivable (accrued revenue)" },
          { accountCode: "4100", side: "credit", lineMemo: "Revenue (accrued)" },
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
          { accountCode: "2330", side: "credit", lineMemo: "Salaries payable" },
        ],
        hint: "Credits 2330 Salaries payable (not 2120 accrued expenses). Clear 2330 when wages are paid from bank.",
      };
    case "vat_settlement":
      return {
        description: "VAT settlement",
        autoReverseNextPeriod: false,
        lines: [],
        hint: "Balances load from the period VAT controls when applied in the UI.",
      };
    case "ct_accrual":
      return {
        description: "CT accrual (estimate)",
        autoReverseNextPeriod: false,
        lines: [
          { accountCode: "8100", side: "debit", lineMemo: "Corporate tax expense (estimate accrual)" },
          { accountCode: "2230", side: "credit", lineMemo: "Corporate tax payable (estimate accrual)" },
        ],
        hint: "Amounts load from the CT estimate vs 2230 when applied in the UI (top-up or reverse).",
        warning: "Estimate only — not a tax computation. Confirm SBR / QFZP in Settings before year-end.",
      };
    case "bad_debt":
      return {
        description: "Bad debt write-off",
        autoReverseNextPeriod: false,
        lines: [
          { accountCode: "4900", side: "debit", lineMemo: "Bad debt / write-off" },
          { accountCode: "1210", side: "credit", lineMemo: "Clear trade receivable" },
        ],
        warning:
          "Manual template only seeds accounts. Prefer Receivables ageing → Write off so the open item is closed (keeps 1210 vs open items tied).",
        hint: "Dr 4900 / Cr 1210 — amounts must match the invoice you are writing off.",
      };
    case "eosb_accrual":
      return {
        description: "EOSB monthly accrual",
        autoReverseNextPeriod: false,
        lines: [
          { accountCode: "6110", side: "debit", lineMemo: "Employee benefits & EOSB" },
          { accountCode: "2410", side: "credit", lineMemo: "EOSB provision" },
        ],
        hint: "Enter this month's EOSB accrual (manual). Close warns if 2410 has had no movement this period.",
      };
    case "loan_interest":
      return {
        description: "Loan interest accrual",
        autoReverseNextPeriod: false,
        lines: [
          { accountCode: "7400", side: "debit", lineMemo: "Interest expense" },
          { accountCode: "2420", side: "credit", lineMemo: "Accrue loan interest" },
        ],
        hint: "Prefer Loans → Run interest so the register tracks the period. Manual fill when needed.",
      };
    case "staff_advance":
      return {
        description: "Staff advance payment",
        autoReverseNextPeriod: false,
        lines: [
          { accountCode: "1230", side: "debit", lineMemo: "Employee advance" },
          { accountCode: "1120", side: "credit", lineMemo: "Bank payment" },
        ],
        hint: "Pays cash to an employee as an advance (asset 1230). Recover later via Staff advance recovery.",
      };
    case "staff_advance_recovery":
      return {
        description: "Staff advance recovery",
        autoReverseNextPeriod: false,
        lines: [
          { accountCode: "6100", side: "debit", lineMemo: "Salaries & wages (gross)" },
          { accountCode: "1230", side: "credit", lineMemo: "Recover employee advance" },
          { accountCode: "2330", side: "credit", lineMemo: "Net salaries payable" },
        ],
        hint: "Typical recovery on payroll: Dr gross wages, Cr 1230 for the recovery, Cr 2330 for net pay. Adjust amounts so the entry balances.",
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
