/**
 * P6-4c: pure series for the P&L metric chart (Revenue / Expenses / Net profit).
 * Amounts are fils; % change is like-for-like vs prior column when both non-zero.
 */

export type FsChartMetric = "revenue" | "expenses" | "net_profit";

export type FsChartPoint = {
  key: string;
  label: string;
  amountMinor: number;
  /** Percent change vs previous point; null if undefined. */
  pctChange: number | null;
  projected?: boolean;
};

export type PnlColumnForChart = {
  column: { key: string; label: string };
  sections: Array<{ key: string; totalMinor: number; netMinor?: number }>;
  netProfitMinor: number;
  projected?: boolean;
};

export function metricAmountMinor(col: PnlColumnForChart, metric: FsChartMetric): number {
  if (metric === "net_profit") return Math.trunc(col.netProfitMinor || 0);
  if (metric === "revenue") {
    return Math.trunc(col.sections.find((s) => s.key === "PL_revenue")?.totalMinor || 0);
  }
  // Match table: cogs + opex + depr + tax + expense side of PL_other (negative net → expense).
  const keys = new Set(["PL_cogs", "PL_opex", "PL_depr", "PL_tax"]);
  let sum = col.sections
    .filter((s) => keys.has(s.key))
    .reduce((acc, s) => acc + Math.trunc(s.totalMinor || 0), 0);
  const other = col.sections.find((s) => s.key === "PL_other");
  if (other) {
    const net = other.netMinor != null ? Math.trunc(other.netMinor) : 0;
    if (net < 0) sum += -net;
  }
  return sum;
}

export function buildFsChartSeries(
  columns: PnlColumnForChart[],
  metric: FsChartMetric,
): FsChartPoint[] {
  const amounts = columns.map((c) => metricAmountMinor(c, metric));
  return columns.map((c, i) => {
    const amountMinor = amounts[i];
    const prev = i > 0 ? amounts[i - 1] : null;
    let pctChange: number | null = null;
    if (prev != null && prev !== 0) {
      pctChange = Math.round(((amountMinor - prev) / Math.abs(prev)) * 10000) / 100;
    }
    return {
      key: c.column.key,
      label: c.column.label,
      amountMinor,
      pctChange,
      projected: Boolean(c.projected),
    };
  });
}
