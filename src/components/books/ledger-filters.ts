export type LedgerFilterState = {
  fromDate: string;
  toDate: string;
  accountIds: string[];
  amountMin: string;
  amountMax: string;
  createdBy: string;
  postedBy: string;
  tags: string[];
  hasAttachment: "" | "yes" | "no";
  voucherTypes: string[];
};

export const EMPTY_LEDGER_FILTERS: LedgerFilterState = {
  fromDate: "",
  toDate: "",
  accountIds: [],
  amountMin: "",
  amountMax: "",
  createdBy: "",
  postedBy: "",
  tags: [],
  hasAttachment: "",
  voucherTypes: [],
};

export const VOUCHER_TYPE_FILTERS = [
  "Sales",
  "Purchase",
  "Receipt",
  "Payment",
  "Contra",
  "Journal",
  "Credit Note",
  "Debit Note",
  "Opening",
  "Closing",
  "Expense",
] as const;

export type SavedViewConfig = {
  search?: string;
  types?: string[];
  statuses?: string[];
  filters?: LedgerFilterState;
};

export const ENTRY_TYPES = ["manual", "auto", "closing", "opening", "reversal"] as const;
export const ENTRY_STATUSES = ["posted", "draft", "scheduled", "reversed", "blocked"] as const;

export function buildJournalsQuery(
  periodId: string,
  search: string,
  types: string[],
  statuses: string[],
  filters: LedgerFilterState,
): string {
  const p = new URLSearchParams();
  p.set("periodId", periodId);
  const q = search.trim();
  if (q) p.set("q", q);
  if (types.length) p.set("entryType", types.join(","));
  if (statuses.length) p.set("status", statuses.join(","));
  if (filters.voucherTypes.length) p.set("voucherType", filters.voucherTypes.join(","));
  if (filters.fromDate) p.set("fromDate", filters.fromDate);
  if (filters.toDate) p.set("toDate", filters.toDate);
  if (filters.accountIds.length) p.set("accountIds", filters.accountIds.join(","));
  if (filters.tags.length) p.set("tags", filters.tags.join(","));
  if (filters.createdBy) p.set("createdBy", filters.createdBy);
  if (filters.postedBy) p.set("postedBy", filters.postedBy);
  if (filters.amountMin) {
    const minor = Math.round(Number(filters.amountMin) * 100);
    if (Number.isFinite(minor)) p.set("amountMinMinor", String(minor));
  }
  if (filters.amountMax) {
    const minor = Math.round(Number(filters.amountMax) * 100);
    if (Number.isFinite(minor)) p.set("amountMaxMinor", String(minor));
  }
  if (filters.hasAttachment === "yes") p.set("hasAttachment", "1");
  if (filters.hasAttachment === "no") p.set("hasAttachment", "0");
  return p.toString();
}
