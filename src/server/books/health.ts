/**
 * P7-1: Company Health summary metrics from posted journals only (fils).
 * Cash / runway / L÷A — no forecasts, no LLM.
 */
import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import {
  booksBalanceSheet,
  booksCashFlow,
} from "@/server/books/financial-statements";
import { assertSyntheticTenant } from "@/server/security-gate";

export type HealthMetricChange = {
  priorMinor: number | null;
  deltaMinor: number | null;
};

export type CashRunway =
  | { kind: "months"; monthsMilli: number; burnMinor: number }
  | { kind: "cash_positive" };

export type HealthSummary = {
  periodId: string;
  periodLabel: string;
  periodEnd: string;
  cashOnHandMinor: number;
  cashOnHandChange: HealthMetricChange;
  avgNetCashFlowMinor: number;
  avgNetCashFlowChange: HealthMetricChange;
  /** Last up-to-3 monthly net cash changes used in the average (newest last). */
  monthlyNetCashFlowsMinor: number[];
  runway: CashRunway;
  priorRunway: CashRunway | null;
  liabilitiesAssetsRatioBps: number | null;
  liabilitiesAssetsRatioChange: {
    priorBps: number | null;
    deltaBps: number | null;
  };
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  formulas: {
    cashOnHand: string;
    avgNetCashFlow: string;
    runway: string;
    liabilitiesAssets: string;
  };
};

/** Average of monthly net cash flows (fils); empty → 0. */
export function avgNetCashFlowMinor(monthlyFlows: number[]): number {
  if (!monthlyFlows.length) return 0;
  const sum = monthlyFlows.reduce((s, v) => s + Math.trunc(v), 0);
  return Math.trunc(sum / monthlyFlows.length);
}

/**
 * Runway = cash ÷ monthly burn when avg net cash flow is negative.
 * Burn = −avgNetCashFlow. monthsMilli = floor(cash × 1000 / burn) (3 decimal months).
 */
export function cashRunway(cashOnHandMinor: number, avgNetFlowMinor: number): CashRunway {
  const cash = Math.trunc(cashOnHandMinor);
  const avg = Math.trunc(avgNetFlowMinor);
  if (avg >= 0) return { kind: "cash_positive" };
  const burn = -avg;
  if (burn <= 0) return { kind: "cash_positive" };
  return {
    kind: "months",
    monthsMilli: Math.floor((cash * 1000) / burn),
    burnMinor: burn,
  };
}

/** Liabilities ÷ assets in basis points (10_000 = 1.00). null if assets ≤ 0. */
export function liabilitiesAssetsRatioBps(
  liabilitiesMinor: number,
  assetsMinor: number,
): number | null {
  const a = Math.trunc(assetsMinor);
  if (a <= 0) return null;
  return Math.floor((Math.trunc(liabilitiesMinor) * 10_000) / a);
}

export function deltaOrNull(current: number, prior: number | null | undefined): number | null {
  if (prior == null || !Number.isFinite(prior)) return null;
  return Math.trunc(current) - Math.trunc(prior);
}

type PeriodRow = {
  id: string;
  label: string;
  periodStart: string;
  periodEnd: string;
};

