/**
 * P6-4b: corporate tax ESTIMATE for the P&L banner.
 * 9% of taxable income above AED 375,000. Not a tax computation — no adjustments.
 */
import { withUser } from "@/lib/db";
import { fiscalYearForDate } from "@/lib/fiscal-year";
import { booksProfitAndLoss } from "@/server/books/financial-statements";
import { fiscalYearBounds } from "@/server/books/period-columns";
import { assertSyntheticTenant } from "@/server/security-gate";

/** AED 375,000 in fils. */
export const CT_THRESHOLD_MINOR = 37_500_000;
/** 9% in basis points. */
export const CT_ESTIMATE_RATE_BPS = 900;

/**
 * Taxable income = net profit before CT (fils). Returns CT payable estimate in fils.
 * Hand checks: 300_000 AED → 0; 375_000 → 0; 500_000 → 11_250.00 AED (1_125_000 fils).
 */
export function estimateCtPayableMinor(taxableIncomeBeforeCtMinor: number): number {
  const taxable = Math.trunc(Number(taxableIncomeBeforeCtMinor) || 0);
  const excess = taxable - CT_THRESHOLD_MINOR;
  if (excess <= 0) return 0;
  return Math.floor((excess * CT_ESTIMATE_RATE_BPS) / 10_000);
}

/** Small Business Relief: revenue up to AED 3,000,000, for tax periods ending by 31 Dec 2026. */
export const SBR_REVENUE_LIMIT_MINOR = 300_000_000;
export const SBR_LAST_PERIOD_END = "2026-12-31";

/** Filing due = the end of the 9th month after the tax period ends (30 Jun → 31 Mar, 28 Feb → 30 Nov). */
export function ctFilingDueDate(fiscalYearEndIso: string): string {
  const [ys, ms] = fiscalYearEndIso.slice(0, 10).split("-").map(Number);
  const total = ys * 12 + (ms - 1) + 9;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

export type CtBanner = {
  taxYearLabel: string;
  fiscalYear: number;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  filingDue: string;
  taxableIncomeMinor: number;
  estimateMinor: number;
  /** Revenue for the year so far (fils). */
  revenueMinor: number;
  /**
   * Revenue so far is within the Small Business Relief limit and the tax period qualifies.
   * Eligibility only — does not mean relief is elected.
   */
  smallBusinessReliefMayApply: boolean;
  /** Company recorded SBR election (null = unset). */
  sbrElected: boolean | null;
  /** Company recorded QFZP status (null = unset). */
  isQfzp: boolean | null;
  /**
   * True only when SBR is elected and eligibility holds, or QFZP is recorded true.
   * UI must not claim "no tax due" unless this is true.
   */
  noTaxDueRecorded: boolean;
  disclaimer: string;
};

export function buildCtBanner(args: {
  fiscalYear: number;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  /** YTD net profit before CT expense (fils). */
  taxableIncomeMinor: number;
  /** YTD revenue (fils). */
  revenueMinor?: number;
  sbrElected?: boolean | null;
  isQfzp?: boolean | null;
}): CtBanner {
  const revenueMinor = args.revenueMinor ?? 0;
  const sbrElected = args.sbrElected ?? null;
  const isQfzp = args.isQfzp ?? null;
  const smallBusinessReliefMayApply =
    revenueMinor <= SBR_REVENUE_LIMIT_MINOR && args.fiscalYearEnd <= SBR_LAST_PERIOD_END;
  const noTaxDueRecorded =
    (sbrElected === true && smallBusinessReliefMayApply) || isQfzp === true;
  const estimateMinor = noTaxDueRecorded ? 0 : estimateCtPayableMinor(args.taxableIncomeMinor);
  return {
    taxYearLabel: `FY${args.fiscalYear}`,
    fiscalYear: args.fiscalYear,
    fiscalYearStart: args.fiscalYearStart,
    fiscalYearEnd: args.fiscalYearEnd,
    filingDue: ctFilingDueDate(args.fiscalYearEnd),
    taxableIncomeMinor: args.taxableIncomeMinor,
    estimateMinor,
    revenueMinor,
    smallBusinessReliefMayApply,
    sbrElected,
    isQfzp,
    noTaxDueRecorded,
    disclaimer: "estimate — not a tax computation",
  };
}

/**
 * YTD CT estimate for the fiscal year containing `asOf`.
 * Taxable income = P&L ebt (profit before corporate-tax expense) for FY start → asOf.
 * Forecasts are never included (P&L reads journals only).
 */
export async function booksCtEstimateBanner(
  userId: string,
  clientId: string,
  asOf: string,
): Promise<CtBanner> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const client = await db.query(
      `SELECT fiscal_year_start_month AS m, sbr_elected, is_qfzp FROM clients WHERE id = $1`,
      [clientId],
    );
    const fyStartMonth = Number(client.rows[0]?.m || 1);
    const fy = fiscalYearForDate(asOf, fyStartMonth);
    const bounds = fiscalYearBounds(fy, fyStartMonth);
    const to = asOf < bounds.end ? asOf : bounds.end;
    const sbrElected =
      client.rows[0]?.sbr_elected == null ? null : Boolean(client.rows[0].sbr_elected);
    const isQfzp = client.rows[0]?.is_qfzp == null ? null : Boolean(client.rows[0].is_qfzp);
    // Leave withUser so nested booksProfitAndLoss can open its own transaction.
    return { fy, bounds, to, fyStartMonth, sbrElected, isQfzp };
  }).then(async ({ fy, bounds, to, sbrElected, isQfzp }) => {
    const pnl = await booksProfitAndLoss(userId, clientId, {
      mode: "range",
      from: bounds.start,
      to,
    });
    const col = pnl.columns[0];
    const taxableIncomeMinor = col?.ebtMinor ?? 0;
    // Revenue section of the same P&L column (what Small Business Relief is tested on).
    const revenueMinor = col
      ? col.sections.find((sec) => sec.key === "PL_revenue")?.totalMinor ?? 0
      : 0;
    return buildCtBanner({
      fiscalYear: fy,
      fiscalYearStart: bounds.start,
      fiscalYearEnd: bounds.end,
      taxableIncomeMinor,
      revenueMinor,
      sbrElected,
      isQfzp,
    });
  });
}
