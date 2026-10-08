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

type HealthInsight = {
  id: string;
  severity: string;
  title: string;
  body: string;
  actions: Array<{ label: string; href: string }>;
};

type HealthPanel = {
  scorecard: {
    periodStatus: string;
    closeReady: boolean;
    failingGateCount: number;
    failingGates: Array<{ key: string; label: string }>;
    tbBalanced: boolean;
    tbDifferenceMinor: number;
    arOverdueMinor: number;
    apOverdueMinor: number;
    arControlMinor: number;
    arOpenMinor: number;
    arControlDriftMinor: number;
    apControlMinor: number;
    apOpenMinor: number;
    apControlDriftMinor: number;
    documentsToReview: number;
    bankNeedsReview: number;
    cashOnHandMinor: number;
    runway: CashRunway;
    dsoDays: number | null;
    liabilitiesAssetsRatioBps: number | null;
  };
  trends: {
    cashSeries: Array<{
      label: string;
      closingCashMinor: number;
      netChangeMinor: number;
      runway: CashRunway;
    }>;
    pnlSeries: Array<{
      label: string;
      revenueMinor: number;
      opexMinor: number;
      grossMarginBps: number | null;
      netProfitMinor: number;
    }>;
    topCostMovers: Array<{
      code: string;
      name: string;
      currentMinor: number;
      priorMinor: number;
      momPct: number | null;
    }>;
  };
  insights: HealthInsight[];
};

type TabKey = "dashboard" | "scorecard" | "runway" | "profitability" | "debtors";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "dashboard", label: "Dashboard" },
  { key: "scorecard", label: "Company Scorecard" },
  { key: "runway", label: "Cash Flow & Runway" },
  { key: "profitability", label: "Profitability & Cost Trends" },
  { key: "debtors", label: "Debtors & Creditors" },
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

