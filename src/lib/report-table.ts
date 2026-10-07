/**
 * RPT-1: pure helpers behind ReportTable (no React) — tree rows, totals + Difference row, amount format,
 * monthly column split, TB → report tree. Money is integer fils throughout.
 */
import { formatMinor } from "@/lib/money";

export type ReportRow = {
  id: string;
  label: string;
  /** Optional code / reference shown before the label. */
  code?: string;
  /** Amounts per column key (fils). */
  values: Record<string, number>;
  children?: ReportRow[];
  /** Opaque payload handed back on drill-down. */
  drill?: unknown;
  /** Optional hover note and test id for the row. */
  title?: string;
  testId?: string;
};

export type FlatReportRow = ReportRow & { depth: number; hasChildren: boolean; expanded: boolean };

/** Visible rows in display order for the current expand state (groups collapsed unless expanded). */
export function flattenReportRows(rows: ReportRow[], expanded: ReadonlySet<string>, depth = 0): FlatReportRow[] {
  const out: FlatReportRow[] = [];
  for (const r of rows) {
    const hasChildren = Boolean(r.children?.length);
    const isOpen = hasChildren && expanded.has(r.id);
    out.push({ ...r, depth, hasChildren, expanded: isOpen });
    if (isOpen) out.push(...flattenReportRows(r.children!, expanded, depth + 1));
  }
  return out;
}

/** Every group id (for "Expand all"). */
export function allGroupIds(rows: ReportRow[], out: string[] = []): string[] {
  for (const r of rows) {
    if (r.children?.length) {
      out.push(r.id);
      allGroupIds(r.children, out);
    }
  }
  return out;
}

/**
 * The red Difference row: present only when the two grand totals differ (never hidden when they do).
 * Amount = debit − credit (positive: debits exceed credits).
 */
export function differenceRow(totalDebitMinor: number, totalCreditMinor: number): { differenceMinor: number } | null {
  const d = totalDebitMinor - totalCreditMinor;
  return d === 0 ? null : { differenceMinor: d };
}

