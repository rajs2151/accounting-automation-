/**
 * P6-2: map financial-statements API columns → ReportTable tree rows.
 */
import type { ReportColumn, ReportRow } from "@/lib/report-table";

export type FsSectionLike = {
  key: string;
  label: string;
  totalMinor: number;
  /** PL_other: signed net contribution to profit (income +, expense −). */
  netMinor?: number;
  accounts: Array<{
    accountId: string;
    code: string;
    name: string;
    amountMinor: number;
    /** PL_other: signed contribution (expense shown negative). */
    netMinor?: number;
  }>;
};

/** Engine-made presentation lines (e.g. "synthetic:pye", "synthetic:cye") have no ledger to drill into. */
export function isSyntheticAccountId(accountId: string): boolean {
  return String(accountId).startsWith("synthetic:");
}

export type PnlColumnLike = {
  column: { key: string; label: string; from: string; to: string };
  sections: FsSectionLike[];
  grossProfitMinor: number;
  ebitdaMinor: number;
  ebitMinor: number;
  ebtMinor: number;
  netProfitMinor: number;
};

export type BsColumnLike = {
  column: { key: string; label: string; from: string; to: string };
  assets: FsSectionLike[];
  liabilities: FsSectionLike[];
  equity: FsSectionLike[];
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  totalEquityMinor: number;
};

export type CfColumnLike = {
  column: { key: string; label: string; from: string; to: string };
  lines: Array<{ key: string; label: string; amountMinor: number }>;
  netProfitMinor: number;
  closingCashMinor: number;
};

function sectionChildren(
  section: FsSectionLike,
  colKey: string,
  valuesAcross: (accountId: string, code: string) => Record<string, number>,
): ReportRow[] {
  return section.accounts.map((a) => {
    const synthetic = isSyntheticAccountId(a.accountId) || a.code.startsWith("CYE");
    return {
      id: `acct:${a.accountId}`,
      code: synthetic ? undefined : a.code,
      label: a.name,
      values: valuesAcross(a.accountId, a.code),
      drill: synthetic
        ? undefined
        : { kind: "account", accountId: a.accountId, code: a.code, name: a.name },
      testId: `fs-acct-${a.code}`,
    };
  });
}