async function loadPeriods(userId: string, clientId: string): Promise<PeriodRow[]> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, label, period_start AS "periodStart", period_end AS "periodEnd"
       FROM books_periods WHERE client_id = $1
       ORDER BY period_start`,
      [clientId],
    );
    return rows.rows.map((r) => ({
      id: String(r.id),
      label: String(r.label),
      periodStart: String(r.periodStart).slice(0, 10),
      periodEnd: String(r.periodEnd).slice(0, 10),
    }));
  });
}

async function metricsAtPeriod(
  userId: string,
  clientId: string,
  periods: PeriodRow[],
  periodId: string,
): Promise<{
  period: PeriodRow;
  cashOnHandMinor: number;
  avgNetCashFlowMinor: number;
  monthlyNetCashFlowsMinor: number[];
  runway: CashRunway;
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  liabilitiesAssetsRatioBps: number | null;
}> {
  const idx = periods.findIndex((p) => p.id === periodId);
  if (idx < 0) throw new BooksError("period_not_found", "not_found");
  const period = periods[idx];
  const window = periods.slice(Math.max(0, idx - 2), idx + 1);
  if (!window.length) throw new BooksError("period_not_found", "not_found");

  const from = window[0].periodStart;
  const to = period.periodEnd;
  const [cf, bs] = await Promise.all([
    booksCashFlow(userId, clientId, { mode: "monthly", from, to }),
    booksBalanceSheet(userId, clientId, { mode: "monthly", from: period.periodStart, to }),
  ]);

  const monthlyNetCashFlowsMinor = cf.columns.map((c) => Math.trunc(c.netChangeMinor));
  const lastCf = cf.columns[cf.columns.length - 1];
  const cashOnHandMinor = Math.trunc(lastCf?.closingCashMinor ?? 0);
  const avg = avgNetCashFlowMinor(monthlyNetCashFlowsMinor);
  const lastBs = bs.columns[bs.columns.length - 1];
  const totalAssetsMinor = Math.trunc(lastBs?.totalAssetsMinor ?? 0);
  const totalLiabilitiesMinor = Math.trunc(lastBs?.totalLiabilitiesMinor ?? 0);

  return {
    period,
    cashOnHandMinor,
    avgNetCashFlowMinor: avg,
    monthlyNetCashFlowsMinor,
    runway: cashRunway(cashOnHandMinor, avg),
    totalAssetsMinor,
    totalLiabilitiesMinor,
    liabilitiesAssetsRatioBps: liabilitiesAssetsRatioBps(totalLiabilitiesMinor, totalAssetsMinor),
  };
}

export async function booksHealthSummary(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<HealthSummary> {
  if (!periodId) throw new BooksError("period_required", "invalid");
  const periods = await loadPeriods(userId, clientId);
  const current = await metricsAtPeriod(userId, clientId, periods, periodId);
  const idx = periods.findIndex((p) => p.id === periodId);
  const priorId = idx > 0 ? periods[idx - 1].id : null;
  const prior = priorId ? await metricsAtPeriod(userId, clientId, periods, priorId) : null;

  return {
    periodId: current.period.id,
    periodLabel: current.period.label,
    periodEnd: current.period.periodEnd,
    cashOnHandMinor: current.cashOnHandMinor,
    cashOnHandChange: {
      priorMinor: prior?.cashOnHandMinor ?? null,
      deltaMinor: deltaOrNull(current.cashOnHandMinor, prior?.cashOnHandMinor),
    },
    avgNetCashFlowMinor: current.avgNetCashFlowMinor,
    avgNetCashFlowChange: {
      priorMinor: prior?.avgNetCashFlowMinor ?? null,
      deltaMinor: deltaOrNull(current.avgNetCashFlowMinor, prior?.avgNetCashFlowMinor),
    },
    monthlyNetCashFlowsMinor: current.monthlyNetCashFlowsMinor,
    runway: current.runway,
    priorRunway: prior?.runway ?? null,
    liabilitiesAssetsRatioBps: current.liabilitiesAssetsRatioBps,
    liabilitiesAssetsRatioChange: {
      priorBps: prior?.liabilitiesAssetsRatioBps ?? null,
      deltaBps:
        current.liabilitiesAssetsRatioBps != null && prior?.liabilitiesAssetsRatioBps != null
          ? current.liabilitiesAssetsRatioBps - prior.liabilitiesAssetsRatioBps
          : null,
    },
    totalAssetsMinor: current.totalAssetsMinor,
    totalLiabilitiesMinor: current.totalLiabilitiesMinor,
    formulas: {
      cashOnHand: "Sum of posted balances in cash + bank accounts (excl. clearing/gateway/transfer) as of period end",
      avgNetCashFlow: "Average of net change in cash (indirect CF) over up to the last 3 months ending this period",
      runway: "Cash on hand ÷ monthly burn (−avg net cash flow); n/a when cash flow is not negative",
      liabilitiesAssets: "Total liabilities ÷ total assets (balance sheet as of period end)",
    },
  };
}
