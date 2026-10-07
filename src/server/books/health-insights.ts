/**
 * P7-3: rule-based Company Health insight cards (no LLM).
 * Pure functions — unit-tested with hand-chosen thresholds.
 */

export type InsightSeverity = "info" | "warn" | "critical";

export type HealthInsight = {
  id: string;
  severity: InsightSeverity;
  title: string;
  body: string;
  actions: Array<{ label: string; href: string }>;
};

export type OverduePartyShare = {
  partyId: string;
  partyName: string;
  overdueMinor: number;
};

export type CostMover = {
  code: string;
  name: string;
  currentMinor: number;
  priorMinor: number;
  /** Percent MoM; null if prior is 0. */
  momPct: number | null;
};

export type InsightInput = {
  runwayMonthsMilli: number | null; // null = cash positive / n/a
  dsoDays: number | null;
  arOverdueMinor: number;
  overdueByParty: OverduePartyShare[];
  costMovers: CostMover[];
};

const RUNWAY_WARN_MONTHS_MILLI = 6_000; // 6.000 months
const DSO_WARN_DAYS = 45;
const OVERDUE_CONCENTRATION_BPS = 5_000; // 50%
const COST_MOVER_WARN_PCT = 20;

/** MoM % rounded to 2 dp; null when prior is 0. */
export function momPctChange(currentMinor: number, priorMinor: number): number | null {
  const prior = Math.trunc(priorMinor);
  if (prior === 0) return null;
  return Math.round(((Math.trunc(currentMinor) - prior) / Math.abs(prior)) * 10000) / 100;
}

/** Parties whose overdue share of total overdue AR is ≥ threshold (bps). */
export function overdueConcentration(
  parties: OverduePartyShare[],
  totalOverdueMinor: number,
  thresholdBps = OVERDUE_CONCENTRATION_BPS,
): { parties: OverduePartyShare[]; shareBps: number } | null {
  const total = Math.trunc(totalOverdueMinor);
  if (total <= 0 || !parties.length) return null;
  const sorted = [...parties]
    .filter((p) => p.overdueMinor > 0)
    .sort((a, b) => b.overdueMinor - a.overdueMinor);
  let cum = 0;
  const picked: OverduePartyShare[] = [];
  for (const p of sorted) {
    cum += Math.trunc(p.overdueMinor);
    picked.push(p);
    const shareBps = Math.floor((cum * 10_000) / total);
    if (shareBps >= thresholdBps) return { parties: picked, shareBps };
  }
  return null;
}

export function buildHealthInsights(input: InsightInput): HealthInsight[] {
  const out: HealthInsight[] = [];

  if (input.runwayMonthsMilli != null && input.runwayMonthsMilli < RUNWAY_WARN_MONTHS_MILLI) {
    const months = (input.runwayMonthsMilli / 1000).toFixed(1);
    out.push({
      id: "runway_under_6",
      severity: input.runwayMonthsMilli < 3_000 ? "critical" : "warn",
      title: "Runway under 6 months",
      body: `Cash runway is about ${months} months at the current average burn.`,
      actions: [
        { label: "Cash flow", href: "/books/reports/cash-flow" },
        { label: "Close checklist", href: "/books/close" },
      ],
    });
  }

  if (input.dsoDays != null && input.dsoDays > DSO_WARN_DAYS) {
    out.push({
      id: "dso_above_45",
      severity: input.dsoDays > 60 ? "critical" : "warn",
      title: "DSO above 45 days",
      body: `Days sales outstanding is ${input.dsoDays} days — collections are slower than the 45-day watch line.`,
      actions: [
        { label: "Receivables", href: "/books/health" },
        { label: "AR ageing", href: "/books/reports/ageing?side=ar" },
      ],
    });
  }

  const conc = overdueConcentration(input.overdueByParty, input.arOverdueMinor);
  if (conc) {
    const names = conc.parties.map((p) => p.partyName).join(", ");
    const pct = (conc.shareBps / 100).toFixed(0);
    out.push({
      id: "overdue_ar_concentration",
      severity: "warn",
      title: `${conc.parties.length} client${conc.parties.length === 1 ? "" : "s"} = ${pct}% of overdue AR`,
      body: `Most overdue receivables sit with: ${names}.`,
      actions: [
        { label: "Debtors tab", href: "/books/health" },
        { label: "AR ageing", href: "/books/reports/ageing?side=ar" },
      ],
    });
  }

  for (const m of input.costMovers) {
    if (m.momPct == null || m.momPct < COST_MOVER_WARN_PCT) continue;
    out.push({
      id: `cost_mover_${m.code}`,
      severity: m.momPct >= 40 ? "critical" : "warn",
      title: `${m.name} +${m.momPct.toFixed(0)}% MoM`,
      body: `Operating spend on ${m.code} ${m.name} rose versus the prior month.`,
      actions: [
        { label: "P&L", href: "/books/reports/pnl" },
        { label: "Account ledger", href: `/books/reports/account-ledger?code=${encodeURIComponent(m.code)}` },
      ],
    });
    if (out.filter((i) => i.id.startsWith("cost_mover_")).length >= 3) break;
  }

  return out;
}
