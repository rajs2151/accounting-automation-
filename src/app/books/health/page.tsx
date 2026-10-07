"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useBooksShell } from "@/components/books/books-shell-context";
import { apiErrorMessage } from "@/lib/api-error";
import { formatMinor } from "@/lib/money";

type CashRunway =
  | { kind: "months"; monthsMilli: number; burnMinor: number }
  | { kind: "cash_positive" };

type HealthSummary = {
  periodLabel: string;
  cashOnHandMinor: number;
  cashOnHandChange: { priorMinor: number | null; deltaMinor: number | null };
  avgNetCashFlowMinor: number;
  avgNetCashFlowChange: { priorMinor: number | null; deltaMinor: number | null };
  runway: CashRunway;
  priorRunway: CashRunway | null;
  liabilitiesAssetsRatioBps: number | null;
  liabilitiesAssetsRatioChange: { priorBps: number | null; deltaBps: number | null };
  formulas: {
    cashOnHand: string;
    avgNetCashFlow: string;
    runway: string;
    liabilitiesAssets: string;
  };
};

type TabKey = "dashboard" | "scorecard" | "runway" | "profitability" | "debtors";

const TABS: Array<{ key: TabKey; label: string; ready: boolean }> = [
  { key: "dashboard", label: "Dashboard", ready: true },
  { key: "scorecard", label: "Company Scorecard", ready: false },
  { key: "runway", label: "Cash Flow & Runway", ready: false },
  { key: "profitability", label: "Profitability & Cost Trends", ready: false },
  { key: "debtors", label: "Debtors & Creditors", ready: false },
];

function fmtDelta(minor: number | null | undefined) {
  if (minor == null) return "—";
  const sign = minor > 0 ? "+" : "";
  return `${sign}${formatMinor(minor)}`;
}

function fmtRatio(bps: number | null | undefined) {
  if (bps == null) return "—";
  return (bps / 10_000).toFixed(2);
}

function fmtRunway(r: CashRunway) {
  if (r.kind === "cash_positive") return "n/a — cash positive";
  return `${(r.monthsMilli / 1000).toFixed(1)} months`;
}

function MetricCard(props: {
  testId: string;
  title: string;
  value: string;
  change: string;
  formula: string;
}) {
  return (
    <div
      className="rounded-lg border border-border bg-card px-4 py-3"
      data-testid={props.testId}
      title={props.formula}
    >
      <div className="text-xs text-muted-foreground">{props.title}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{props.value}</div>
      <div className="mt-1 text-xs text-muted-foreground">vs prior: {props.change}</div>
    </div>
  );
}

export default function CompanyHealthPage() {
  const { periodId } = useBooksShell();
  const [tab, setTab] = useState<TabKey>("dashboard");
  const [data, setData] = useState<HealthSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!periodId) return;
    let cancelled = false;
    setError("");
    void fetch(`/api/books/health/summary?periodId=${encodeURIComponent(periodId)}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(apiErrorMessage(j) || "health_failed");
        return j as HealthSummary;
      })
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setData(null);
          setError(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [periodId]);

  return (
    <div className="space-y-4 pb-10" data-testid="health-page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Company Health</h1>
        <p className="text-sm text-muted-foreground">
          Ledger-backed metrics · AED fils · {data?.periodLabel || "select a period"}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-border pb-2 text-sm" data-testid="health-tabs">
        {TABS.map((t) =>
          t.ready ? (
            <button
              key={t.key}
              type="button"
              className={
                tab === t.key
                  ? "rounded-md bg-primary px-2 py-1 text-primary-foreground"
                  : "rounded-md bg-muted px-2 py-1 text-muted-foreground"
              }
              onClick={() => setTab(t.key)}
              data-testid={`health-tab-${t.key}`}
            >
              {t.label}
            </button>
          ) : (
            <span
              key={t.key}
              className="rounded-md px-2 py-1 text-muted-foreground/70"
              title="Available in a later Phase 7 slice"
              data-testid={`health-tab-${t.key}-soon`}
            >
              {t.label} · soon
            </span>
          ),
        )}
      </div>

      {error ? (
        <p className="text-sm text-destructive" data-testid="health-error">
          {error}
        </p>
      ) : null}

      {tab === "dashboard" ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              testId="health-metric-cash"
              title="Cash on hand"
              value={data ? formatMinor(data.cashOnHandMinor) : "…"}
              change={fmtDelta(data?.cashOnHandChange.deltaMinor)}
              formula={data?.formulas.cashOnHand || ""}
            />
            <MetricCard
              testId="health-metric-avg-cf"
              title="Avg net cash flow (3 mo)"
              value={data ? formatMinor(data.avgNetCashFlowMinor) : "…"}
              change={fmtDelta(data?.avgNetCashFlowChange.deltaMinor)}
              formula={data?.formulas.avgNetCashFlow || ""}
            />
            <MetricCard
              testId="health-metric-runway"
              title="Cash runway"
              value={data ? fmtRunway(data.runway) : "…"}
              change={
                data?.runway.kind === "months" && data.priorRunway?.kind === "months"
                  ? `${((data.runway.monthsMilli - data.priorRunway.monthsMilli) / 1000).toFixed(1)} mo`
                  : "—"
              }
              formula={data?.formulas.runway || ""}
            />
            <MetricCard
              testId="health-metric-la"
              title="Liabilities ÷ assets"
              value={fmtRatio(data?.liabilitiesAssetsRatioBps ?? null)}
              change={
                data?.liabilitiesAssetsRatioChange.deltaBps != null
                  ? `${(data.liabilitiesAssetsRatioChange.deltaBps / 10_000).toFixed(2)}`
                  : "—"
              }
              formula={data?.formulas.liabilitiesAssets || ""}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Hover a card for the formula. Deeper trackers live under{" "}
            <Link href="/books/reports/ageing?side=ar" className="underline-offset-2 hover:underline">
              ageing reports
            </Link>
            .
          </p>
        </div>
      ) : null}
    </div>
  );
}
