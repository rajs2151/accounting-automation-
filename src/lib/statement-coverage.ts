/**
 * Merge statement periods and find calendar-day gaps (C2 coverage).
 * Periods are ISO dates YYYY-MM-DD inclusive.
 */

export type CoveragePeriod = { from: string; to: string };

export type CoverageResult = {
  coverageFrom: string | null;
  coverageTo: string | null;
  gaps: CoveragePeriod[];
};

function parseDay(iso: string): number {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`bad_date:${iso}`);
  return t;
}

function addDays(iso: string, days: number): string {
  const t = parseDay(iso) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function dayAfter(iso: string): string {
  return addDays(iso, 1);
}

function dayBefore(iso: string): string {
  return addDays(iso, -1);
}

/** Sort + merge overlapping/adjacent periods, then list gaps between merges. */
export function computeStatementCoverage(periods: CoveragePeriod[]): CoverageResult {
  const cleaned = periods
    .filter((p) => p.from && p.to && p.from <= p.to)
    .map((p) => ({ from: p.from.slice(0, 10), to: p.to.slice(0, 10) }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  if (!cleaned.length) {
    return { coverageFrom: null, coverageTo: null, gaps: [] };
  }

  const merged: CoveragePeriod[] = [];
  for (const p of cleaned) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...p });
      continue;
    }
    // Adjacent or overlapping: extend.
    if (p.from <= dayAfter(last.to)) {
      if (p.to > last.to) last.to = p.to;
    } else {
      merged.push({ ...p });
    }
  }

  const gaps: CoveragePeriod[] = [];
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1]!;
    const cur = merged[i]!;
    const gapFrom = dayAfter(prev.to);
    const gapTo = dayBefore(cur.from);
    if (gapFrom <= gapTo) gaps.push({ from: gapFrom, to: gapTo });
  }

  return {
    coverageFrom: merged[0]!.from,
    coverageTo: merged[merged.length - 1]!.to,
    gaps,
  };
}

export function normalizeIban(raw: string | null | undefined): string {
  return String(raw || "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
}

export function ibanLast4(iban: string | null | undefined): string | null {
  const n = normalizeIban(iban);
  if (n.length < 4) return null;
  return n.slice(-4);
}

export type BankInstrumentType = "bank" | "card" | "gateway" | "cash";

export function bankInstrumentType(row: {
  isBank?: boolean;
  isCard?: boolean;
  isGateway?: boolean;
  subType?: string | null;
}): BankInstrumentType {
  if (row.isGateway || row.subType === "gateway" || row.subType === "clearing") {
    return "gateway";
  }
  if (row.isCard || row.subType === "card") return "card";
  if (row.subType === "cash") return "cash";
  return "bank";
}

/** Setup gate: bank/card need IBAN (or last4 for card); cash/gateway need bank_name or code alone OK for cash. */
export function isBankAccountSetUp(row: {
  instrumentType: BankInstrumentType;
  bankName?: string | null;
  iban?: string | null;
  ibanLast4?: string | null;
}): boolean {
  const hasIban = Boolean(normalizeIban(row.iban) || row.ibanLast4?.trim());
  if (row.instrumentType === "cash") return true;
  if (row.instrumentType === "gateway") {
    return Boolean(row.bankName?.trim()) || hasIban;
  }
  // bank + card
  return hasIban;
}
