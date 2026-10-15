/** Default document issue date: today if that day falls in an open period, else selected period end. */

export type PeriodForDefaultDate = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: string;
};

export function defaultIssueDateIso(opts: {
  todayIso: string;
  selectedPeriodId: string | null | undefined;
  periods: PeriodForDefaultDate[];
}): string {
  const today = opts.todayIso.slice(0, 10);
  const openToday = opts.periods.find(
    (p) =>
      (p.status === "OPEN" || p.status === "REOPENED") &&
      p.periodStart <= today &&
      p.periodEnd >= today,
  );
  if (openToday) return today;

  const selected =
    (opts.selectedPeriodId && opts.periods.find((p) => p.id === opts.selectedPeriodId)) ||
    opts.periods.find((p) => p.status === "OPEN" || p.status === "REOPENED") ||
    opts.periods[opts.periods.length - 1];
  if (!selected) return today;
  // Prefer today clamped into the period when the period is still open/reopened.
  if (selected.status === "OPEN" || selected.status === "REOPENED") {
    if (today < selected.periodStart) return selected.periodStart;
    if (today > selected.periodEnd) return selected.periodEnd;
    return today;
  }
  return selected.periodEnd;
}

/** due_date = issue_date + payment_terms_days (inclusive calendar days). */
export function dueDateFromTerms(issueDateIso: string, paymentTermsDays: number | null | undefined): string | null {
  const days = Math.trunc(Number(paymentTermsDays));
  if (!Number.isFinite(days) || days <= 0) return null;
  const d = new Date(`${issueDateIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
