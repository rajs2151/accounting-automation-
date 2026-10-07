"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useBooksShell } from "@/components/books/books-shell-context";
import { FsMetricChart } from "@/components/books/fs-metric-chart";
import {
  ReportsNav,
  ReportTable,
  useReportMeta,
  type ReportRow,
} from "@/components/books/report-table";
import { BooksSideDrawer } from "@/components/books/side-drawer";
import { MfaDownloadModal } from "@/components/security-banner";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
import {
  bsToReportTree,
  cfToReportTree,
  fiscalRangeForPeriod,
  pnlToReportTree,
  type BsColumnLike,
  type CfColumnLike,
  type PnlColumnLike,
} from "@/lib/fs-report-tree";
import { buildProjectedPnlColumn } from "@/lib/fs-projection";
import { formatMinor } from "@/lib/money";

type CtBanner = {
  taxYearLabel: string;
  filingDue: string;
  taxableIncomeMinor: number;
  estimateMinor: number;
  revenueMinor?: number;
  smallBusinessReliefMayApply?: boolean;
  disclaimer: string;
};

type CommentBadge = {
  accountId: string;
  threadId: string;
  messageCount: number;
  unreadCount: number;
};

type CommentMsg = {
  id: string;
  body: string;
  createdAt: string;
  authorName: string;
};

type ForecastRow = {
  accountId: string;
  periodId: string;
  amountMinor: number;
  periodLabel: string;
};

type Mode = "monthly" | "quarterly" | "yearly" | "range";
type Statement = "pnl" | "bs" | "cf";

type PeriodRow = {
  id: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  status: string;
};

type Integrity = {
  tbBalances: { ok: boolean; differenceMinor: number };
  bsBalances: { ok: boolean; differenceMinor: number };
  cfTies: { ok: boolean; differenceMinor: number };
  ready: boolean;
};

type DrillState = {
  accountId: string;
  code: string;
  name: string;
  from: string;
  to: string;
  columnKey: string;
  periodLabel: string;
};

type LineRow = {
  entryId: string;
  entryNo: string | null;
  date: string;
  memo: string;
  amountMinor: number;
};

type AcctOpt = {
  id: string;
  code: string;
  name: string;
  accountType?: string | null;
  statementLine?: string | null;
  subType?: string | null;
};

