"use client";

import { useMemo, useState } from "react";

import {
  buildFsChartSeries,
  type FsChartMetric,
  type PnlColumnForChart,
} from "@/lib/fs-chart-series";
import { formatMinor } from "@/lib/money";

const METRICS: Array<{ key: FsChartMetric; label: string }> = [
  { key: "revenue", label: "Revenue" },
  { key: "expenses", label: "Expenses" },
  { key: "net_profit", label: "Net profit" },
];

/** SVG bar chart for P&L columns — no charting library. */
export function FsMetricChart({ columns }: { columns: PnlColumnForChart[] }) {
  const [metric, setMetric] = useState<FsChartMetric>("revenue");
  const [logScale, setLogScale] = useState(false);
  const series = useMemo(() => buildFsChartSeries(columns, metric), [columns, metric]);

  const maxAbs = Math.max(1, ...series.map((p) => Math.abs(p.amountMinor)));
  const height = 140;
  const barW = 36;
  const gap = 16;
  const padL = 48;
  const padB = 28;
  const width = padL + series.length * (barW + gap) + gap;

  function barHeight(minor: number): number {
    const v = Math.abs(minor);
    if (!logScale) return (v / maxAbs) * (height - 8);
    if (v <= 0) return 0;
    const maxLog = Math.log10(maxAbs + 1);
    return (Math.log10(v + 1) / maxLog) * (height - 8);
  }

  const current = series[series.length - 1];

  return (
    <div
      className="rounded-lg border border-border bg-card p-3 print:hidden"
      data-testid="fs-metric-chart"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`rounded-md px-2 py-1 text-xs ${
                metric === m.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}
              onClick={() => setMetric(m.key)}
              data-testid={`fs-chart-metric-${m.key}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={logScale}
            onChange={(e) => setLogScale(e.target.checked)}
            data-testid="fs-chart-log"
          />
          Log scale
        </label>
      </div>
      {current ? (
        <p className="mb-1 text-sm" data-testid="fs-chart-current">
          {current.label}: <span className="font-medium tabular-nums">{formatMinor(current.amountMinor)}</span>
          {current.pctChange != null ? (
            <span className="ms-2 text-muted-foreground">
              {current.pctChange >= 0 ? "+" : ""}
              {current.pctChange}% vs prior
            </span>
          ) : null}
        </p>
      ) : null}
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height + padB}`}
        role="img"
        aria-label={`${metric} by period`}
        data-testid="fs-chart-svg"
      >
        <text x={4} y={12} className="fill-muted-foreground" fontSize={9}>
          AED
        </text>
        {series.map((p, i) => {
          const h = barHeight(p.amountMinor);
          const x = padL + i * (barW + gap);
          const y = height - h;
          return (
            <g key={p.key}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, p.amountMinor === 0 ? 0 : 2)}
                rx={3}
                className={p.projected ? "fill-amber-400/80" : "fill-primary/80"}
              />
              <text
                x={x + barW / 2}
                y={height + 14}
                textAnchor="middle"
                fontSize={9}
                className="fill-muted-foreground"
              >
                {p.label.replace(/^MTD |^QTD |^YTD /, "").slice(0, 8)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
