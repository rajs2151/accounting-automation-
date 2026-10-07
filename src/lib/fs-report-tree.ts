/**
 * P6-2: map financial-statements API columns → ReportTable tree rows.
 */
import type { ReportColumn, ReportRow } from "@/lib/report-table";

export type FsSectionLike = {
  key: string;
  label: string;
  totalMinor: number;
  accounts: Array<{ accountId: string; code: string; name: string; amountMinor: number }>;
};

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
  return section.accounts.map((a) => ({
    id: `acct:${a.accountId}`,
    code: a.code.startsWith("CYE") ? undefined : a.code,
    label: a.name,
    values: valuesAcross(a.accountId, a.code),
    drill: {
      kind: "account",
      accountId: a.accountId,
      code: a.code,
      name: a.name,
    },
    testId: `fs-acct-${a.code}`,
  }));
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

  const amountAt = (sectionKey: string, accountId: string, colKey: string) => {
    const col = columns.find((c) => c.column.key === colKey);
    const sec = col?.sections.find((s) => s.key === sectionKey);
    return sec?.accounts.find((a) => a.accountId === accountId)?.amountMinor ?? 0;
  };

  const rows: ReportRow[] = [];
  for (const key of sectionOrder) {
    const meta = sectionMeta.get(key);
    if (!meta || meta.accounts.size === 0) continue;
    const children: ReportRow[] = [...meta.accounts.entries()].map(([accountId, a]) => {
      const values: Record<string, number> = {};
      for (const c of cols) values[c.key] = amountAt(key, accountId, c.key);
      return {
        id: `${key}:${accountId}`,
        code: a.code,
        label: a.name,
        values,
        drill: { kind: "account", accountId, code: a.code, name: a.name },
        testId: `fs-acct-${a.code}`,
      };
    });
    const values: Record<string, number> = {};
    for (const c of cols) {
      const col = columns.find((x) => x.column.key === c.key)!;
      values[c.key] = col.sections.find((s) => s.key === key)?.totalMinor ?? 0;
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
          return {
            id: id,
            code: v.code === "CYE" ? undefined : v.code,
            label: v.name,
            values,
            drill:
              v.code === "CYE"
                ? undefined
                : { kind: "account", accountId, code: v.code, name: v.name },
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