/** Merge account amounts across period columns into one tree (P&L). */
export function pnlToReportTree(columns: PnlColumnLike[]): {
  columns: ReportColumn[];
  rows: ReportRow[];
  footer: Array<{ id: string; label: string; values: Record<string, number>; testId?: string }>;
} {
  const cols: ReportColumn[] = columns.map((c) => ({ key: c.column.key, label: c.column.label }));
  const sectionOrder = ["PL_revenue", "PL_cogs", "PL_opex", "PL_depr", "PL_other", "PL_tax"];
  const sectionMeta = new Map<string, { label: string; accounts: Map<string, { code: string; name: string }> }>();

  for (const col of columns) {
    for (const s of col.sections) {
      let meta = sectionMeta.get(s.key);
      if (!meta) {
        meta = { label: s.label, accounts: new Map() };
        sectionMeta.set(s.key, meta);
      }
      for (const a of s.accounts) {
        meta.accounts.set(a.accountId, { code: a.code, name: a.name });
      }
    }
  }

  // PL_other mixes income and expense: show each account by its contribution to profit
  // (expense negative). The sign comes from the engine's netMinor; columns without it
  // (e.g. projections) reuse the sign seen in any actual column for the same account.
  const otherSign = new Map<string, number>();
  for (const col of columns) {
    for (const a of col.sections.find((s) => s.key === "PL_other")?.accounts || []) {
      if (a.netMinor != null && a.amountMinor !== 0) {
        otherSign.set(a.accountId, Math.sign(a.netMinor) * Math.sign(a.amountMinor) || 1);
      }
    }
  }

  const amountAt = (sectionKey: string, accountId: string, colKey: string) => {
    const col = columns.find((c) => c.column.key === colKey);
    const sec = col?.sections.find((s) => s.key === sectionKey);
    const acct = sec?.accounts.find((a) => a.accountId === accountId);
    if (!acct) return 0;
    if (sectionKey !== "PL_other") return acct.amountMinor;
    if (acct.netMinor != null) return acct.netMinor;
    return acct.amountMinor * (otherSign.get(accountId) ?? 1);
  };

  const sectionTotal = (col: PnlColumnLike, key: string) => {
    const sec = col.sections.find((s) => s.key === key);
    if (key === "PL_other") {
      // Net contribution, not income + expense added together.
      return sec?.netMinor ?? col.ebtMinor - col.ebitMinor;
    }
    return sec?.totalMinor ?? 0;
  };

  const rows: ReportRow[] = [];
  for (const key of sectionOrder) {
    const meta = sectionMeta.get(key);
    if (!meta || meta.accounts.size === 0) continue;
    const children: ReportRow[] = [...meta.accounts.entries()].map(([accountId, a]) => {
      const values: Record<string, number> = {};
      for (const c of cols) values[c.key] = amountAt(key, accountId, c.key);
      const synthetic = isSyntheticAccountId(accountId);
      return {
        id: `${key}:${accountId}`,
        code: synthetic ? undefined : a.code,
        label: a.name,
        values,
        drill: synthetic ? undefined : { kind: "account", accountId, code: a.code, name: a.name },
        testId: `fs-acct-${a.code}`,
      };
    });
    const values: Record<string, number> = {};
    for (const c of cols) {
      const col = columns.find((x) => x.column.key === c.key)!;
      values[c.key] = sectionTotal(col, key);
    }
    rows.push({
      id: key,
      label: meta.label,
      values,
      children,
      testId: `fs-section-${key}`,
    });

    // Insert subtotals after the section they follow.
    if (key === "PL_cogs") {
      const v: Record<string, number> = {};
      for (const c of cols) {
        v[c.key] = columns.find((x) => x.column.key === c.key)!.grossProfitMinor;
      }
      rows.push({ id: "sub:gp", label: "Gross profit", values: v, testId: "fs-subtotal-gp" });
    }
    if (key === "PL_opex") {
      const v: Record<string, number> = {};
      for (const c of cols) {
        v[c.key] = columns.find((x) => x.column.key === c.key)!.ebitdaMinor;
      }
      rows.push({ id: "sub:ebitda", label: "EBITDA", values: v, testId: "fs-subtotal-ebitda" });
    }
    if (key === "PL_depr") {
      const v: Record<string, number> = {};
      for (const c of cols) {
        v[c.key] = columns.find((x) => x.column.key === c.key)!.ebitMinor;
      }
      rows.push({ id: "sub:ebit", label: "EBIT", values: v, testId: "fs-subtotal-ebit" });
    }
    if (key === "PL_other") {
      const v: Record<string, number> = {};
      for (const c of cols) {
        v[c.key] = columns.find((x) => x.column.key === c.key)!.ebtMinor;
      }
      rows.push({ id: "sub:ebt", label: "EBT", values: v, testId: "fs-subtotal-ebt" });
    }
  }

  const footerVals: Record<string, number> = {};
  for (const c of cols) {
    footerVals[c.key] = columns.find((x) => x.column.key === c.key)!.netProfitMinor;
  }
  return {
    columns: cols,
    rows,
    footer: [{ id: "np", label: "Net profit", values: footerVals, testId: "fs-subtotal-np" }],
  };
}

