/**
 * P7-1: Company Health summary metrics from posted journals only (fils).
 * P7-2: AR/AP trackers + DSO / DPO / CCC from open items + P&L (same period).
 */
import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { booksAgeing, type AgeingRow } from "@/server/books/ageing";
import {
  booksBalanceSheet,
  booksCashFlow,
  booksProfitAndLoss,
  type BsColumn,
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

export type TrackerStatus = "overdue" | "upcoming" | "pending";

export type ArApTrackerRow = {
  side: "AR" | "AP";
  partyId: string;
  partyName: string;
  ref: string;
  amountMinor: number;
  dueDate: string | null;
  overdueDays: number;
  status: TrackerStatus;
  avgPaymentDays: number | null;
  documentId: string | null;
  highlightOverdue: boolean;
};

export type PaymentBehaviour = {
  dsoDays: number | null;
  dpoDays: number | null;
  dioDays: number | null;
  cashConversionCycleDays: number | null;
  /** Collections ÷ billings in period (basis points; 10_000 = 100%). null if no billings. */
  collectionRateBps: number | null;
  prior: {
    dsoDays: number | null;
    dpoDays: number | null;
    dioDays: number | null;
    cashConversionCycleDays: number | null;
    collectionRateBps: number | null;
  };
  formulas: {
    dso: string;
    dpo: string;
    dio: string;
    ccc: string;
    collectionRate: string;
  };
};

export type HealthDebtorsCreditors = {
  periodId: string;
  periodLabel: string;
  asOf: string;
  arOutstandingMinor: number;
  apOutstandingMinor: number;
  arOverdueMinor: number;
  apOverdueMinor: number;
  arRows: ArApTrackerRow[];
  apRows: ArApTrackerRow[];
  paymentBehaviour: PaymentBehaviour;
};

/** Inclusive calendar days between period start and end (minimum 1). */
export function daysInPeriod(periodStart: string, periodEnd: string): number {
  const start = Date.parse(`${periodStart.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${periodEnd.slice(0, 10)}T00:00:00Z`);
  const d = Math.floor((end - start) / 86400000) + 1;
  return d > 0 ? d : 1;
}

/** overdue · due within 7 days · not due for more than 7 days */
export function trackerStatus(overdueDays: number): TrackerStatus {
  if (overdueDays > 0) return "overdue";
  if (overdueDays >= -7) return "pending";
  return "upcoming";
}

/** DSO = trade receivables × days ÷ credit revenue (fils); null when revenue ≤ 0. */
export function dsoDays(
  receivablesMinor: number,
  revenueMinor: number,
  periodDays: number,
): number | null {
  const rev = Math.trunc(revenueMinor);
  if (rev <= 0) return null;
  return Math.floor((Math.max(0, Math.trunc(receivablesMinor)) * periodDays) / rev);
}

/** DPO = trade payables × days ÷ COGS (fils); null when COGS ≤ 0. */
export function dpoDays(payablesMinor: number, cogsMinor: number, periodDays: number): number | null {
  const cogs = Math.trunc(cogsMinor);
  if (cogs <= 0) return null;
  return Math.floor((Math.max(0, Math.trunc(payablesMinor)) * periodDays) / cogs);
}

/** DIO = inventory × days ÷ COGS; null when COGS ≤ 0 or inventory ≤ 0. */
export function dioDays(inventoryMinor: number, cogsMinor: number, periodDays: number): number | null {
  const inv = Math.trunc(inventoryMinor);
  const cogs = Math.trunc(cogsMinor);
  if (cogs <= 0 || inv <= 0) return null;
  return Math.floor((inv * periodDays) / cogs);
}

export function cashConversionCycleDays(
  dso: number | null,
  dio: number | null,
  dpo: number | null,
): number | null {
  if (dso == null || dpo == null) return null;
  return Math.trunc(dso + (dio ?? 0) - dpo);
}

export function collectionRateBps(collectionsMinor: number, billingsMinor: number): number | null {
  const bill = Math.trunc(billingsMinor);
  if (bill <= 0) return null;
  return Math.min(10_000, Math.floor((Math.max(0, Math.trunc(collectionsMinor)) * 10_000) / bill));
}

function inventoryMinorFromBs(bs: BsColumn | undefined): number {
  if (!bs) return 0;
  let sum = 0;
  for (const sec of bs.assets) {
    for (const acct of sec.accounts) {
      // COA v2 inventory family is 15xx (Finished goods / Raw materials); also match by name.
      if (acct.code.startsWith("15") || /inventory|finished goods|raw materials/i.test(acct.name)) {
        sum += Math.trunc(acct.amountMinor);
      }
    }
  }
  return Math.max(0, sum);
}

function ageingRowToTracker(row: AgeingRow, side: "AR" | "AP", avgByParty: Map<string, number>): ArApTrackerRow {
  const avgPaymentDays = avgByParty.get(row.partyId) ?? null;
  return {
    side,
    partyId: row.partyId,
    partyName: row.partyName,
    ref: row.ref,
    amountMinor: Math.trunc(row.pendingMinor),
    dueDate: row.dueDate,
    overdueDays: row.overdueDays,
    status: trackerStatus(row.overdueDays),
    avgPaymentDays,
    documentId: row.documentId,
    highlightOverdue: row.overdueDays > 0 && row.pendingMinor > 0,
  };
}

async function avgPaymentDaysByParty(
  userId: string,
  clientId: string,
  side: "AR" | "AP",
  from: string,
  to: string,
): Promise<Map<string, number>> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT oi.party_id,
              AVG((s.issue_date - d.issue_date))::double precision AS avg_days
       FROM books_allocations a
       JOIN books_open_items oi ON oi.id = a.open_item_id
       JOIN books_documents d ON d.id = oi.document_id
       JOIN books_documents s ON s.id = a.settlement_document_id
       WHERE oi.client_id = $1 AND oi.side = $2
         AND s.status = 'posted' AND s.deleted_at IS NULL
         AND d.status = 'posted' AND d.deleted_at IS NULL
         AND s.issue_date >= $3::date AND s.issue_date <= $4::date
       GROUP BY oi.party_id`,
      [clientId, side, from, to],
    );
    const out = new Map<string, number>();
    for (const r of rows.rows) {
      const avg = Number(r.avg_days);
      if (Number.isFinite(avg)) out.set(String(r.party_id), Math.round(avg));
    }
    return out;
  });
}

async function collectionsAndBillingsMinor(
  userId: string,
  clientId: string,
  side: "AR" | "AP",
  from: string,
  to: string,
): Promise<{ collectionsMinor: number; billingsMinor: number }> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const docType = side === "AR" ? "sales_invoice" : "purchase_bill";
    const settleType = side === "AR" ? "receipt" : "payment";
    const bill = await db.query(
      `SELECT COALESCE(SUM(aed_total_minor), 0)::bigint AS n
       FROM books_documents
       WHERE client_id = $1 AND doc_type = $2 AND status = 'posted' AND deleted_at IS NULL
         AND issue_date >= $3::date AND issue_date <= $4::date`,
      [clientId, docType, from, to],
    );
    const coll = await db.query(
      `SELECT COALESCE(SUM(a.allocated_aed_minor), 0)::bigint AS n
       FROM books_allocations a
       JOIN books_open_items oi ON oi.id = a.open_item_id
       JOIN books_documents s ON s.id = a.settlement_document_id
       WHERE oi.client_id = $1 AND oi.side = $2
         AND s.doc_type = $3 AND s.status = 'posted' AND s.deleted_at IS NULL
         AND s.issue_date >= $4::date AND s.issue_date <= $5::date`,
      [clientId, side, settleType, from, to],
    );
    return {
      billingsMinor: Number(bill.rows[0]?.n ?? 0),
      collectionsMinor: Number(coll.rows[0]?.n ?? 0),
    };
  });
}

async function paymentBehaviourAtPeriod(
  userId: string,
  clientId: string,
  period: PeriodRow,
): Promise<Omit<PaymentBehaviour, "prior" | "formulas">> {
  const days = daysInPeriod(period.periodStart, period.periodEnd);
  const asOf = period.periodEnd;
  const [arAge, apAge, pnl, bs] = await Promise.all([
    booksAgeing(userId, clientId, { side: "AR", asOf }),
    booksAgeing(userId, clientId, { side: "AP", asOf }),
    booksProfitAndLoss(userId, clientId, {
      mode: "range",
      from: period.periodStart,
      to: period.periodEnd,
    }),
    booksBalanceSheet(userId, clientId, {
      mode: "range",
      from: period.periodStart,
      to: period.periodEnd,
    }),
  ]);
  const col = pnl.columns[0];
  const revenueMinor = col?.sections.find((s) => s.key === "PL_revenue")?.totalMinor ?? 0;
  const cogsMinor = col?.sections.find((s) => s.key === "PL_cogs")?.totalMinor ?? 0;
  const arMinor = Math.max(0, arAge.totals.total);
  const apMinor = Math.max(0, apAge.totals.total);
  const invMinor = inventoryMinorFromBs(bs.columns[bs.columns.length - 1]);
  const dso = dsoDays(arMinor, revenueMinor, days);
  const dpo = dpoDays(apMinor, cogsMinor, days);
  const dio = dioDays(invMinor, cogsMinor, days);
  const { collectionsMinor, billingsMinor } = await collectionsAndBillingsMinor(
    userId,
    clientId,
    "AR",
    period.periodStart,
    period.periodEnd,
  );
  return {
    dsoDays: dso,
    dpoDays: dpo,
    dioDays: dio,
    cashConversionCycleDays: cashConversionCycleDays(dso, dio, dpo),
    collectionRateBps: collectionRateBps(collectionsMinor, billingsMinor),
  };
}

export async function booksHealthDebtorsCreditors(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<HealthDebtorsCreditors> {
  if (!periodId) throw new BooksError("period_required", "invalid");
  const periods = await loadPeriods(userId, clientId);
  const idx = periods.findIndex((p) => p.id === periodId);
  if (idx < 0) throw new BooksError("period_not_found", "not_found");
  const period = periods[idx];
  const prior = idx > 0 ? periods[idx - 1] : null;
  const asOf = period.periodEnd;

  const [arAge, apAge, arAvg, apAvg, currentPb, priorPb] = await Promise.all([
    booksAgeing(userId, clientId, { side: "AR", asOf }),
    booksAgeing(userId, clientId, { side: "AP", asOf }),
    avgPaymentDaysByParty(userId, clientId, "AR", period.periodStart, period.periodEnd),
    avgPaymentDaysByParty(userId, clientId, "AP", period.periodStart, period.periodEnd),
    paymentBehaviourAtPeriod(userId, clientId, period),
    prior ? paymentBehaviourAtPeriod(userId, clientId, prior) : Promise.resolve(null),
  ]);

  const arOverdueMinor = arAge.rows
    .filter((r) => r.overdueDays > 0 && r.pendingMinor > 0)
    .reduce((s, r) => s + r.pendingMinor, 0);
  const apOverdueMinor = apAge.rows
    .filter((r) => r.overdueDays > 0 && r.pendingMinor > 0)
    .reduce((s, r) => s + r.pendingMinor, 0);

  const formulas = {
    dso: "Trade receivables (ageing total) × days in period ÷ revenue (P&L)",
    dpo: "Trade payables (ageing total) × days in period ÷ cost of sales (P&L)",
    dio: "Inventory (balance sheet) × days in period ÷ cost of sales; omitted when inventory is zero",
    ccc: "DSO + DIO − DPO (DIO treated as 0 when not shown)",
    collectionRate: "AR allocations posted in period ÷ sales invoices posted in period",
  };

  return {
    periodId: period.id,
    periodLabel: period.label,
    asOf,
    arOutstandingMinor: arAge.totals.total,
    apOutstandingMinor: apAge.totals.total,
    arOverdueMinor,
    apOverdueMinor,
    arRows: arAge.rows.map((r) => ageingRowToTracker(r, "AR", arAvg)),
    apRows: apAge.rows.map((r) => ageingRowToTracker(r, "AP", apAvg)),
    paymentBehaviour: {
      ...currentPb,
      prior: priorPb ?? {
        dsoDays: null,
        dpoDays: null,
        dioDays: null,
        cashConversionCycleDays: null,
        collectionRateBps: null,
      },
      formulas,
    },
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
