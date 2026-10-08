/** Human-readable report basis (month vs FY YTD / custom range). */

export type ReportBasisInput = {
  mode?: "monthly" | "quarterly" | "yearly" | "range" | "period" | "as_of";
  from?: string | null;
  to?: string | null;
  periodLabel?: string | null;
  /** True when the report's range/as-of differs from the shell period. */
  overridesShell?: boolean;
  shellPeriodLabel?: string | null;
};

export function describeReportBasis(input: ReportBasisInput): string {
  const label = (input.periodLabel || "").trim();
  const mode = input.mode || "monthly";
  let basis: string;
  switch (mode) {
    case "monthly":
      basis = label ? `Basis: Calendar month (${label})` : "Basis: Calendar month";
      break;
    case "quarterly":
      basis = label ? `Basis: Fiscal quarter (${label})` : "Basis: Fiscal quarter";
      break;
    case "yearly":
      basis = label ? `Basis: Fiscal year (${label})` : "Basis: Fiscal year";
      break;
    case "range":
      if (input.from && input.to) {
        basis = `Basis: Custom range (${input.from} – ${input.to})`;
      } else {
        basis = "Basis: Custom date range";
      }
      break;
    case "as_of":
      basis = input.to ? `Basis: Open items as of ${input.to}` : "Basis: As of date";
      break;
    case "period":
    default:
      basis = label ? `Basis: Period (${label})` : "Basis: Period";
  }
  if (input.overridesShell && input.shellPeriodLabel) {
    return `${basis} · not top-bar period (${input.shellPeriodLabel})`;
  }
  if (input.overridesShell) {
    return `${basis} · not top-bar period`;
  }
  return basis;
}
