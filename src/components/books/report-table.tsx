"use client";

import Link from "next/link";
import { ChevronDown, ChevronRight, Download, Printer } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { csvCell } from "@/lib/csv";
import { formatDateUae } from "@/lib/date";
import {
  allGroupIds,
  differenceRow,
  flattenReportRows,
  formatReportAmount,
  formatReportAmountExact,
  reportExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/lib/report-table";
import { cn } from "@/lib/utils";

export type { ReportColumn, ReportRow };

export type ReportFooterRow = {
  id: string;
  label: string;
  values: Record<string, number>;
  text?: Record<string, string>;
  testId?: string;
};

export type Crumb = { label: string; href: string };

/** Breadcrumb trail passed between report pages in the `trail` query param. */
export function readTrail(raw: string | null): Crumb[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v)
      ? v.filter((c): c is Crumb => Boolean(c && typeof c === "object" && "href" in c && "label" in c))
      : [];
  } catch {
    return [];
  }
}

export function trailParam(trail: Crumb[]): string {
  return encodeURIComponent(JSON.stringify(trail));
}

export function ReportBreadcrumbs({ trail, current }: { trail: Crumb[]; current: string }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground print:hidden" data-testid="report-breadcrumbs">
      {trail.map((c, i) => (
        <span key={`${c.href}-${i}`}>
          <Link href={c.href} className="underline-offset-2 hover:underline">
            {c.label}
          </Link>
          <span className="mx-1">›</span>
        </span>
      ))}
      <span className="text-foreground">{current}</span>
    </nav>
  );
}

type RowWithText = ReportRow & { text?: Record<string, string> };

/**
 * Shared read-only report table (RPT-1): group → ledger tree with expand / collapse / expand all, sticky
 * header, right-aligned tabular amounts (blank for zero; brackets for negatives when `brackets`),
 * pinned footer rows from the caller, and a red Difference row whenever the grand totals differ.
 * Group click / Enter → expand or collapse; leaf click / Enter → onDrill; Backspace / Esc → onUp;
 * arrows move, ←/→ collapse / expand.
 * Expand state, focus and scroll are kept per `stateKey` in sessionStorage so returning restores them.
 * No add / edit / delete actions — reports are read-only.
 */
