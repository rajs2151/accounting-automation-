/**
 * Fiscal year label = calendar year of the fiscal-year start that contains `isoDate`.
 * Example: fyStartMonth=4, date 2026-03-15 → FY 2025 (starts Apr 2025).
 * Default fyStartMonth=1 → calendar year.
 */
export function fiscalYearForDate(isoDate: string, fyStartMonth = 1): number {
  const y = Number(String(isoDate).slice(0, 4));
  const m = Number(String(isoDate).slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return new Date().getUTCFullYear();
  }
  const start = Math.min(12, Math.max(1, Math.floor(fyStartMonth) || 1));
  if (m < start) return y - 1;
  return y;
}
