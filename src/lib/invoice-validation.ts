/**
 * Invoice amount validation (fils). Grand total must equal Σ(net) + Σ(VAT).
 * INV-SYN-001 style: 100.00 + 5.00 VAT = 105.00 → no line_sum_mismatch.
 */

export type InvoiceLineAmounts = {
  netMinor: number;
  vatMinor?: number;
};

export type InvoiceValidationInput = {
  lines: InvoiceLineAmounts[];
  /** Document grand total in fils */
  grandTotalMinor: number;
  /** Optional explicit subtotal (Σ net); if omitted, derived from lines */
  subtotalMinor?: number;
};

export type InvoiceValidationResult = {
  flags: string[];
  subtotalMinor: number;
  vatTotalMinor: number;
  computedGrandMinor: number;
  fieldStatus: {
    grand_total: "ok" | "fail";
    subtotal: "ok" | "fail";
  };
};

export function validateInvoiceLineSum(input: InvoiceValidationInput): InvoiceValidationResult {
  const subtotalMinor =
    input.subtotalMinor != null
      ? input.subtotalMinor
      : input.lines.reduce((s, l) => s + (l.netMinor || 0), 0);
  const vatTotalMinor = input.lines.reduce((s, l) => s + (l.vatMinor || 0), 0);
  const computedGrandMinor = subtotalMinor + vatTotalMinor;
  const balanced = computedGrandMinor === input.grandTotalMinor;
  const flags = balanced ? [] : ["line_sum_mismatch"];
  return {
    flags,
    subtotalMinor,
    vatTotalMinor,
    computedGrandMinor,
    fieldStatus: {
      grand_total: balanced ? "ok" : "fail",
      subtotal: "ok",
    },
  };
}