export function FsReportView({ statement }: { statement: Statement }) {
  const { periodId, setPeriodId } = useBooksShell();
  const meta = useReportMeta();
  const [periods, setPeriods] = useState<PeriodRow[]>([]);
  const [mode, setMode] = useState<Mode>("monthly");
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [asOfToday, setAsOfToday] = useState(false);
  const [showPrior, setShowPrior] = useState(false);
  const [error, setError] = useState("");
  const [pnl, setPnl] = useState<PnlColumnLike[] | null>(null);
  const [bs, setBs] = useState<BsColumnLike[] | null>(null);
  const [cf, setCf] = useState<CfColumnLike[] | null>(null);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [drill, setDrill] = useState<DrillState | null>(null);
  const [lines, setLines] = useState<LineRow[]>([]);
  /** Drill presentation: sign of the statement, BS opening balance and the drill total. */
  const [drillMeta, setDrillMeta] = useState<{
    statement: "pnl" | "bs";
    sign: number;
    openingMinor: number;
    totalMinor: number;
  } | null>(null);
  const [drillError, setDrillError] = useState("");
  const [lineSearch, setLineSearch] = useState("");
  const [accounts, setAccounts] = useState<AcctOpt[]>([]);
  const [reclassTo, setReclassTo] = useState("");
  const [reclassMsg, setReclassMsg] = useState("");
  const [exportMsg, setExportMsg] = useState("");
  // Statement downloads need a fresh MFA check; the pending format is retried once verified.
  const [mfaFormat, setMfaFormat] = useState<"xlsx" | "pdf" | null>(null);
  const [exporting, setExporting] = useState(false);
  const [ctBanner, setCtBanner] = useState<CtBanner | null>(null);
  const [commentBadges, setCommentBadges] = useState<CommentBadge[]>([]);
  const [commentOpen, setCommentOpen] = useState<{
    accountId: string;
    code: string;
    name: string;
    threadId?: string;
  } | null>(null);
  const [commentMsgs, setCommentMsgs] = useState<CommentMsg[]>([]);
  const [commentText, setCommentText] = useState("");
  const [commentErr, setCommentErr] = useState("");
  const [mentionUsers, setMentionUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [projectionsOn, setProjectionsOn] = useState(false);
  const [forecasts, setForecasts] = useState<ForecastRow[]>([]);
  const [periodsLoaded, setPeriodsLoaded] = useState(false);
  const [fyStartMonth, setFyStartMonth] = useState(1);

  useEffect(() => {
    void fetch("/api/books/periods")
      .then((r) => r.json())
      .then((list: PeriodRow[]) => {
        if (!Array.isArray(list)) return;
        const ordered = [...list].sort((a, b) =>
          String(a.periodStart).localeCompare(String(b.periodStart)),
        );
        setPeriods(ordered);
      })
      .catch(() => undefined)
      .finally(() => setPeriodsLoaded(true));
  }, []);

  // Fiscal calendar for quarterly / yearly ranges (company fiscal_year_start_month).
  useEffect(() => {
    void fetch("/api/books/company")
      .then((r) => r.json())
      .then((c: { fiscalYearStartMonth?: number } | null) => {
        const m = Number(c?.fiscalYearStartMonth);
        if (Number.isInteger(m) && m >= 1 && m <= 12) setFyStartMonth(m);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetch("/api/books/accounts?postableOnly=1")
      .then((r) => r.json())
      .then((list: AcctOpt[]) => {
        if (Array.isArray(list)) setAccounts(list);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (statement !== "pnl") return;
    void fetch("/api/books/users")
      .then((r) => r.json())
      .then((list: Array<{ id: string; name: string }>) => {
        if (Array.isArray(list)) setMentionUsers(list);
      })
      .catch(() => undefined);
  }, [statement]);

  const selected = periods.find((p) => p.id === periodId) || null;

  const query = useMemo(() => {
    if (mode === "range") {
      if (!rangeFrom || !rangeTo) return null;
      return { from: rangeFrom, to: rangeTo };
    }
    if (!selected) return null;
    if (mode === "monthly") {
      let from = selected.periodStart;
      if (showPrior) {
        const idx = periods.findIndex((p) => p.id === selected.id);
        if (idx > 0) from = periods[idx - 1].periodStart;
      }
      return { from, to: selected.periodEnd };
    }
    // Quarterly / yearly: the fiscal quarter / fiscal year (company calendar) containing the period.
    return fiscalRangeForPeriod(mode, selected.periodStart, fyStartMonth);
  }, [mode, selected, periods, showPrior, rangeFrom, rangeTo, fyStartMonth]);

  const asOf = asOfToday ? new Date().toISOString().slice(0, 10) : "2099-12-31";

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    setError("");
    const qs = new URLSearchParams({
      mode,
      from: query.from,
      to: query.to,
      asOf,
    });
    void Promise.all([
      fetch(`/api/books/reports/financial-statements?${qs}`).then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(apiErrorMessage(j) || "fs_failed");
        return j;
      }),
      statement === "pnl"
        ? fetch(`/api/books/reports/ct-estimate?asOf=${encodeURIComponent(query.to)}`).then((r) =>
            r.json(),
          )
        : Promise.resolve(null),
      statement === "pnl" && periodId
        ? fetch(`/api/books/comments/badges?periodId=${encodeURIComponent(periodId)}`).then((r) =>
            r.json(),
          )
        : Promise.resolve([]),
      statement === "pnl"
        ? fetch("/api/books/forecasts").then((r) => r.json())
        : Promise.resolve([]),
    ])
      .then(([pack, ct, badges, fc]) => {
        if (cancelled) return;
        setPnl(pack.pnl?.columns || []);
        setBs(pack.balanceSheet?.columns || []);
        setCf(pack.cashFlow?.columns || []);
        setIntegrity(pack.integrity || null);
        if (ct && !ct.error) setCtBanner(ct);
        else setCtBanner(null);
        setCommentBadges(Array.isArray(badges) ? badges : []);
        setForecasts(Array.isArray(fc) ? fc : []);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [query, mode, asOf, statement, periodId]);

  const projectedPnl = useMemo(() => {
    if (!pnl || !projectionsOn || statement !== "pnl" || !selected) return pnl;
    const selectedEnd = selected.periodEnd;
    const future = periods
      .filter((p) => p.periodStart > selectedEnd)
      .slice(0, 3);
    if (!future.length) return pnl;
    const byPeriod = new Map<string, ForecastRow[]>();
    for (const f of forecasts) {
      const list = byPeriod.get(f.periodId) || [];
      list.push(f);
      byPeriod.set(f.periodId, list);
    }
    const extra: Array<PnlColumnLike & { projected?: boolean }> = future.map((p) => ({
      column: { key: `proj:${p.id}`, label: p.label, from: p.periodStart, to: p.periodEnd },
      // Same sections and subtotals as the real P&L (a forecast rent line is an expense, not revenue).
      ...buildProjectedPnlColumn(byPeriod.get(p.id) || [], accounts),
      projected: true,
    }));
    return [...pnl, ...extra];
  }, [pnl, projectionsOn, statement, selected, periods, forecasts, accounts]);

  const tree = useMemo(() => {
    if (statement === "pnl" && projectedPnl) {
      const base = pnlToReportTree(projectedPnl);
      const badgeByAcct = new Map(commentBadges.map((b) => [b.accountId, b]));
      const stamp = (rows: ReportRow[]): ReportRow[] =>
        rows.map((r) => {
          const drill = r.drill as { kind?: string; accountId?: string } | undefined;
          const badge =
            drill?.kind === "account" && drill.accountId
              ? badgeByAcct.get(drill.accountId)
              : undefined;
          return {
            ...r,
            commentBadge: badge
              ? {
                  messageCount: badge.messageCount,
                  unreadCount: badge.unreadCount,
                  threadId: badge.threadId,
                }
              : undefined,
            children: r.children ? stamp(r.children) : undefined,
          };
        });
      return {
        ...base,
        columns: base.columns.map((c, i) => ({
          ...c,
          projected: Boolean((projectedPnl[i] as { projected?: boolean } | undefined)?.projected),
        })),
        rows: stamp(base.rows),
      };
    }
    if (statement === "bs" && bs) return bsToReportTree(bs);
    if (statement === "cf" && cf) return cfToReportTree(cf);
    return { columns: [], rows: [] as ReportRow[], footer: [] };
  }, [statement, projectedPnl, bs, cf, commentBadges]);

  const columnMeta = useMemo(() => {
    const cols =
      statement === "pnl" ? pnl : statement === "bs" ? bs : cf;
    return new Map((cols || []).map((c) => [c.column.key, c.column]));
  }, [statement, pnl, bs, cf]);

  const openDrill = useCallback(
    (row: ReportRow, columnKey: string) => {
      const d = row.drill as { kind?: string; accountId?: string; code?: string; name?: string } | undefined;
      if (!d || d.kind !== "account" || !d.accountId) return;
      const col = columnMeta.get(columnKey);
      if (!col) return;
      setDrill({
        accountId: d.accountId,
        code: d.code || "",
        name: d.name || row.label,
        from: col.from,
        to: col.to,
        columnKey,
        periodLabel: col.label,
      });
      setLineSearch("");
      setReclassTo("");
      setReclassMsg("");
    },
    [columnMeta],
  );

  useEffect(() => {
    if (!drill) {
      setLines([]);
      setDrillMeta(null);
      setDrillError("");
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams({
      accountId: drill.accountId,
      from: drill.from,
      to: drill.to,
    });
    void fetch(`/api/books/reports/account-lines?${qs}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.error) {
          setLines([]);
          setDrillMeta(null);
          setDrillError(apiErrorMessage(j));
          return;
        }
        setDrillError("");
        setLines(j.lines || []);
        setDrillMeta({
          statement: j.statement === "bs" ? "bs" : "pnl",
          sign: Number(j.sign) === -1 ? -1 : 1,
          openingMinor: Number(j.openingMinor || 0),
          totalMinor: Number(j.totalMinor || 0),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setLines([]);
          setDrillMeta(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [drill]);

  const filteredLines = useMemo(() => {
    const q = lineSearch.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter(
      (l) =>
        l.memo.toLowerCase().includes(q) ||
        (l.entryNo || "").toLowerCase().includes(q) ||
        l.date.includes(q),
    );
  }, [lines, lineSearch]);

  async function submitReclass(line: LineRow) {
    if (!drill || !reclassTo) return;
    setReclassMsg("");
    const amount = Math.abs(line.amountMinor);
    if (amount <= 0) {
      setReclassMsg("nothing_to_reclass");
      return;
    }
    const res = await fetch("/api/books/journals/reclass-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // The server books into the period containing the line's date; this is only a fallback.
        periodId: selected?.id,
        entryDate: line.date,
        fromAccountId: drill.accountId,
        toAccountId: reclassTo,
        amountMinor: amount,
        sourceEntryId: line.entryId,
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      setReclassMsg(apiErrorMessage(j) || String(j.error || "reclass_failed"));
      return;
    }
    setReclassMsg(`Draft ${j.reference || j.id?.slice?.(0, 8) || "created"} — send to approver to post.`);
  }

  function jumpToday() {
    const today = new Date().toISOString().slice(0, 10);
    setAsOfToday(true);
    const hit =
      periods.find((p) => p.periodStart <= today && p.periodEnd >= today) ||
      periods[periods.length - 1];
    if (hit) setPeriodId(hit.id);
  }

  async function openComments(row: ReportRow) {
    const d = row.drill as { kind?: string; accountId?: string; code?: string; name?: string } | undefined;
    if (!d?.accountId || d.kind !== "account") return;
    const badge = commentBadges.find((b) => b.accountId === d.accountId);
    setCommentOpen({
      accountId: d.accountId,
      code: d.code || row.code || "",
      name: d.name || row.label,
      threadId: badge?.threadId,
    });
    setCommentText("");
    setCommentErr("");
    setCommentMsgs([]);
    if (badge?.threadId) {
      const res = await fetch(`/api/books/comments/threads/${badge.threadId}`);
      const j = await res.json();
      if (res.ok) setCommentMsgs(j.messages || []);
    }
  }

  async function submitComment() {
    if (!commentOpen || !periodId || !commentText.trim()) return;
    setCommentErr("");
    const res = await fetch("/api/books/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: commentOpen.accountId,
        periodId,
        text: commentText.trim(),
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      setCommentErr(apiErrorMessage(j) || String(j.error || "comment_failed"));
      return;
    }
    setCommentText("");
    const threadId = String(j.threadId || commentOpen.threadId || "");
    setCommentOpen({ ...commentOpen, threadId });
    if (threadId) {
      const listed = await fetch(`/api/books/comments/threads/${threadId}`).then((r) => r.json());
      setCommentMsgs(listed.messages || []);
    }
    if (periodId) {
      const badges = await fetch(
        `/api/books/comments/badges?periodId=${encodeURIComponent(periodId)}`,
      ).then((r) => r.json());
      if (Array.isArray(badges)) setCommentBadges(badges);
    }
  }

  async function exportPack(format: "xlsx" | "pdf") {
    if (!query) return;
    setExportMsg("");
    setExporting(true);
    try {
      const res = await fetch("/api/books/reports/export-statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          mode,
          from: query.from,
          to: query.to,
          asOf,
          preparedBy: meta.preparedBy,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (res.status === 403 && j.error === "mfa_required") {
          setMfaFormat(format);
          return;
        }
        setExportMsg(apiErrorMessage(j) || String(j.error || "export_failed"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `financial-statements-${query.from}_${query.to}.${format === "pdf" ? "pdf" : "xlsx"}`;
      a.click();
      URL.revokeObjectURL(url);
      setExportMsg(`Exported ${format.toUpperCase()}.`);
    } catch {
      setExportMsg("Export failed. Check your connection and try again.");
    } finally {
      setExporting(false);
    }
  }

  const title =
    statement === "pnl" ? "Profit & Loss" : statement === "bs" ? "Balance sheet" : "Cash flow";
  const navKey = statement === "pnl" ? "pnl" : statement === "bs" ? "bs" : "cf";
  // Caption / file name / export header follow the columns shown, not the single month picked.
  const shownCols = statement === "pnl" ? pnl : statement === "bs" ? bs : cf;
  const periodLabel = (() => {
    if (shownCols?.length) {
      const first = shownCols[0].column.label;
      const last = shownCols[shownCols.length - 1].column.label;
      return first === last ? first : `${first} – ${last}`;
    }
    if (mode === "range" && query) return `${query.from} – ${query.to}`;
    return selected?.label || query?.from || "—";
  })();

  const gateFails: string[] = [];
  if (integrity) {
    if (!integrity.tbBalances.ok) gateFails.push(`TB (${integrity.tbBalances.differenceMinor} fils)`);
    if (!integrity.bsBalances.ok) gateFails.push(`Balance sheet (${integrity.bsBalances.differenceMinor} fils)`);
    if (!integrity.cfTies.ok) gateFails.push(`Cash flow ties (${integrity.cfTies.differenceMinor} fils)`);
  }

  if (periodsLoaded && !periods.length) {
    return (
      <div className="space-y-4 pb-10">
        <ReportsNav active={navKey} />
        <p className="text-sm text-muted-foreground" data-testid="fs-no-periods">
          No accounting periods yet — add one in Settings.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-10">
      <ReportsNav active={navKey} />
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">
            Posted journals · AED · {periodLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="text-xs text-muted-foreground">
            Columns
            <select
              className="ms-2 rounded-md border border-border bg-card px-2 py-1 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              data-testid="fs-mode"
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
              <option value="range">Range</option>
            </select>
          </label>
          {mode === "range" ? (
            <>
              <label className="text-xs text-muted-foreground">
                From
                <input
                  type="date"
                  className="ms-2 rounded-md border border-border bg-card px-2 py-1 text-sm"
                  value={rangeFrom}
                  onChange={(e) => setRangeFrom(e.target.value)}
                  data-testid="fs-range-from"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                To
                <input
                  type="date"
                  className="ms-2 rounded-md border border-border bg-card px-2 py-1 text-sm"
                  value={rangeTo}
                  onChange={(e) => setRangeTo(e.target.value)}
                  data-testid="fs-range-to"
                />
              </label>
            </>
          ) : (
            <label className="text-xs text-muted-foreground">
              Period
              <select
                className="ms-2 rounded-md border border-border bg-card px-2 py-1 text-sm"
                value={periodId}
                onChange={(e) => setPeriodId(e.target.value)}
                data-testid="fs-period"
              >
                {periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={showPrior}
              onChange={(e) => setShowPrior(e.target.checked)}
              data-testid="fs-show-prior"
            />
            Prior period column
          </label>
          <Button size="sm" variant="outline" onClick={jumpToday} data-testid="fs-today">
            Today
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={exporting || !query || Boolean(gateFails.length)}
            onClick={() => void exportPack("xlsx")}
            data-testid="fs-export-xlsx"
            title="P&L, balance sheet and cash flow together, with integrity checks"
          >
            Statements pack (Excel)
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={exporting || !query || Boolean(gateFails.length)}
            onClick={() => void exportPack("pdf")}
            data-testid="fs-export-pdf"
            title="P&L, balance sheet and cash flow together, with integrity checks"
          >
            Statements pack (PDF)
          </Button>
          {statement === "pnl" ? (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={projectionsOn}
                onChange={(e) => setProjectionsOn(e.target.checked)}
                data-testid="fs-projections-on"
              />
              Projections on
            </label>
          ) : null}
        </div>
      </div>

      {statement === "pnl" && ctBanner ? (
        <div
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
          data-testid="fs-ct-banner"
        >
          <div className="font-medium">
            Corporate tax · {ctBanner.taxYearLabel} · filing due {formatDateUae(ctBanner.filingDue)}
          </div>
          <div className="text-muted-foreground">
            Estimate {formatMinor(ctBanner.estimateMinor)} AED on taxable income{" "}
            {formatMinor(ctBanner.taxableIncomeMinor)} ({ctBanner.disclaimer})
          </div>
          {ctBanner.smallBusinessReliefMayApply ? (
            <div className="text-muted-foreground" data-testid="fs-ct-sbr">
              Revenue so far {formatMinor(ctBanner.revenueMinor ?? 0)} AED is within the AED 3,000,000 Small
              Business Relief limit — if the company elects relief, no corporate tax is due for this period.
            </div>
          ) : null}
        </div>
      ) : null}

      {statement === "pnl" && projectedPnl?.length ? (
        <FsMetricChart columns={projectedPnl} />
      ) : null}

      {gateFails.length ? (
        <div
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100"
          data-testid="fs-gate-banner"
          role="alert"
        >
          Integrity gate failed: {gateFails.join(" · ")}. Export is blocked until gates pass.
        </div>
      ) : null}
      <MfaDownloadModal
        open={mfaFormat !== null}
        onOpenChange={(open) => {
          if (!open) setMfaFormat(null);
        }}
        onVerified={() => {
          const f = mfaFormat;
          setMfaFormat(null);
          if (f) void exportPack(f);
        }}
      />
      {exportMsg ? (
        <p className="text-sm text-muted-foreground print:hidden" data-testid="fs-export-msg">
          {exportMsg}
        </p>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive" data-testid="fs-error">
          {error}
        </p>
      ) : null}

      <ReportTable
        testId={`fs-report-${statement}`}
        stateKey={`fs-${statement}-${mode}-${query?.from}-${query?.to}-proj:${projectionsOn ? 1 : 0}`}
        title={title}
        company={meta.company}
        periodLabel={periodLabel}
        preparedBy={meta.preparedBy}
        columns={tree.columns}
        rows={tree.rows}
        footer={tree.footer}
        brackets
        abbreviate
        onCellDrill={statement === "cf" ? undefined : openDrill}
        onCommentClick={statement === "pnl" ? (row) => void openComments(row) : undefined}
        exportName={`${statement}-${periodLabel.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}`}
        emptyText="No movements in this range."
      />

      <BooksSideDrawer
        open={Boolean(commentOpen)}
        onOpenChange={(o) => {
          if (!o) setCommentOpen(null);
        }}
        title={commentOpen ? `Comments · ${commentOpen.code} ${commentOpen.name}` : "Comments"}
        entryNo={selected?.label}
      >
        {commentOpen ? (
          <div className="flex h-full flex-col gap-3 p-4" data-testid="fs-comment-panel">
            <p className="text-xs text-muted-foreground">
              Mentions: {mentionUsers.map((u) => `@${u.name.split(/\s+/)[0]}`).join(", ") || "—"}
            </p>
            <ul className="min-h-0 flex-1 space-y-2 overflow-auto text-sm" data-testid="fs-comment-msgs">
              {commentMsgs.map((m) => (
                <li key={m.id} className="rounded-md border border-border/60 px-2 py-1.5">
                  <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                    <span>{m.authorName}</span>
                    <span>{formatDateUae(m.createdAt)}</span>
                  </div>
                  <div>{m.body}</div>
                </li>
              ))}
              {!commentMsgs.length ? (
                <li className="text-muted-foreground">No comments yet for this account / period.</li>
              ) : null}
            </ul>
            <textarea
              className="min-h-20 rounded-md border border-border bg-card px-2 py-1.5 text-sm"
              placeholder='Add a comment… use @Name or @"Full Name"'
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              data-testid="fs-comment-input"
            />
            {commentErr ? (
              <p className="text-xs text-destructive" data-testid="fs-comment-err">
                {commentErr}
              </p>
            ) : null}
            <Button
              size="sm"
              disabled={!commentText.trim()}
              onClick={() => void submitComment()}
              data-testid="fs-comment-submit"
            >
              Post comment
            </Button>
          </div>
        ) : null}
      </BooksSideDrawer>

      <BooksSideDrawer
        open={Boolean(drill)}
        onOpenChange={(o) => {
          if (!o) setDrill(null);
        }}
        title={drill ? `${drill.code} · ${drill.name}` : "Drill-down"}
        entryNo={drill?.periodLabel}
      >
        {drill ? (
          <div className="flex h-full flex-col gap-3 p-4" data-testid="fs-drill-panel">
            <div className="text-sm text-muted-foreground">
              {formatDateUae(drill.from)} – {formatDateUae(drill.to)} · {filteredLines.length} line
              {filteredLines.length === 1 ? "" : "s"}
            </div>
            {statement === "pnl" ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="fs-drill-comments"
                onClick={() =>
                  void openComments({
                    id: `acct:${drill.accountId}`,
                    label: drill.name,
                    code: drill.code,
                    values: {},
                    drill: {
                      kind: "account",
                      accountId: drill.accountId,
                      code: drill.code,
                      name: drill.name,
                    },
                  })
                }
              >
                Comments
              </Button>
            ) : null}
            <input
              className="rounded-md border border-border bg-card px-2 py-1.5 text-sm"
              placeholder="Search description / entry…"
              value={lineSearch}
              onChange={(e) => setLineSearch(e.target.value)}
              data-testid="fs-drill-search"
            />
            <label className="text-xs text-muted-foreground">
              Re-categorise to
              <select
                className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm"
                value={reclassTo}
                onChange={(e) => setReclassTo(e.target.value)}
                data-testid="fs-reclass-to"
              >
                <option value="">Select account…</option>
                {accounts
                  .filter((a) => a.id !== drill.accountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
              </select>
            </label>
            {reclassMsg ? (
              <p className="text-xs text-muted-foreground" data-testid="fs-reclass-msg">
                {reclassMsg}
              </p>
            ) : null}
            {drillError ? (
              <p className="text-xs text-destructive" data-testid="fs-drill-error">
                {drillError}
              </p>
            ) : null}
            <ul className="min-h-0 flex-1 space-y-2 overflow-auto text-sm" data-testid="fs-drill-lines">
              {drillMeta?.statement === "bs" ? (
                <li
                  className="flex items-start justify-between gap-2 rounded-md border border-border/60 bg-muted/40 px-2 py-1.5"
                  data-testid="fs-drill-opening"
                >
                  <div>
                    <div className="font-medium">Opening balance</div>
                    <div className="text-muted-foreground">Balance before {formatDateUae(drill.from)}</div>
                  </div>
                  <div className="tabular-nums">
                    {formatMinor(drillMeta.sign * drillMeta.openingMinor)}
                  </div>
                </li>
              ) : null}
              {filteredLines.map((l) => (
                <li
                  key={`${l.entryId}-${l.date}-${l.amountMinor}`}
                  className="flex items-start justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5"
                >
                  <div>
                    <div className="font-medium">{formatDateUae(l.date)}</div>
                    <div className="text-muted-foreground">{l.memo || "—"}</div>
                    <Link
                      href={`/books/reports/entry?id=${l.entryId}`}
                      className="text-xs text-primary underline-offset-2 hover:underline"
                    >
                      {l.entryNo || l.entryId.slice(0, 8)}
                    </Link>
                  </div>
                  <div className="text-end">
                    <div className="tabular-nums">
                      {formatMinor((drillMeta?.sign ?? 1) * l.amountMinor)}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1"
                      disabled={!reclassTo}
                      onClick={() => void submitReclass(l)}
                      data-testid="fs-reclass-btn"
                    >
                      Re-categorise
                    </Button>
                  </div>
                </li>
              ))}
              {!filteredLines.length ? (
                <li className="text-muted-foreground">No lines in this column.</li>
              ) : null}
              {drillMeta && !lineSearch.trim() ? (
                <li
                  className="flex justify-between gap-2 border-t border-border px-2 pt-2 font-medium"
                  data-testid="fs-drill-total"
                >
                  <span>{drillMeta.statement === "bs" ? "Closing balance" : "Total"}</span>
                  <span className="tabular-nums">{formatMinor(drillMeta.totalMinor)}</span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </BooksSideDrawer>
    </div>
  );
}