export function ReportTable(props: {
  testId: string;
  stateKey: string;
  title: string;
  company: string;
  periodLabel: string;
  preparedBy?: string;
  labelHeader?: string;
  columns: ReportColumn[];
  rows: RowWithText[];
  footer?: ReportFooterRow[];
  difference?: { debitKey: string; creditKey: string; totals: Record<string, number> } | null;
  brackets?: boolean;
  /** K/M abbreviations in cells; exact AED stays on the cell title. */
  abbreviate?: boolean;
  onDrill?: (row: RowWithText) => void;
  /** When set, amount cells call this with the column key (FS drill-down). */
  onCellDrill?: (row: RowWithText, columnKey: string) => void;
  /** P6-4a: comment bubble on rows that have a badge. */
  onCommentClick?: (row: RowWithText) => void;
  onUp?: () => void;
  exportName: string;
  emptyText?: string;
}) {
  const { stateKey, rows, columns } = props;
  const labelHeader = props.labelHeader || "Particulars";
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const storageKey = `report:${stateKey}`;

  // Restore expand state / focus / scroll once rows are present.
  useEffect(() => {
    if (restored.current || !rows.length) return;
    restored.current = true;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return;
      const s = JSON.parse(raw) as { expanded?: string[]; focus?: number; scrollTop?: number };
      if (Array.isArray(s.expanded)) setExpanded(new Set(s.expanded));
      if (typeof s.focus === "number") setFocus(s.focus);
      requestAnimationFrame(() => {
        if (scrollRef.current && typeof s.scrollTop === "number") scrollRef.current.scrollTop = s.scrollTop;
      });
    } catch {
      // storage unavailable — start fresh
    }
  }, [rows.length, storageKey]);

  const save = useCallback(
    (next?: { expanded?: Set<string>; focus?: number }) => {
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            expanded: [...(next?.expanded ?? expanded)],
            focus: next?.focus ?? focus,
            scrollTop: scrollRef.current?.scrollTop ?? 0,
          }),
        );
      } catch {
        // ignore
      }
    },
    [expanded, focus, storageKey],
  );

  const visible = useMemo(() => flattenReportRows(rows, expanded) as Array<RowWithText & ReturnType<typeof flattenReportRows>[number]>, [rows, expanded]);
  const groups = useMemo(() => allGroupIds(rows), [rows]);
  const diff = props.difference
    ? differenceRow(props.difference.totals[props.difference.debitKey] ?? 0, props.difference.totals[props.difference.creditKey] ?? 0)
    : null;

  function toggle(id: string, open?: boolean) {
    const next = new Set(expanded);
    const willOpen = open ?? !next.has(id);
    if (willOpen) next.add(id);
    else next.delete(id);
    setExpanded(next);
    save({ expanded: next });
  }

  function activate(i: number) {
    const r = visible[i];
    if (!r) return;
    setFocus(i);
    if (r.hasChildren) {
      toggle(r.id);
      return;
    }
    save({ focus: i });
    if (props.onDrill) {
      props.onDrill(r);
      return;
    }
    // Statements drill per cell: Enter opens the row's last amount column (the current period).
    const amountCols = columns.filter((c) => c.kind !== "text" && !c.projected);
    const col = amountCols[amountCols.length - 1];
    if (props.onCellDrill && col) props.onCellDrill(r, col.key);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const r = visible[focus];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocus((f) => Math.min(visible.length - 1, f + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocus((f) => Math.max(0, f - 1));
    } else if (e.key === "ArrowRight" && r?.hasChildren) {
      e.preventDefault();
      toggle(r.id, true);
    } else if (e.key === "ArrowLeft" && r?.hasChildren) {
      e.preventDefault();
      toggle(r.id, false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(focus);
    } else if (e.key === "Backspace" || e.key === "Escape") {
      if (props.onUp) {
        e.preventDefault();
        save();
        props.onUp();
      }
    }
  }

  useEffect(() => {
    scrollRef.current?.querySelector(`[data-row-index="${focus}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  function exportData() {
    const expandedAll = flattenReportRows(rows, new Set(groups));
    return reportExportRows({
      title: props.title,
      company: props.company,
      periodLabel: props.periodLabel,
      preparedBy: props.preparedBy,
      labelHeader,
      columns,
      rows: expandedAll as Array<RowWithText & { depth: number }>,
      footer: props.footer,
      difference: props.difference,
    });
  }

  function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportXlsx() {
    const res = await fetch("/api/books/reports/export-xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: props.title, fileName: props.exportName, rows: exportData() }),
    });
    if (!res.ok) return;
    download(await res.blob(), `${props.exportName}.xlsx`);
  }

  function exportCsv() {
    const csv = exportData()
      .map((r) => r.map((c) => csvCell(c)).join(","))
      .join("\r\n");
    download(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), `${props.exportName}.csv`);
  }

  const amount = (v: number | undefined) =>
    formatReportAmount(v ?? 0, { brackets: props.brackets, abbreviate: props.abbreviate });
  const amountTitle = (v: number | undefined) =>
    formatReportAmountExact(v ?? 0, { brackets: props.brackets });
  const cell = (r: { values: Record<string, number>; text?: Record<string, string> }, c: ReportColumn) =>
    c.kind === "text" ? (r.text?.[c.key] ?? "") : amount(r.values[c.key]);

  return (
    <div className="space-y-2" data-testid={props.testId}>
      <style>{`
        @media print { @page { margin: 14mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 9px; } } }
        [data-report-scroll] table th:first-child,
        [data-report-scroll] table td:first-child {
          position: sticky;
          left: 0;
          z-index: 1;
          background: hsl(var(--card));
        }
        [data-report-scroll] table thead th:first-child { z-index: 2; background: hsl(var(--muted)); }
      `}</style>
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div className="flex gap-2">
          {groups.length ? (
            <>
              <Button size="sm" variant="outline" onClick={() => { const n = new Set(groups); setExpanded(n); save({ expanded: n }); }} data-testid="report-expand-all">
                Expand all
              </Button>
              <Button size="sm" variant="outline" onClick={() => { const n = new Set<string>(); setExpanded(n); save({ expanded: n }); }}>
                Collapse all
              </Button>
            </>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void exportXlsx()} data-testid="report-export-xlsx">
            <Download className="size-3.5" /> Export XLSX
          </Button>
          <Button size="sm" variant="outline" onClick={exportCsv} data-testid="report-export-csv">
            <Download className="size-3.5" /> Export CSV
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.print()} data-testid="report-print">
            <Printer className="size-3.5" /> Print / PDF
          </Button>
        </div>
      </div>
      <div className="hidden text-sm print:block">
        <div className="text-lg font-semibold">{props.title}</div>
        <div>{props.company}</div>
        <div>
          {props.periodLabel} · AED{props.preparedBy ? ` · Prepared by ${props.preparedBy}` : ""} · Printed{" "}
          {formatDateUae(new Date().toISOString())}
        </div>
      </div>
      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-label={props.title}
        onKeyDown={onKeyDown}
        onScroll={() => save()}
        data-report-scroll=""
        className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring print:max-h-none print:overflow-visible"
      >
        <table className="w-full min-w-[640px] text-sm" data-own-style="">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="text-xs text-muted-foreground">
              <th className="px-3 py-2 text-start font-medium" colSpan={1}>
                <span className="block text-[11px] font-normal">
                  {props.company} · {props.periodLabel} · AED
                </span>
                {labelHeader}
              </th>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "px-3 py-2 align-bottom font-medium",
                    c.kind === "text" ? "text-start" : "text-end",
                    c.projected && "bg-amber-50/80 italic text-amber-900 dark:bg-amber-950/30 dark:text-amber-100",
                  )}
                  data-projected={c.projected ? "1" : undefined}
                >
                  {c.projected ? `${c.label} · Projected` : c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr
                key={r.id}
                data-row-index={i}
                data-testid={r.testId || `report-row-${r.id}`}
                title={r.title}
                aria-selected={i === focus}
                onClick={() => activate(i)}
                className={cn(
                  "cursor-pointer border-b border-border/60 hover:bg-muted/30",
                  r.hasChildren && "bg-muted/20 font-medium",
                  i === focus && "bg-primary/5",
                )}
              >
                <td className="px-3 py-1.5" style={{ paddingInlineStart: `${0.75 + r.depth * 1.25}rem` }}>
                  <span className="inline-flex items-center gap-1">
                    {r.hasChildren ? (
                      <button
                        type="button"
                        aria-label={r.expanded ? "Collapse" : "Expand"}
                        className="print:hidden"
                        data-testid={`report-toggle-${r.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(r.id);
                        }}
                      >
                        {r.expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5 rtl:rotate-180" />}
                      </button>
                    ) : null}
                    {r.code ? <span className="font-mono text-xs text-muted-foreground">{r.code}</span> : null}
                    <span>{r.label}</span>
                    {r.commentBadge && (r.commentBadge.messageCount > 0 || props.onCommentClick) ? (
                      <button
                        type="button"
                        className={cn(
                          "ms-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold print:hidden",
                          r.commentBadge.unreadCount > 0
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        )}
                        title={
                          r.commentBadge.unreadCount > 0
                            ? `${r.commentBadge.unreadCount} unread`
                            : `${r.commentBadge.messageCount} comments`
                        }
                        data-testid={`fs-comment-badge-${r.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onCommentClick?.(r);
                        }}
                      >
                        {r.commentBadge.unreadCount > 0
                          ? r.commentBadge.unreadCount
                          : r.commentBadge.messageCount || "…"}
                      </button>
                    ) : null}
                  </span>
                </td>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    title={c.kind === "text" ? undefined : amountTitle(r.values[c.key]) || undefined}
                    className={cn(
                      "px-3 py-1.5",
                      c.kind === "text" ? "text-start" : "text-end tabular-nums",
                      c.projected && "bg-amber-50/40 dark:bg-amber-950/20",
                    )}
                    onClick={
                      props.onCellDrill && c.kind !== "text" && !r.hasChildren && !c.projected
                        ? (e) => {
                            e.stopPropagation();
                            setFocus(i);
                            save({ focus: i });
                            props.onCellDrill?.(r, c.key);
                          }
                        : undefined
                    }
                  >
                    {cell(r, c)}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-6 text-muted-foreground">
                  {props.emptyText || "Nothing to show."}
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot className="sticky bottom-0 bg-card">
            {(props.footer || []).map((f) => (
              <tr key={f.id} className="border-t-2 border-border font-semibold" data-testid={f.testId}>
                <td className="px-3 py-2">{f.label}</td>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn("px-3 py-2", c.kind === "text" ? "text-start" : "text-end tabular-nums")}
                    title={c.kind === "text" ? undefined : amountTitle(f.values[c.key]) || undefined}
                  >
                    {cell(f, c)}
                  </td>
                ))}
              </tr>
            ))}
            {diff && props.difference ? (
              <tr className="bg-red-50 font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-200" data-testid="report-difference">
                <td className="px-3 py-2">Difference</td>
                {columns.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-end tabular-nums">
                    {c.key === props.difference!.debitKey ? formatReportAmount(diff.differenceMinor) : ""}
                  </td>
                ))}
              </tr>
            ) : null}
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** Company name + signed-in user's name for report headers / print. */
export function useReportMeta() {
  const [meta, setMeta] = useState({ company: "", preparedBy: "" });
  useEffect(() => {
    void Promise.all([
      fetch("/api/books/company").then((r) => r.json()).catch(() => null),
      fetch("/api/session").then((r) => r.json()).catch(() => null),
    ]).then(([c, s]) => setMeta({ company: String(c?.name || ""), preparedBy: String(s?.me?.name || "") }));
  }, []);
  return meta;
}

const REPORT_TABS = [
  { href: "/books/reports/pnl", label: "Profit & Loss", key: "pnl" },
  { href: "/books/reports/balance-sheet", label: "Balance sheet", key: "bs" },
  { href: "/books/reports/cash-flow", label: "Cash flow", key: "cf" },
  { href: "/books/reports/trial-balance", label: "Trial balance", key: "tb" },
  { href: "/books/reports/day-book", label: "Day book", key: "daybook" },
  { href: "/books/reports/ageing?side=ar", label: "Receivables ageing", key: "ar" },
  { href: "/books/reports/ageing?side=ap", label: "Payables ageing", key: "ap" },
] as const;

/** Reports tab strip (Phase 6 FS tabs first, then RPT-1 reports). */
export function ReportsNav({ active }: { active: (typeof REPORT_TABS)[number]["key"] }) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-border pb-2 text-sm print:hidden" data-testid="reports-nav">
      {REPORT_TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cn("rounded-md px-3 py-1", t.key === active ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
          data-testid={`reports-tab-${t.key}`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
