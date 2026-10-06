"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useBooksShell } from "@/components/books/books-shell-context";
import {
  ReportsNav,
  ReportTable,
  trailParam,
  useReportMeta,
  type ReportColumn,
} from "@/components/books/report-table";
import { tbToReportTree, type ReportRow, type TbLike } from "@/lib/report-table";

type TbResponse = TbLike & { periodLabel: string; balanced: boolean };
type View = "period" | "monthly" | "compare";

const net = (v: Record<string, number>) => (v.closingDebit ?? 0) - (v.closingCredit ?? 0);

/** Re-key a TB tree to one net-closing column (debit positive, credit negative → brackets). */
function netTree(rows: ReportRow[], key: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of rows) {
    out.set(g.id, net(g.values));
    for (const c of g.children || []) out.set(c.id, net(c.values));
  }
  out.set("__total", rows.reduce((s, g) => s + net(g.values), 0));
  void key;
  return out;
}

export default function TrialBalancePage() {
  const { periods, periodId, setPeriodId } = useBooksShell();
  const router = useRouter();
  const meta = useReportMeta();
  const [view, setView] = useState<View>("period");
  const [showMovements, setShowMovements] = useState(false);
  const [hideZero, setHideZero] = useState(true);
  const [tbs, setTbs] = useState<Record<string, TbResponse>>({});
  const [error, setError] = useState("");

  // Chronological order (the shell list is newest-first): previous / monthly columns follow dates.
  const [ordered, setOrdered] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => {
    void fetch("/api/books/periods")
      .then((r) => r.json())
      .then((list: Array<{ id: string; label: string; periodStart: string }>) => {
        if (Array.isArray(list)) {
          setOrdered(
            [...list].sort((a, b) => String(a.periodStart).localeCompare(String(b.periodStart))),
          );
        }
      })
      .catch(() => undefined);
  }, []);
  const idx = ordered.findIndex((p) => p.id === periodId);
  const prev = idx > 0 ? ordered[idx - 1] : null;
  // Periods loaded for the current view (monthly = every month up to the selected one).
  const needed = useMemo(() => {
    if (!periodId) return [] as string[];
    if (view === "monthly") return idx >= 0 ? ordered.slice(0, idx + 1).map((p) => p.id) : [periodId];
    if (view === "compare" && prev) return [prev.id, periodId];
    return [periodId];
  }, [periodId, ordered, idx, prev, view]);

  useEffect(() => {
    let cancelled = false;
    setError("");
    void Promise.all(
      needed.map(async (pid) => {
        const qs = new URLSearchParams({ periodId: pid });
        if (!hideZero) qs.set("includeZero", "1");
        const res = await fetch(`/api/books/trial-balance?${qs}`);
        const json = await res.json();
        if (!res.ok) throw new Error(String(json.error || "tb_failed"));
        return [pid, json as TbResponse] as const;
      }),
    )
      .then((pairs) => {
        if (!cancelled) setTbs(Object.fromEntries(pairs));
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [needed, hideZero]);

  const current = tbs[periodId];
  const base = useMemo(() => (current ? tbToReportTree(current) : null), [current]);

  const { columns, rows, footer, difference } = useMemo(() => {
    if (!base || !current) return { columns: [] as ReportColumn[], rows: [] as ReportRow[], footer: [], difference: null };
    if (view === "period") {
      const cols: ReportColumn[] = [
        ...(showMovements
          ? [
              { key: "openingDebit", label: "Opening Dr" },
              { key: "openingCredit", label: "Opening Cr" },
              { key: "periodDebit", label: "Debits" },
              { key: "periodCredit", label: "Credits" },
            ]
          : []),
        { key: "closingDebit", label: "Closing Dr" },
        { key: "closingCredit", label: "Closing Cr" },
      ];
      // Phase-0 note on 2210 for the Desert Falcon demo company (kept from the old TB page).
      const vatNote = meta.company.includes("Desert Falcon");
      return {
        columns: cols,
        rows: base.rows.map((g) => ({
          ...g,
          children: g.children?.map((c) =>
            c.code === "2210"
              ? {
                  ...c,
                  testId: "tb-vat-note",
                  title: vatNote ? "VAT output movements. Use Show movements for Dr/Cr sides." : undefined,
                }
              : c,
          ),
        })),
        footer: [
          {
            id: "grand",
            label: `Grand total · ${current.balanced ? "Balanced" : "Unbalanced"}`,
            values: base.totals,
            testId: "tb-totals",
          },
        ],
        difference: { debitKey: "closingDebit", creditKey: "closingCredit", totals: base.totals },
      };
    }
    // Monthly / Compare: net closing per column (Dr positive, Cr in brackets). Rows come from the
    // selected period's tree; an account missing in an earlier month shows blank (zero).
    const keys = view === "monthly" ? needed : prev ? [prev.id, periodId] : [periodId];
    const nets = Object.fromEntries(
      keys.filter((k) => tbs[k]).map((k) => [k, netTree(tbToReportTree(tbs[k]).rows, k)]),
    );
    const label = (pid: string) => ordered.find((p) => p.id === pid)?.label || pid;
    const cols: ReportColumn[] = keys.map((k) => ({ key: k, label: label(k) }));
    if (view === "compare" && prev) cols.push({ key: "diff", label: "Difference" });
    const valuesFor = (id: string) => {
      const v: Record<string, number> = {};
      for (const k of keys) v[k] = nets[k]?.get(id) ?? 0;
      if (view === "compare" && prev) v.diff = (v[periodId] ?? 0) - (v[prev.id] ?? 0);
      return v;
    };
    const mapRows = (rs: ReportRow[]): ReportRow[] =>
      rs.map((r) => ({ ...r, values: valuesFor(r.id), children: r.children ? mapRows(r.children) : undefined }));
    return {
      columns: cols,
      rows: mapRows(base.rows),
      footer: [{ id: "grand", label: "Grand total (net)", values: valuesFor("__total"), testId: "tb-totals-net" }],
      difference: null,
    };
  }, [base, current, view, showMovements, needed, prev, periodId, ordered, tbs, meta.company]);

  return (
    <div className="space-y-4 pb-10">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trial balance</h1>
          <p className="text-sm text-muted-foreground">
            Net closing balances from posted journal lines{current?.periodLabel ? ` · ${current.periodLabel}` : ""}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="text-xs text-muted-foreground">
            View
            <select
              className="ms-2 rounded-md border border-border bg-card px-2 py-1 text-sm"
              value={view}
              onChange={(e) => setView(e.target.value as View)}
              data-testid="tb-view"
            >
              <option value="period">Period</option>
              <option value="monthly">Monthly</option>
              <option value="compare">Compare with previous</option>
            </select>
          </label>
          {view === "period" ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showMovements} onChange={(e) => setShowMovements(e.target.checked)} />
              Show movements
            </label>
          ) : null}
          <label className="flex items-center gap-2" data-testid="tb-hide-zero">
            <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
            Hide zero balances
          </label>
          <label className="text-xs text-muted-foreground">
            Period
            <select
              className="ms-2 rounded-md border border-border bg-card px-2 py-1 text-sm"
              value={periodId}
              onChange={(e) => setPeriodId(e.target.value)}
              data-testid="tb-period"
            >
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <ReportsNav active="tb" />

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {view === "compare" && !prev ? (
        <p className="text-sm text-muted-foreground">No earlier period to compare with.</p>
      ) : null}

      <ReportTable
        testId="tb-report"
        stateKey={`tb:${periodId}:${view}`}
        title="Trial balance"
        company={meta.company}
        preparedBy={meta.preparedBy}
        periodLabel={current?.periodLabel || ""}
        labelHeader="Account"
        columns={columns}
        rows={rows}
        footer={footer}
        difference={difference}
        brackets={view !== "period"}
        exportName={`trial-balance-${current?.periodLabel || "period"}`.replace(/\s+/g, "-")}
        onDrill={(r) => {
          const d = r.drill as { kind: string; accountId?: string } | undefined;
          if (d?.kind !== "account" || !d.accountId) return;
          const here = `/books/reports/trial-balance`;
          router.push(
            `/books/reports/account-ledger?periodId=${periodId}&accountId=${d.accountId}&trail=${trailParam([
              { label: "Trial balance", href: here },
            ])}`,
          );
        }}
      />
    </div>
  );
}
