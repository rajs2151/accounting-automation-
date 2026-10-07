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

type PaymentBehaviour = {
  dsoDays: number | null;
  dpoDays: number | null;
  dioDays: number | null;
  cashConversionCycleDays: number | null;
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

type ArApTrackerRow = {
  partyName: string;
  ref: string;
  amountMinor: number;
  dueDate: string | null;
  overdueDays: number;
  status: string;
  avgPaymentDays: number | null;
  highlightOverdue: boolean;
};

type HealthDebtors = {
  arOutstandingMinor: number;
  apOutstandingMinor: number;
  arOverdueMinor: number;
  apOverdueMinor: number;
  arRows: ArApTrackerRow[];
  apRows: ArApTrackerRow[];
  paymentBehaviour: PaymentBehaviour;
};

type TabKey = "dashboard" | "scorecard" | "runway" | "profitability" | "debtors";

const TABS: Array<{ key: TabKey; label: string; ready: boolean }> = [
  { key: "dashboard", label: "Dashboard", ready: true },
  { key: "scorecard", label: "Company Scorecard", ready: false },
  { key: "runway", label: "Cash Flow & Runway", ready: false },
  { key: "profitability", label: "Profitability & Cost Trends", ready: false },
  { key: "debtors", label: "Debtors & Creditors", ready: true },
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

function fmtDayDelta(current: number | null, prior: number | null) {
  if (current == null || prior == null) return "—";
  const d = current - prior;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d} days`;
}

function fmtPctBps(bps: number | null) {
  if (bps == null) return "—";
  return `${(bps / 100).toFixed(1)}%`;
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

function TrackerTable(props: {
  testId: string;
  title: string;
  outstandingMinor: number;
  overdueMinor: number;
  rows: ArApTrackerRow[];
}) {
  return (
    <div className="space-y-2" data-testid={props.testId}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">{props.title}</h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          Outstanding {formatMinor(props.outstandingMinor)} · Overdue {formatMinor(props.overdueMinor)}
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Party</th>
              <th className="px-3 py-2 font-medium">Ref</th>
              <th className="px-3 py-2 font-medium text-right">Amount</th>
              <th className="px-3 py-2 font-medium">Due</th>
              <th className="px-3 py-2 font-medium text-right">Days</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Avg pay</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-muted-foreground">
                  No open items as of this period.
                </td>
              </tr>
            ) : (
              props.rows.map((r) => (
                <tr
                  key={`${r.ref}-${r.partyName}-${r.amountMinor}`}
                  className={r.highlightOverdue ? "bg-destructive/5" : undefined}
                >
                  <td className="px-3 py-2">{r.partyName}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.ref}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMinor(r.amountMinor)}</td>
                  <td className="px-3 py-2 tabular-nums">{r.dueDate ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.overdueDays}</td>
                  <td className="px-3 py-2 capitalize">{r.status}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.avgPaymentDays != null ? `${r.avgPaymentDays}d` : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function CompanyHealthPage() {
  const { periodId } = useBooksShell();
  const [tab, setTab] = useState<TabKey>("dashboard");
  const [data, setData] = useState<HealthSummary | null>(null);
  const [debtors, setDebtors] = useState<HealthDebtors | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!periodId) return;
    let cancelled = false;
    setError("");
    const summaryP = fetch(`/api/books/health/summary?periodId=${encodeURIComponent(periodId)}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(j) || "health_failed");
      return j as HealthSummary;
    });
    const debtorsP = fetch(`/api/books/health/debtors?periodId=${encodeURIComponent(periodId)}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(j) || "health_debtors_failed");
      return j as HealthDebtors;
    });
    void Promise.all([summaryP, debtorsP])
      .then(([s, d]) => {
        if (!cancelled) {
          setData(s);
          setDebtors(d);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setData(null);
          setDebtors(null);
          setError(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [periodId]);

  const pb = debtors?.paymentBehaviour;

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

          <div
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5"
            data-testid="health-payment-behaviour"
          >
            <MetricCard
              testId="health-metric-dso"
              title="DSO"
              value={pb?.dsoDays != null ? `${pb.dsoDays} days` : "—"}
              change={fmtDayDelta(pb?.dsoDays ?? null, pb?.prior.dsoDays ?? null)}
              formula={pb?.formulas.dso || ""}
            />
            <MetricCard
              testId="health-metric-dpo"
              title="DPO"
              value={pb?.dpoDays != null ? `${pb.dpoDays} days` : "—"}
              change={fmtDayDelta(pb?.dpoDays ?? null, pb?.prior.dpoDays ?? null)}
              formula={pb?.formulas.dpo || ""}
            />
            <MetricCard
              testId="health-metric-dio"
              title="DIO"
              value={pb?.dioDays != null ? `${pb.dioDays} days` : "—"}
              change={fmtDayDelta(pb?.dioDays ?? null, pb?.prior.dioDays ?? null)}
              formula={pb?.formulas.dio || ""}
            />
            <MetricCard
              testId="health-metric-ccc"
              title="Cash conversion cycle"
              value={pb?.cashConversionCycleDays != null ? `${pb.cashConversionCycleDays} days` : "—"}
              change={
                pb?.cashConversionCycleDays != null && pb.prior.cashConversionCycleDays != null
                  ? `${pb.cashConversionCycleDays - pb.prior.cashConversionCycleDays} vs prior`
                  : "—"
              }
              formula={pb?.formulas.ccc || ""}
            />
            <MetricCard
              testId="health-metric-collection"
              title="Collection rate"
              value={fmtPctBps(pb?.collectionRateBps ?? null)}
              change={
                pb?.collectionRateBps != null && pb.prior.collectionRateBps != null
                  ? `${((pb.collectionRateBps - pb.prior.collectionRateBps) / 100).toFixed(1)} pp`
                  : "—"
              }
              formula={pb?.formulas.collectionRate || ""}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Hover a card for the formula. Open{" "}
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => setTab("debtors")}>
              Debtors &amp; Creditors
            </button>{" "}
            for line detail, or{" "}
            <Link href="/books/reports/ageing?side=ar" className="underline-offset-2 hover:underline">
              ageing reports
            </Link>
            .
          </p>
        </div>
      ) : null}

      {tab === "debtors" ? (
        <div className="space-y-6" data-testid="health-debtors-panel">
          <TrackerTable
            testId="health-ar-tracker"
            title="Receivables"
            outstandingMinor={debtors?.arOutstandingMinor ?? 0}
            overdueMinor={debtors?.arOverdueMinor ?? 0}
            rows={debtors?.arRows ?? []}
          />
          <TrackerTable
            testId="health-ap-tracker"
            title="Payables"
            outstandingMinor={debtors?.apOutstandingMinor ?? 0}
            overdueMinor={debtors?.apOverdueMinor ?? 0}
            rows={debtors?.apRows ?? []}
          />
        </div>
      ) : null}
    </div>
  );
}