function SimpleBars(props: {
  testId: string;
  points: Array<{ label: string; value: number }>;
}) {
  const max = Math.max(1, ...props.points.map((p) => Math.abs(p.value)));
  return (
    <div className="flex items-end gap-2 rounded-lg border border-border bg-card p-3" data-testid={props.testId}>
      {props.points.map((p) => {
        const h = Math.max(4, Math.round((Math.abs(p.value) / max) * 96));
        return (
          <div key={p.label} className="flex flex-1 flex-col items-center gap-1">
            <div
              className={`w-full max-w-10 rounded-sm ${p.value < 0 ? "bg-destructive/70" : "bg-primary/80"}`}
              style={{ height: h }}
              title={formatMinor(p.value)}
            />
            <div className="truncate text-[10px] text-muted-foreground">{p.label}</div>
          </div>
        );
      })}
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
  const [panel, setPanel] = useState<HealthPanel | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!periodId) return;
    let cancelled = false;
    setError("");
    const q = encodeURIComponent(periodId);
    const summaryP = fetch(`/api/books/health/summary?periodId=${q}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(j) || "health_failed");
      return j as HealthSummary;
    });
    const debtorsP = fetch(`/api/books/health/debtors?periodId=${q}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(j) || "health_debtors_failed");
      return j as HealthDebtors;
    });
    const panelP = fetch(`/api/books/health/panel?periodId=${q}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(j) || "health_panel_failed");
      return j as HealthPanel;
    });
    void Promise.all([summaryP, debtorsP, panelP])
      .then(([s, d, p]) => {
        if (!cancelled) {
          setData(s);
          setDebtors(d);
          setPanel(p);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setData(null);
          setDebtors(null);
          setPanel(null);
          setError(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [periodId]);

  const pb = debtors?.paymentBehaviour;
  const sc = panel?.scorecard;

  return (
    <div className="space-y-4 pb-10" data-testid="health-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Company Health</h1>
          <p className="text-sm text-muted-foreground">
            Ledger-backed metrics · AED fils · {data?.periodLabel || "select a period"}
          </p>
        </div>
        <Link
          href="/books/firm"
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          data-testid="health-firm-link"
        >
          Firm board
        </Link>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-border pb-2 text-sm" data-testid="health-tabs">
        {TABS.map((t) => (
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
        ))}
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

          {panel?.insights?.length ? (
            <div className="space-y-2" data-testid="health-insights">
              <h2 className="text-sm font-medium">Insights</h2>
              <div className="grid gap-2 md:grid-cols-2">
                {panel.insights.map((ins) => (
                  <div
                    key={ins.id}
                    className="rounded-lg border border-border bg-card px-3 py-2"
                    data-testid={`health-insight-${ins.id}`}
                  >
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">{ins.severity}</div>
                    <div className="mt-0.5 font-medium">{ins.title}</div>
                    <p className="mt-1 text-sm text-muted-foreground">{ins.body}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {ins.actions.map((a) => (
                        <Link
                          key={a.href + a.label}
                          href={a.href}
                          className="rounded-md bg-muted px-2 py-0.5 text-xs underline-offset-2 hover:underline"
                        >
                          {a.label}
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

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

      {tab === "scorecard" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="health-scorecard">
          <MetricCard
            testId="health-sc-close"
            title="Close ready"
            value={sc ? (sc.closeReady ? "Yes" : `No (${sc.failingGateCount} gates)`) : "…"}
            change={sc?.failingGates.map((g) => g.label).slice(0, 2).join("; ") || "—"}
            formula="From the month-end close checklist (blocking gates)"
          />
          <MetricCard
            testId="health-sc-tb"
            title="Trial balance"
            value={sc ? (sc.tbBalanced ? "Balanced" : `Out by ${formatMinor(sc.tbDifferenceMinor)}`) : "…"}
            change={sc?.periodStatus || "—"}
            formula="Sum of closing debits vs credits on the trial balance"
          />
          <MetricCard
            testId="health-sc-ar-control"
            title="AR control vs open items"
            value={
              sc
                ? sc.arControlDriftMinor === 0
                  ? "Balanced"
                  : `Out by ${formatMinor(Math.abs(sc.arControlDriftMinor))}`
                : "…"
            }
            change={
              sc
                ? `Control ${formatMinor(sc.arControlMinor)} · open ${formatMinor(sc.arOpenMinor)}`
                : "—"
            }
            formula="TB 1210 closing (Dr−Cr) minus AR ageing open total"
          />
          <MetricCard
            testId="health-sc-ap-control"
            title="AP control vs open items"
            value={
              sc
                ? sc.apControlDriftMinor === 0
                  ? "Balanced"
                  : `Out by ${formatMinor(Math.abs(sc.apControlDriftMinor))}`
                : "…"
            }
            change={
              sc
                ? `Control ${formatMinor(sc.apControlMinor)} · open ${formatMinor(sc.apOpenMinor)}`
                : "—"
            }
            formula="TB 2110 closing (Cr−Dr) minus AP ageing open total"
          />
          <MetricCard
            testId="health-sc-ar"
            title="AR overdue"
            value={sc ? formatMinor(sc.arOverdueMinor) : "…"}
            change={sc ? `AP overdue ${formatMinor(sc.apOverdueMinor)}` : "—"}
            formula="Open items past due as of period end (ageing)"
          />
          <MetricCard
            testId="health-sc-review"
            title="To review"
            value={sc ? `${sc.documentsToReview} docs` : "…"}
            change={sc ? `${sc.bankNeedsReview} bank lines need review` : "—"}
            formula="Draft documents + bank lines still in needs_review"
          />
          <MetricCard
            testId="health-sc-cash"
            title="Cash / runway"
            value={sc ? formatMinor(sc.cashOnHandMinor) : "…"}
            change={sc ? fmtRunway(sc.runway) : "—"}
            formula="Same cash and runway formulas as the Dashboard"
          />
          <MetricCard
            testId="health-sc-dso"
            title="DSO / leverage"
            value={sc?.dsoDays != null ? `${sc.dsoDays} days` : "—"}
            change={fmtRatio(sc?.liabilitiesAssetsRatioBps ?? null)}
            formula="DSO from payment behaviour; L÷A from the balance sheet"
          />
        </div>
      ) : null}

      {tab === "runway" ? (
        <div className="space-y-3" data-testid="health-runway-panel">
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Month</th>
                  <th className="px-3 py-2 text-right">Closing cash</th>
                  <th className="px-3 py-2 text-right">Net change</th>
                  <th className="px-3 py-2 text-right">Runway</th>
                </tr>
              </thead>
              <tbody>
                {(panel?.trends.cashSeries ?? []).map((r) => (
                  <tr key={r.label} className="border-t border-border">
                    <td className="px-3 py-2">{r.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMinor(r.closingCashMinor)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMinor(r.netChangeMinor)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtRunway(r.runway)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SimpleBars
            testId="health-cash-bars"
            points={(panel?.trends.cashSeries ?? []).map((r) => ({
              label: r.label,
              value: r.closingCashMinor,
            }))}
          />
        </div>
      ) : null}

      {tab === "profitability" ? (
        <div className="space-y-4" data-testid="health-profitability-panel">
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Month</th>
                  <th className="px-3 py-2 text-right">Revenue</th>
                  <th className="px-3 py-2 text-right">Gross margin</th>
                  <th className="px-3 py-2 text-right">Opex</th>
                  <th className="px-3 py-2 text-right">Net profit</th>
                </tr>
              </thead>
              <tbody>
                {(panel?.trends.pnlSeries ?? []).map((r) => (
                  <tr key={r.label} className="border-t border-border">
                    <td className="px-3 py-2">{r.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMinor(r.revenueMinor)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.grossMarginBps != null ? `${(r.grossMarginBps / 100).toFixed(1)}%` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMinor(r.opexMinor)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMinor(r.netProfitMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium">Top cost movers (MoM)</h2>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[480px] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2 text-right">This month</th>
                    <th className="px-3 py-2 text-right">Prior</th>
                    <th className="px-3 py-2 text-right">MoM</th>
                  </tr>
                </thead>
                <tbody>
                  {(panel?.trends.topCostMovers ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-3 text-muted-foreground">
                        No rising opex categories versus the prior month.
                      </td>
                    </tr>
                  ) : (
                    panel!.trends.topCostMovers.map((m) => (
                      <tr key={m.code} className="border-t border-border">
                        <td className="px-3 py-2">
                          <span className="font-mono text-xs">{m.code}</span> {m.name}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMinor(m.currentMinor)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMinor(m.priorMinor)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {m.momPct != null ? `${m.momPct > 0 ? "+" : ""}${m.momPct.toFixed(0)}%` : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "debtors" ? (
        <div className="space-y-6" data-testid="health-debtors-panel">
          {sc && (sc.arControlDriftMinor !== 0 || sc.apControlDriftMinor !== 0) ? (
            <div
              className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
              data-testid="health-control-drift-banner"
            >
              <div className="font-medium">Control vs open items drift</div>
              <p className="mt-1 text-muted-foreground">
                {sc.arControlDriftMinor !== 0
                  ? `AR out by ${formatMinor(Math.abs(sc.arControlDriftMinor))}. `
                  : null}
                {sc.apControlDriftMinor !== 0
                  ? `AP out by ${formatMinor(Math.abs(sc.apControlDriftMinor))}. `
                  : null}
                Check the{" "}
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => setTab("scorecard")}
                >
                  scorecard
                </button>{" "}
                or{" "}
                <Link href="/books/reports/ageing?side=ar" className="underline-offset-2 hover:underline">
                  ageing
                </Link>
                .
              </p>
            </div>
          ) : null}
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