export function bsToReportTree(columns: BsColumnLike[]): {
  columns: ReportColumn[];
  rows: ReportRow[];
  footer: Array<{ id: string; label: string; values: Record<string, number>; testId?: string }>;
} {
  const cols: ReportColumn[] = columns.map((c) => ({ key: c.column.key, label: c.column.label }));
  const groups: Array<{ key: string; label: string; pick: (c: BsColumnLike) => FsSectionLike[] }> = [
    { key: "assets", label: "Assets", pick: (c) => c.assets },
    { key: "liabilities", label: "Liabilities", pick: (c) => c.liabilities },
    { key: "equity", label: "Equity", pick: (c) => c.equity },
  ];

  const rows: ReportRow[] = [];
  for (const g of groups) {
    const sectionKeys = new Map<string, string>();
    const accounts = new Map<string, { sectionKey: string; code: string; name: string }>();
    for (const col of columns) {
      for (const s of g.pick(col)) {
        sectionKeys.set(s.key, s.label);
        for (const a of s.accounts) {
          accounts.set(`${s.key}:${a.accountId}`, {
            sectionKey: s.key,
            code: a.code,
            name: a.name,
          });
        }
      }
    }
    const sectionRows: ReportRow[] = [...sectionKeys.entries()].map(([sKey, sLabel]) => {
      const children: ReportRow[] = [...accounts.entries()]
        .filter(([, v]) => v.sectionKey === sKey)
        .map(([id, v]) => {
          const accountId = id.slice(sKey.length + 1);
          const values: Record<string, number> = {};
          for (const c of cols) {
            const col = columns.find((x) => x.column.key === c.key)!;
            const sec = g.pick(col).find((s) => s.key === sKey);
            values[c.key] = sec?.accounts.find((a) => a.accountId === accountId)?.amountMinor ?? 0;
          }
          // Synthetic equity lines (prior years' / current year profit) are computed, not posted.
          const synthetic = isSyntheticAccountId(accountId) || v.code === "CYE";
          return {
            id: id,
            code: synthetic ? undefined : v.code,
            label: v.name,
            values,
            drill: synthetic ? undefined : { kind: "account", accountId, code: v.code, name: v.name },
            testId: `fs-acct-${v.code}`,
          };
        });
      const values: Record<string, number> = {};
      for (const c of cols) {
        const col = columns.find((x) => x.column.key === c.key)!;
        values[c.key] = g.pick(col).find((s) => s.key === sKey)?.totalMinor ?? 0;
      }
      return { id: sKey, label: sLabel, values, children, testId: `fs-section-${sKey}` };
    });
    const gValues: Record<string, number> = {};
    for (const c of cols) {
      const col = columns.find((x) => x.column.key === c.key)!;
      gValues[c.key] = g.pick(col).reduce((s, sec) => s + sec.totalMinor, 0);
    }
    rows.push({
      id: g.key,
      label: g.label,
      values: gValues,
      children: sectionRows,
      testId: `fs-group-${g.key}`,
    });
  }

  const aVals: Record<string, number> = {};
  const leVals: Record<string, number> = {};
  for (const c of cols) {
    const col = columns.find((x) => x.column.key === c.key)!;
    aVals[c.key] = col.totalAssetsMinor;
    leVals[c.key] = col.totalLiabilitiesMinor + col.totalEquityMinor;
  }
  return {
    columns: cols,
    rows,
    footer: [
      { id: "ta", label: "Total assets", values: aVals, testId: "fs-total-assets" },
      { id: "tle", label: "Total liabilities + equity", values: leVals, testId: "fs-total-le" },
    ],
  };
}

export function cfToReportTree(columns: CfColumnLike[]): {
  columns: ReportColumn[];
  rows: ReportRow[];
  footer: Array<{ id: string; label: string; values: Record<string, number>; testId?: string }>;
} {
  const cols: ReportColumn[] = columns.map((c) => ({ key: c.column.key, label: c.column.label }));
  const lineKeys = new Map<string, string>();
  for (const col of columns) {
    for (const l of col.lines) lineKeys.set(l.key, l.label);
  }
  const rows: ReportRow[] = [...lineKeys.entries()].map(([key, label]) => {
    const values: Record<string, number> = {};
    for (const c of cols) {
      const col = columns.find((x) => x.column.key === c.key)!;
      values[c.key] = col.lines.find((l) => l.key === key)?.amountMinor ?? 0;
    }
    return { id: `cf:${key}`, label, values, testId: `fs-cf-${key}` };
  });
  const close: Record<string, number> = {};
  for (const c of cols) {
    close[c.key] = columns.find((x) => x.column.key === c.key)!.closingCashMinor;
  }
  return {
    columns: cols,
    rows,
    footer: [{ id: "close", label: "Closing cash (check)", values: close, testId: "fs-cf-close" }],
  };
}

void sectionChildren;

function ymdLocal(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDay(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add `n` months to (year, month 1–12). */
function shiftMonth(y: number, m: number, n: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

/**
 * Query range for quarterly / yearly report modes: the fiscal quarter or fiscal year (per the
 * company's fiscal_year_start_month) that contains the selected period. Monthly / range are
 * handled by the caller.
 */
export function fiscalRangeForPeriod(
  mode: "quarterly" | "yearly",
  periodStart: string,
  fyStartMonth = 1,
): { from: string; to: string } {
  const fyStart = Math.min(12, Math.max(1, Math.floor(Number(fyStartMonth)) || 1));
  const y = Number(periodStart.slice(0, 4));
  const m = Number(periodStart.slice(5, 7));
  const fyYear = m < fyStart ? y - 1 : y;
  const monthsIn = (y - fyYear) * 12 + (m - fyStart);
  const startOffset = mode === "yearly" ? 0 : Math.floor(monthsIn / 3) * 3;
  const span = mode === "yearly" ? 12 : 3;
  const s = shiftMonth(fyYear, fyStart, startOffset);
  const e = shiftMonth(fyYear, fyStart, startOffset + span - 1);
  return { from: ymdLocal(s.y, s.m, 1), to: ymdLocal(e.y, e.m, lastDay(e.y, e.m)) };
}
