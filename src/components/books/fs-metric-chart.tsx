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

  const height = 140;
  const barW = 36;
  const gap = 16;
  const padL = 48;
  const padB = 28;
  const width = padL + series.length * (barW + gap) + gap;

  // Zero baseline: profits rise above it, losses hang below it (a loss must not look like a profit).
  const maxPos = Math.max(0, ...series.map((p) => p.amountMinor));
  const maxNeg = Math.max(0, ...series.map((p) => -p.amountMinor));
  const plot = height - 8;
  const zeroY = 4 + (maxPos + maxNeg > 0 ? (plot * maxPos) / (maxPos + maxNeg) : plot);

  function scaled(v: number, max: number, room: number): number {
    if (v <= 0 || max <= 0) return 0;
    if (!logScale) return (v / max) * room;
    return (Math.log10(v + 1) / Math.log10(max + 1)) * room;
  }

  function bar(minor: number): { y: number; h: number } {
    if (minor >= 0) {
      const h = scaled(minor, maxPos, zeroY - 4);
      return { y: zeroY - h, h };
    }
    return { y: zeroY, h: scaled(-minor, maxNeg, height - zeroY) };
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
        <line x1={padL - 4} x2={width} y1={zeroY} y2={zeroY} className="stroke-border" strokeWidth={1} />
        {series.map((p, i) => {
          const { y, h } = bar(p.amountMinor);
          const x = padL + i * (barW + gap);
          return (
            <g key={p.key}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, p.amountMinor === 0 ? 0 : 2)}
                rx={3}
                className={
                  p.amountMinor < 0 ? "fill-red-500/80" : p.projected ? "fill-amber-400/80" : "fill-primary/80"
                }
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
