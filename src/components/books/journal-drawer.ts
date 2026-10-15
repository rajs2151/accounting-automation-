/** Shared helpers for Ledger journal SideDrawer (P4-2). */

export function journalLineSide(line: { debitMinor: number; creditMinor: number }): "debit" | "credit" {
  return line.debitMinor > 0 ? "debit" : "credit";
}

export function formatAuditAction(action: string): string {
  return String(action || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function linkedEntryLabel(entryNo: string | null | undefined, id: string | null | undefined): string {
  if (entryNo) return entryNo;
  if (id) return `${id.slice(0, 8)}…`;
  return "—";
}
