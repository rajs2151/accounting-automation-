/**
 * Display-only VAT breakdown by code from invoice line items.
 * Does not compute or post VAT — only summarises codes present on the lines.
 */

import { formatMinor } from "@/lib/money";
import { vatCodeLabel } from "@/lib/vat";

export type VatByCodeLine = {
  vatCode: string;
  netMinor: number;
  vatMinor: number;
};

export type VatByCodeRow = {
  code: string;
  /** Short label from vat.ts, e.g. "SR 5%" */
  label: string;
  netMinor: number;
  vatMinor: number;
  /** e.g. "SR 5% on 100.00 = 5.00" */
  display: string;
};

/** Aggregate line nets/VAT by code; only codes that appear on lines. */
export function vatByCodeSummary(lines: VatByCodeLine[]): VatByCodeRow[] {
  const byCode = new Map<string, { netMinor: number; vatMinor: number }>();
  for (const line of lines) {
    const code = (line.vatCode || "").trim() || "—";
    const cur = byCode.get(code) || { netMinor: 0, vatMinor: 0 };
    cur.netMinor += Number(line.netMinor) || 0;
    cur.vatMinor += Number(line.vatMinor) || 0;
    byCode.set(code, cur);
  }
  return [...byCode.entries()].map(([code, sums]) => {
    const label = code === "—" ? "None" : vatCodeLabel(code);
    return {
      code,
      label,
      netMinor: sums.netMinor,
      vatMinor: sums.vatMinor,
      display: `${label} on ${formatMinor(sums.netMinor)} = ${formatMinor(sums.vatMinor)}`,
    };
  });
}
