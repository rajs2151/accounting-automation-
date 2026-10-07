/** Calendar helpers for schedule / auto-reverse jobs (P4-4). */

/** First day of the month after `isoDate` (YYYY-MM-DD), as YYYY-MM-DD. */
export function firstOfNextMonthIso(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) throw new Error(`invalid_date:${isoDate}`);
  const y = Number(m[1]);
  const month = Number(m[2]); // 1-12
  if (month < 1 || month > 12) throw new Error(`invalid_date:${isoDate}`);
  if (month === 12) return `${y + 1}-01-01`;
  return `${y}-${String(month + 1).padStart(2, "0")}-01`;
}

/** UTC midnight Date for enqueueing books_jobs.run_at. */
export function firstOfNextMonthUtc(isoDate: string): Date {
  return new Date(`${firstOfNextMonthIso(isoDate)}T00:00:00.000Z`);
}
