/**
 * Phase 3 rank 4: corporate-tax accrual draft from the P&L estimate.
 * Dr 8100 (CT expense) / Cr 2230 (CT payable) for the top-up (or reverse if over-accrued).
 * Not a tax computation — same estimate banner maths (9% above AED 375k, SBR/QFZP → 0).
 */
import { withUser } from "@/lib/db";
import { fiscalYearForDate } from "@/lib/fiscal-year";
import { formatMinor } from "@/lib/money";
import { booksCtEstimateBanner } from "@/server/books/ct-estimate";
import { BooksError } from "@/server/books/errors";
import { fiscalYearBounds } from "@/server/books/period-columns";
import { assertSyntheticTenant } from "@/server/security-gate";

const CT_EXPENSE_CODE = "8100";
const CT_PAYABLE_CODE = "2230";

export type CtAccrualLine = {
  accountId: string;
  accountCode: string;
  debitMinor: number;
  creditMinor: number;
  lineMemo: string;
};

export type CtAccrualPreview = {
  periodId: string;
  periodLabel: string;
  periodEnd: string;
  fiscalYearEnd: string;
  isFiscalYearEnd: boolean;
  estimateMinor: number;
  bookedPayableMinor: number;
  deltaMinor: number;
  taxYearLabel: string;
  noTaxDueRecorded: boolean;
  disclaimer: string;
  memo: string;
  lines: CtAccrualLine[];
};

/** Signed CT payable on 2230: credit balance → positive; debit balance → negative. */
export function ctPayableFromNetMinor(closingNetDrMinusCr: number): number {
  return -Math.trunc(Number(closingNetDrMinusCr) || 0);
}

/** Top-up (positive) or reverse (negative) to bring 2230 to the estimate. */
export function ctAccrualDeltaMinor(estimateMinor: number, bookedPayableMinor: number): number {
  return Math.trunc(Number(estimateMinor) || 0) - Math.trunc(Number(bookedPayableMinor) || 0);
}

export function buildCtAccrualLines(args: {
  expenseAccountId: string;
  payableAccountId: string;
  deltaMinor: number;
}): CtAccrualLine[] {
  const delta = Math.trunc(args.deltaMinor);
  if (delta === 0) return [];
  if (delta > 0) {
    return [
      {
        accountId: args.expenseAccountId,
        accountCode: CT_EXPENSE_CODE,
        debitMinor: delta,
        creditMinor: 0,
        lineMemo: "Corporate tax expense (estimate accrual)",
      },
      {
        accountId: args.payableAccountId,
        accountCode: CT_PAYABLE_CODE,
        debitMinor: 0,
        creditMinor: delta,
        lineMemo: "Corporate tax payable (estimate accrual)",
      },
    ];
  }
  const rev = -delta;
  return [
    {
      accountId: args.payableAccountId,
      accountCode: CT_PAYABLE_CODE,
      debitMinor: rev,
      creditMinor: 0,
      lineMemo: "Reduce corporate tax payable (estimate)",
    },
    {
      accountId: args.expenseAccountId,
      accountCode: CT_EXPENSE_CODE,
      debitMinor: 0,
      creditMinor: rev,
      lineMemo: "Reduce corporate tax expense (estimate)",
    },
  ];
}

/**
 * Preview (and optional Create Entry fill) for CT accrual as of the period end.
 * Amount = estimate − current 2230 payable so repeat applies top up / reverse only.
 */
