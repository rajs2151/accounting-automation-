/** Client-facing money labels — never expose "fils" in user copy. */

import { formatMinor } from "@/lib/money";

export type MoneyAmount = {
  amountMinor: number;
  currency?: string;
};

/** Format fils as major units with currency code (default AED). */
export function formatMoneyAmount(m: MoneyAmount): string {
  const cur = (m.currency || "AED").toUpperCase();
  return `${formatMinor(Math.trunc(m.amountMinor))} ${cur}`;
}

/** Structured AR/AP control vs open-items issue label (no "fils"). */
export function controlDriftIssueLabel(
  side: "AR" | "AP",
  control: MoneyAmount,
  open: MoneyAmount,
): string {
  const code = side === "AR" ? "1210" : "2110";
  const name = side === "AR" ? "AR control" : "AP control";
  return `${name} (${code}) ${formatMoneyAmount(control)} ≠ open items ${formatMoneyAmount(open)}`;
}

/** Health insight body for control drift. */
export function controlDriftInsightBody(side: "AR" | "AP", driftMinor: number): string {
  const code = side === "AR" ? "1210" : "2110";
  const name = side === "AR" ? "Trade receivables" : "Trade payables";
  const abs = formatMoneyAmount({ amountMinor: Math.abs(driftMinor), currency: "AED" });
  return `${name} control (${code}) differs from open items by ${abs} (control − open).`;
}