/** Report cell text: blank for zero; negatives in brackets when `brackets` (statements), else "-". */
export function formatReportAmount(
  minor: number | null | undefined,
  opts?: { brackets?: boolean; abbreviate?: boolean },
): string {
  if (minor == null || minor === 0) return "";
  const neg = minor < 0;
  const abs = neg ? -minor : minor;
  let body: string;
  if (opts?.abbreviate && abs >= 100_000_000) {
    // ≥ 1,000,000.00 AED → M (fils / 1e8)
    body = `${(abs / 100_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  } else if (opts?.abbreviate && abs >= 100_000) {
    // ≥ 1,000.00 AED → K
    body = `${(abs / 100_000).toFixed(1).replace(/\.0$/, "")}K`;
  } else {
    body = formatMinor(abs);
  }
  if (neg && opts?.brackets) return `(${body})`;
  if (neg) return `-${body}`;
  return body;
}

/** Exact AED string for hover when cells use K/M abbreviations. */
export function formatReportAmountExact(
  minor: number | null | undefined,
  opts?: { brackets?: boolean },
): string {
  return formatReportAmount(minor, { brackets: opts?.brackets, abbreviate: false });
}

export type MonthColumn = { key: string; label: string; start: string; end: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One column per calendar month overlapping [from, to] (inclusive), clipped to the range. */
export function monthColumns(from: string, to: string): MonthColumn[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return [];
  const out: MonthColumn[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mStart = `${key}-01`;
    const mEnd = `${key}-${String(last).padStart(2, "0")}`;
    out.push({
      key,
      label: `${MONTHS[m - 1]} ${y}`,
      start: mStart < from ? from : mStart,
      end: mEnd > to ? to : mEnd,
    });
    if (key === endKey) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Shape of booksTrialBalance() that the report needs. */
export type TbLike = {
  groups: Array<{
    key: string;
    label: string;
    accounts: Array<{
      id: string;
      code: string;
      name: string;
      openingDebitMinor: number;
      openingCreditMinor: number;
      periodDebitMinor: number;
      periodCreditMinor: number;
      closingDebitMinor: number;
      closingCreditMinor: number;
    }>;
    subtotalClosingDebitMinor: number;
    subtotalClosingCreditMinor: number;
  }>;
  totalClosingDebit: number;
  totalClosingCredit: number;
};

export const TB_COLUMNS = [
  "openingDebit",
  "openingCredit",
  "periodDebit",
  "periodCredit",
  "closingDebit",
  "closingCredit",
] as const;

/**
 * TB → report tree: account-type group → ledger. Group values are sums of their ledgers; the grand
 * total is TB's own total (never recomputed differently), so on-screen numbers equal trial-balance.ts.
 */
export function tbToReportTree(tb: TbLike): { rows: ReportRow[]; totals: Record<string, number> } {
  const totals: Record<string, number> = Object.fromEntries(TB_COLUMNS.map((c) => [c, 0]));
  const rows: ReportRow[] = tb.groups.map((g) => {
    const children: ReportRow[] = g.accounts.map((a) => ({
      id: `acct:${a.id}`,
      code: a.code,
      label: a.name,
      values: {
        openingDebit: a.openingDebitMinor,
        openingCredit: a.openingCreditMinor,
        periodDebit: a.periodDebitMinor,
        periodCredit: a.periodCreditMinor,
        closingDebit: a.closingDebitMinor,
        closingCredit: a.closingCreditMinor,
      },
      drill: { kind: "account", accountId: a.id },
    }));
    const values: Record<string, number> = Object.fromEntries(TB_COLUMNS.map((c) => [c, 0]));
    for (const c of children) for (const k of TB_COLUMNS) values[k] += c.values[k];
    for (const k of TB_COLUMNS) totals[k] += values[k];
    return { id: `group:${g.key}`, label: g.label, values, children, drill: { kind: "group", key: g.key } };
  });
  totals.closingDebit = tb.totalClosingDebit;
  totals.closingCredit = tb.totalClosingCredit;
  return { rows, totals };
}

export type ReportColumn = { key: string; label: string; kind?: "amount" | "text" };

/** Plain amount for exports: no thousands separators, "-" for negatives, "" for zero. */
function exportAmount(minor: number | undefined): string {
  if (!minor) return "";
  const neg = minor < 0;
  const abs = Math.abs(minor);
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Rows of the current view for export (CSV / print): header block, column titles, visible rows
 * (indented by depth), footer rows, and the Difference row when totals differ — same numbers as on screen.
 */
export function reportExportRows(args: {
  title: string;
  company: string;
  periodLabel: string;
  preparedBy?: string;
  labelHeader: string;
  columns: ReportColumn[];
  rows: Array<ReportRow & { depth?: number; text?: Record<string, string> }>;
  footer?: Array<{ label: string; values: Record<string, number> }>;
  difference?: { debitKey: string; creditKey: string; totals: Record<string, number> } | null;
}): string[][] {
  const out: string[][] = [
    [args.title],
    [args.company],
    [`${args.periodLabel} · AED`],
  ];
  if (args.preparedBy) out.push([`Prepared by ${args.preparedBy}`]);
  out.push([]);
  out.push([args.labelHeader, ...args.columns.map((c) => c.label)]);
  const cell = (r: { values: Record<string, number>; text?: Record<string, string> }, c: ReportColumn) =>
    c.kind === "text" ? (r.text?.[c.key] ?? "") : exportAmount(r.values[c.key]);
  for (const r of args.rows) {
    const label = `${"  ".repeat(r.depth ?? 0)}${r.code ? `${r.code} ` : ""}${r.label}`;
    out.push([label, ...args.columns.map((c) => cell(r, c))]);
  }
  for (const f of args.footer || []) out.push([f.label, ...args.columns.map((c) => cell(f, c))]);
  if (args.difference) {
    const d = differenceRow(
      args.difference.totals[args.difference.debitKey] ?? 0,
      args.difference.totals[args.difference.creditKey] ?? 0,
    );
    if (d) out.push(["Difference", ...args.columns.map((c) => (c.key === args.difference!.debitKey ? exportAmount(d.differenceMinor) : ""))]);
  }
  return out;
}
