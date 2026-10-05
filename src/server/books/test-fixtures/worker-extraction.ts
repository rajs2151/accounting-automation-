/**
 * Test-only helpers that mimic the worker's books_extractions.fields_json shape
 * (value + source; money as integer fils). Not used at runtime.
 */

export type WorkerField = {
  value: string | number | null;
  confidence: number;
  status: string;
  source: { page: number; bbox: [number, number, number, number] } | null;
};

export function workerField(
  value: string | number | null,
  opts?: Partial<WorkerField>,
): WorkerField {
  const missing = value == null || value === "";
  return {
    value: missing ? null : value,
    confidence: opts?.confidence ?? (missing ? 0 : 0.95),
    status: opts?.status ?? (missing ? "missing" : "ok"),
    source:
      opts?.source === undefined
        ? missing
          ? null
          : { page: 1, bbox: [10, 10, 100, 20] }
        : opts.source,
  };
}

/** Minimal invoice fields_json as process_extract_document writes it. */
export function workerInvoiceFieldsJson(opts: {
  invoiceNo: string;
  invoiceDate?: string;
  netMinor?: number;
  vatMinor?: number;
  grossMinor?: number;
  currency?: string;
  supplierTrn?: string;
}): Record<string, WorkerField> {
  const net = opts.netMinor ?? 10000;
  const vat = opts.vatMinor ?? 500;
  const gross = opts.grossMinor ?? net + vat;
  return {
    invoice_no: workerField(opts.invoiceNo),
    document_number: workerField(opts.invoiceNo),
    invoice_date: workerField(opts.invoiceDate ?? "2026-05-15"),
    document_date: workerField(opts.invoiceDate ?? "2026-05-15"),
    currency: workerField(opts.currency ?? "AED"),
    supplier_trn: workerField(opts.supplierTrn ?? "100000000000001"),
    net: workerField(net),
    vat: workerField(vat),
    gross: workerField(gross),
    grand_total: workerField(gross),
  };
}
