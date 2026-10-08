/** Pure helpers for dashboard money tiles (outstanding / overdue / drift copy). */

export type DriftSide = { controlMinor: number; openMinor: number; driftMinor: number };

/** Parse issues-badge label produced by listBooksIssues for AR/AP control drift. */
export function parseControlDriftLabel(label: string | undefined): DriftSide | null {
  if (!label) return null;
  // New format: "AR control (1210) 210.00 AED ≠ open items 0.00 AED"
  const aed = label.match(
    /(\d+[.,]\d{2})\s*AED\s*≠\s*open items\s*(\d+[.,]\d{2})\s*AED/i,
  );
  if (aed) {
    const toMinor = (s: string) => Math.round(Number(s.replace(",", "")) * 100);
    const controlMinor = toMinor(aed[1]!);
    const openMinor = toMinor(aed[2]!);
    return { controlMinor, openMinor, driftMinor: controlMinor - openMinor };
  }
  // Legacy fils labels (tests / old badge cache)
  const m = label.match(/(\d+)\s*fils\s*≠\s*open items\s*(\d+)\s*fils/i);
  if (!m) return { controlMinor: 0, openMinor: 0, driftMinor: 1 };
  const controlMinor = Number(m[1]);
  const openMinor = Number(m[2]);
  return { controlMinor, openMinor, driftMinor: controlMinor - openMinor };
}

export function moneyTileOverdueNote(overdueMinor: number | null | undefined): string {
  if (overdueMinor == null) return "—";
  if (overdueMinor === 0) return "Nothing overdue";
  return "Has overdue balances";
}
