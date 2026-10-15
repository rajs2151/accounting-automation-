/**
 * Projected P&L column from forecast rows — the same sections and subtotals as the real P&L
 * (financial-statements.ts buildPnlColumn), so a forecast rent line lands in Operating expenses and
 * reduces profit instead of being added to revenue.
 */
export type ProjectionAccount = {
  id: string;
  code: string;
  name: string;
  accountType?: string | null;
  statementLine?: string | null;
  subType?: string | null;
};

export type ProjectedSection = {
  key: string;
  label: string;
  totalMinor: number;
  accounts: Array<{ accountId: string; code: string; name: string; amountMinor: number }>;
};

const SECTIONS: Array<[string, string]> = [
  ["PL_revenue", "Revenue"],
  ["PL_cogs", "Cost of sales"],
  ["PL_opex", "Operating expenses"],
  ["PL_depr", "Depreciation & amortisation"],
  ["PL_other", "Other income / finance"],
  ["PL_tax", "Corporate tax"],
];

function sectionFor(a: ProjectionAccount | undefined): string {
  if (!a) return "PL_revenue";
  if (a.accountType === "expense" && (a.subType === "depr" || a.subType === "amort")) return "PL_depr";
  if (a.statementLine && a.statementLine.startsWith("PL_")) return a.statementLine;
  return a.accountType === "expense" ? "PL_opex" : "PL_revenue";
}

/** Forecast amounts are presentation amounts (revenue positive, costs positive), like the P&L. */
export function buildProjectedPnlColumn(
  rows: Array<{ accountId: string; amountMinor: number }>,
  accounts: ProjectionAccount[],
) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const sections = new Map<string, ProjectedSection>(
    SECTIONS.map(([key, label]) => [key, { key, label, totalMinor: 0, accounts: [] }]),
  );
  let otherNet = 0;
  for (const r of rows) {
    const acct = byId.get(r.accountId);
    const key = sectionFor(acct);
    const sec = sections.get(key)!;
    sec.accounts.push({
      accountId: r.accountId,
      code: acct?.code || "",
      name: acct?.name || "Projected",
      amountMinor: r.amountMinor,
    });
    sec.totalMinor += r.amountMinor;
    if (key === "PL_other") otherNet += acct?.accountType === "income" ? r.amountMinor : -r.amountMinor;
  }
  const t = (k: string) => sections.get(k)!.totalMinor;
  const grossProfitMinor = t("PL_revenue") - t("PL_cogs");
  const ebitdaMinor = grossProfitMinor - t("PL_opex");
  const ebitMinor = ebitdaMinor - t("PL_depr");
  const ebtMinor = ebitMinor + otherNet;
  const netProfitMinor = ebtMinor - t("PL_tax");
  return {
    sections: [...sections.values()],
    grossProfitMinor,
    ebitdaMinor,
    ebitMinor,
    ebtMinor,
    netProfitMinor,
  };
}
