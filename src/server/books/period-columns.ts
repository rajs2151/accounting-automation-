/**
 * P6-1: fiscal-year-aware report period columns (Monthly / Quarterly / Yearly / range).
 * Partial current columns are labelled MTD/QTD/YTD and compared like-for-like (same day count).
 */
import { fiscalYearForDate } from "@/lib/fiscal-year";

export type PeriodColumnMode = "monthly" | "quarterly" | "yearly" | "range";

export type PeriodColumn = {
  key: string;
  label: string;
  from: string;
  to: string;
  /** True when truncated to "as of today" inside an open period. */
  isPartial: boolean;
  partialKind: "MTD" | "QTD" | "YTD" | null;
  /** Prior like-for-like window (same number of days). */
  compareFrom: string | null;
  compareTo: string | null;
};

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function ymd(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDayOfMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysInclusive(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.floor((b - a) / 86400000) + 1;
}

function monthLabel(y: number, m: number) {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m - 1]} ${y}`;
}

/** First day of fiscal year `fy` given start month (1–12). */
export function fiscalYearBounds(fy: number, fyStartMonth: number): { start: string; end: string } {
  const startM = Math.min(12, Math.max(1, fyStartMonth || 1));
  const start = ymd(fy, startM, 1);
  const endM = startM === 1 ? 12 : startM - 1;
  const endY = startM === 1 ? fy : fy + 1;
  const end = ymd(endY, endM, lastDayOfMonth(endY, endM));
  return { start, end };
}

function likeForLikePrior(from: string, to: string): { compareFrom: string; compareTo: string } {
  const n = daysInclusive(from, to);
  const compareTo = addDays(from, -1);
  const compareFrom = addDays(compareTo, -(n - 1));
  return { compareFrom, compareTo };
}

function applyPartial(
  col: Omit<PeriodColumn, "compareFrom" | "compareTo" | "isPartial" | "partialKind" | "label"> & {
    baseLabel: string;
    naturalEnd: string;
    partialKind: "MTD" | "QTD" | "YTD";
  },
  asOf: string,
): PeriodColumn {
  const truncated = asOf < col.naturalEnd;
  const to = truncated && asOf >= col.from ? asOf : col.to;
  const isPartial = truncated && asOf >= col.from && asOf < col.naturalEnd;
  const label = isPartial ? `${col.partialKind} ${col.baseLabel}` : col.baseLabel;
  const prior = isPartial ? likeForLikePrior(col.from, to) : { compareFrom: null, compareTo: null };
  return {
    key: col.key,
    label,
    from: col.from,
    to,
    isPartial,
    partialKind: isPartial ? col.partialKind : null,
    compareFrom: prior.compareFrom,
    compareTo: prior.compareTo,
  };
}

export type PeriodRow = { id: string; label: string; periodStart: string; periodEnd: string };

/**
 * Build report columns for the selected mode.
 * `asOf` defaults to today (UTC); used only to mark partial current columns.
 */
export function buildPeriodColumns(args: {
  mode: PeriodColumnMode;
  periods: PeriodRow[];
  from: string;
  to: string;
  fyStartMonth?: number;
  asOf?: string;
}): PeriodColumn[] {
  const fyStart = Math.min(12, Math.max(1, args.fyStartMonth || 1));
  const asOf = iso(args.asOf || new Date().toISOString().slice(0, 10));
  const from = iso(args.from);
  const to = iso(args.to);
  const periods = [...args.periods]
    .map((p) => ({
      id: p.id,
      label: p.label,
      periodStart: iso(p.periodStart),
      periodEnd: iso(p.periodEnd),
    }))
    .filter((p) => p.periodEnd >= from && p.periodStart <= to)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));

  if (args.mode === "range") {
    return [
      applyPartial(
        {
          key: `range:${from}:${to}`,
          baseLabel: `${from} → ${to}`,
          from,
          to,
          naturalEnd: to,
          partialKind: "YTD",
        },
        asOf,
      ),
    ];
  }

  if (args.mode === "monthly") {
    return periods.map((p) =>
      applyPartial(
        {
          key: `m:${p.id}`,
          baseLabel: p.label,
          from: p.periodStart,
          to: p.periodEnd,
          naturalEnd: p.periodEnd,
          partialKind: "MTD",
        },
        asOf,
      ),
    );
  }

  if (args.mode === "quarterly") {
    const buckets = new Map<string, { from: string; to: string; fy: number; q: number }>();
    for (const p of periods) {
      const fy = fiscalYearForDate(p.periodStart, fyStart);
      const { start } = fiscalYearBounds(fy, fyStart);
      const startY = Number(start.slice(0, 4));
      const startM = Number(start.slice(5, 7));
      const py = Number(p.periodStart.slice(0, 4));
      const pm = Number(p.periodStart.slice(5, 7));
      const monthsFromFy = (py - startY) * 12 + (pm - startM);
      const q = Math.floor(monthsFromFy / 3) + 1;
      const key = `fy${fy}-q${q}`;
      const existing = buckets.get(key);
      if (!existing) {
        buckets.set(key, { from: p.periodStart, to: p.periodEnd, fy, q });
      } else {
        if (p.periodStart < existing.from) existing.from = p.periodStart;
        if (p.periodEnd > existing.to) existing.to = p.periodEnd;
      }
    }
    return [...buckets.entries()].map(([key, b]) =>
      applyPartial(
        {
          key,
          baseLabel: `Q${b.q} FY${b.fy}`,
          from: b.from,
          to: b.to,
          naturalEnd: b.to,
          partialKind: "QTD",
        },
        asOf,
      ),
    );
  }

  // yearly
  const years = new Map<number, { from: string; to: string }>();
  for (const p of periods) {
    const fy = fiscalYearForDate(p.periodStart, fyStart);
    const bounds = fiscalYearBounds(fy, fyStart);
    const existing = years.get(fy);
    if (!existing) {
      years.set(fy, {
        from: p.periodStart < bounds.start ? bounds.start : p.periodStart,
        to: p.periodEnd > bounds.end ? bounds.end : p.periodEnd,
      });
    } else {
      if (p.periodStart < existing.from) existing.from = p.periodStart;
      if (p.periodEnd > existing.to) existing.to = p.periodEnd;
    }
  }
  return [...years.entries()].map(([fy, b]) => {
    const bounds = fiscalYearBounds(fy, fyStart);
    return applyPartial(
      {
        key: `fy:${fy}`,
        baseLabel: `FY${fy}`,
        from: b.from < bounds.start ? bounds.start : b.from,
        to: b.to > bounds.end ? bounds.end : b.to,
        naturalEnd: bounds.end,
        partialKind: "YTD",
      },
      asOf,
    );
  });
}