export async function booksCtAccrualPreview(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<CtAccrualPreview> {
  const periodMeta = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const period = await db.query(
      `SELECT id, label, period_end FROM books_periods WHERE id = $1 AND client_id = $2`,
      [periodId, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    const periodEnd = String(period.rows[0].period_end).slice(0, 10);
    const client = await db.query(
      `SELECT fiscal_year_start_month AS m FROM clients WHERE id = $1`,
      [clientId],
    );
    const fyStartMonth = Number(client.rows[0]?.m || 1);
    const fy = fiscalYearForDate(periodEnd, fyStartMonth);
    const bounds = fiscalYearBounds(fy, fyStartMonth);

    const accounts = await db.query(
      `SELECT id, code FROM books_accounts
       WHERE client_id = $1 AND code IN ($2, $3)`,
      [clientId, CT_EXPENSE_CODE, CT_PAYABLE_CODE],
    );
    const byCode = new Map(accounts.rows.map((r) => [String(r.code), String(r.id)]));
    const expenseAccountId = byCode.get(CT_EXPENSE_CODE);
    const payableAccountId = byCode.get(CT_PAYABLE_CODE);
    if (!expenseAccountId || !payableAccountId) {
      throw new BooksError("ct_accounts_missing", "not_found");
    }

    const bal = await db.query(
      `SELECT COALESCE(SUM(l.debit_minor),0)::bigint AS dr,
              COALESCE(SUM(l.credit_minor),0)::bigint AS cr
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE e.client_id = $1 AND e.status IN ('posted','reversed')
         AND e.deleted_at IS NULL
         AND e.entry_date <= $2::date
         AND l.account_id = $3`,
      [clientId, periodEnd, payableAccountId],
    );
    const netMinor = Number(bal.rows[0].dr) - Number(bal.rows[0].cr);
    return {
      periodId,
      periodLabel: String(period.rows[0].label),
      periodEnd,
      fiscalYearEnd: bounds.end,
      isFiscalYearEnd: periodEnd === bounds.end,
      expenseAccountId,
      payableAccountId,
      bookedPayableMinor: ctPayableFromNetMinor(netMinor),
    };
  });

  const banner = await booksCtEstimateBanner(userId, clientId, periodMeta.periodEnd);
  const deltaMinor = ctAccrualDeltaMinor(banner.estimateMinor, periodMeta.bookedPayableMinor);
  const lines = buildCtAccrualLines({
    expenseAccountId: periodMeta.expenseAccountId,
    payableAccountId: periodMeta.payableAccountId,
    deltaMinor,
  });

  return {
    periodId: periodMeta.periodId,
    periodLabel: periodMeta.periodLabel,
    periodEnd: periodMeta.periodEnd,
    fiscalYearEnd: periodMeta.fiscalYearEnd,
    isFiscalYearEnd: periodMeta.isFiscalYearEnd,
    estimateMinor: banner.estimateMinor,
    bookedPayableMinor: periodMeta.bookedPayableMinor,
    deltaMinor,
    taxYearLabel: banner.taxYearLabel,
    noTaxDueRecorded: banner.noTaxDueRecorded,
    disclaimer: banner.disclaimer,
    memo: `CT accrual ${banner.taxYearLabel} (estimate)`,
    lines,
  };
}

export type CtAccrualGateState = {
  status: "pass" | "fail" | "info";
  blocking: boolean;
  count: number;
  detail: string;
  href: string;
};

/** Close gate: estimate vs 2230. Blocking only on the fiscal-year-end month. */
export function ctAccrualGateFromAmounts(args: {
  estimateMinor: number;
  bookedPayableMinor: number;
  isFiscalYearEnd: boolean;
  noTaxDueRecorded?: boolean;
}): CtAccrualGateState {
  const estimate = Math.trunc(args.estimateMinor);
  const booked = Math.trunc(args.bookedPayableMinor);
  const match = estimate === booked;
  const money = (n: number) => `AED ${formatMinor(Math.abs(n))}`;
  const href = "/books/journals";
  if (match) {
    return {
      status: "pass",
      blocking: args.isFiscalYearEnd,
      count: 0,
      detail: args.noTaxDueRecorded
        ? "No CT due recorded — 2230 is clear"
        : `2230 matches estimate (${money(estimate)})`,
      href,
    };
  }
  const detail = `Estimate ${money(estimate)} vs 2230 payable ${money(booked)} (gap ${money(estimate - booked)}) — use Create Entry → CT accrual`;
  if (args.isFiscalYearEnd) {
    return { status: "fail", blocking: true, count: 1, detail, href };
  }
  return {
    status: "info",
    blocking: false,
    count: 1,
    detail: `${detail} (info until year-end)`,
    href,
  };
}
