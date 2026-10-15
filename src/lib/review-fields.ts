/**
 * Map worker books_extractions.fields_json → review-form display fields.
 * Money stays integer fils in storage; UI shows AED with 2 decimals via formatMinor.
 * Dates: ISO yyyy-mm-dd → dd/mm/yyyy. Missing/null → "" with status "missing".
 */

import { formatMinor } from "@/lib/money";
import type { FieldSource } from "@/lib/review-bbox";

export type ReviewFieldState = {
  value: string;
  confidence: number;
  status?: string;
  /** Optional overlay box; callers may attach PageBBox later. */
  bbox?: unknown;
  /** Worker fields_json[*].source — page + PDF-point bbox, or null. */
  source?: FieldSource;
};

type RawField = {
  value?: unknown;
  confidence?: number;
  status?: string;
  bbox?: unknown;
  source?: FieldSource;
};

function asRawField(raw: unknown): RawField | null {
  if (raw == null) return null;
  if (typeof raw !== "object") return { value: raw };
  return raw as RawField;
}

function readSource(raw: RawField | null | undefined): FieldSource | undefined {
  if (!raw || !("source" in raw)) return undefined;
  const s = raw.source;
  if (s == null) return null;
  if (
    typeof s === "object" &&
    typeof (s as { page?: unknown }).page === "number" &&
    Array.isArray((s as { bbox?: unknown }).bbox)
  ) {
    return s as Exclude<FieldSource, null>;
  }
  return null;
}

/** ISO yyyy-mm-dd → dd/mm/yyyy; empty/invalid → "". Never returns "—". */
export function isoDateToDisplay(value: unknown): string {
  if (value == null || value === "") return "";
  const s = String(value).trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;
  const raw = s.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function missingField(raw: RawField | null): ReviewFieldState {
  return {
    value: "",
    confidence: Number(raw?.confidence ?? 0),
    status: "missing",
    bbox: raw?.bbox,
    source: readSource(raw),
  };
}

/**
 * Integer fils → "100.00". Prefer worker raw; fall back to legacy display string.
 * Null/empty → "" + status missing (never invents 0).
 */
function moneyToDisplay(worker: RawField | null, legacy: RawField | null): ReviewFieldState | null {
  if (worker) {
    const v = worker.value;
    if (v == null || v === "") return missingField(worker);
    if (typeof v === "number" && Number.isInteger(v)) {
      return {
        value: formatMinor(v),
        confidence: Number(worker.confidence ?? 0.5),
        status: worker.status ?? "ok",
        bbox: worker.bbox,
        source: readSource(worker),
      };
    }
  }
  if (legacy) {
    const v = legacy.value;
    if (v == null || v === "") return missingField(legacy);
    if (typeof v === "string") {
      return {
        value: v,
        confidence: Number(legacy.confidence ?? 0.5),
        status: legacy.status ?? "ok",
        bbox: legacy.bbox,
        source: readSource(legacy),
      };
    }
    if (typeof v === "number" && Number.isInteger(v)) {
      return {
        value: formatMinor(v),
        confidence: Number(legacy.confidence ?? 0.5),
        status: legacy.status ?? "ok",
        bbox: legacy.bbox,
        source: readSource(legacy),
      };
    }
  }
  return null;
}

function dateToDisplay(raw: RawField | null): ReviewFieldState | null {
  if (!raw) return null;
  const v = raw.value;
  if (v == null || v === "") return missingField(raw);
  const display = isoDateToDisplay(v);
  if (!display) return missingField(raw);
  return {
    value: display,
    confidence: Number(raw.confidence ?? 0.5),
    status: raw.status ?? "ok",
    bbox: raw.bbox,
    source: readSource(raw),
  };
}

function passThrough(key: string, raw: RawField): ReviewFieldState {
  const v = raw.value;
  if (v == null || v === "") return missingField(raw);
  if (
    (key === "net" || key === "vat" || key === "gross" || key === "grand_total") &&
    typeof v === "number" &&
    Number.isInteger(v)
  ) {
    return {
      value: formatMinor(v),
      confidence: Number(raw.confidence ?? 0.5),
      status: raw.status ?? "ok",
      bbox: raw.bbox,
      source: readSource(raw),
    };
  }
  return {
    value: String(v),
    confidence: Number(raw.confidence ?? 0.5),
    status: raw.status,
    bbox: raw.bbox,
    source: readSource(raw),
  };
}

/**
 * Convert worker (or legacy) fields_json into the review form's display keys.
 * Display money keys: subtotal / vat_total / grand_total (AED strings).
 * Worker money keys: net / vat / gross; grand_total fils is fallback when gross missing.
 * Legacy subtotal / vat_total / string grand_total used only when worker keys absent.
 */
export function mapWorkerFieldsToDisplay(
  raw: Record<string, unknown> | null | undefined,
): Record<string, ReviewFieldState> {
  const src = raw || {};
  const out: Record<string, ReviewFieldState> = {};

  const net = asRawField(src.net);
  const vat = asRawField(src.vat);
  const gross = asRawField(src.gross);
  const grand = asRawField(src.grand_total);
  const legacySub = asRawField(src.subtotal);
  const legacyVat = asRawField(src.vat_total);

  // Prefer worker net/vat; legacy display strings only as fallback.
  const hasWorkerNet = src.net !== undefined;
  const hasWorkerVat = src.vat !== undefined;
  const hasWorkerGross = src.gross !== undefined;
  const hasWorkerGrand = src.grand_total !== undefined;

  if (hasWorkerNet || src.subtotal !== undefined) {
    const mapped = moneyToDisplay(hasWorkerNet ? net : null, legacySub);
    if (mapped) out.subtotal = mapped;
  }

  if (hasWorkerVat || src.vat_total !== undefined) {
    const mapped = moneyToDisplay(hasWorkerVat ? vat : null, legacyVat);
    if (mapped) out.vat_total = mapped;
  }

  // Grand: prefer gross fils, then grand_total fils, then legacy string on grand_total.
  if (hasWorkerGross || hasWorkerGrand) {
    const fromGross = hasWorkerGross ? moneyToDisplay(gross, null) : null;
    if (fromGross && fromGross.value !== "") {
      out.grand_total = fromGross;
    } else if (hasWorkerGrand) {
      const gVal = grand?.value;
      if (gVal == null || gVal === "") {
        out.grand_total = missingField(grand);
      } else if (typeof gVal === "number" && Number.isInteger(gVal)) {
        out.grand_total = {
          value: formatMinor(gVal),
          confidence: Number(grand?.confidence ?? 0.5),
          status: grand?.status ?? "ok",
          bbox: grand?.bbox,
          source: readSource(grand),
        };
      } else if (typeof gVal === "string") {
        // Legacy string grand_total (e.g. "105.00")
        out.grand_total = {
          value: gVal,
          confidence: Number(grand?.confidence ?? 0.5),
          status: grand?.status ?? "ok",
          bbox: grand?.bbox,
          source: readSource(grand),
        };
      } else {
        out.grand_total = missingField(grand);
      }
    } else if (fromGross) {
      out.grand_total = fromGross;
    }
  }

  const invDate =
    dateToDisplay(asRawField(src.invoice_date)) ||
    dateToDisplay(asRawField(src.document_date));
  if (invDate) out.invoice_date = invDate;

  const due = dateToDisplay(asRawField(src.due_date));
  if (due) out.due_date = due;

  if (src.supplier_name !== undefined) {
    out.supplier_name = passThrough("supplier_name", asRawField(src.supplier_name)!);
  } else if (src.issuer_name !== undefined) {
    out.supplier_name = passThrough("issuer_name", asRawField(src.issuer_name)!);
  }

  if (src.invoice_no !== undefined) {
    out.invoice_no = passThrough("invoice_no", asRawField(src.invoice_no)!);
  } else if (src.document_number !== undefined) {
    out.invoice_no = passThrough("document_number", asRawField(src.document_number)!);
  }

  const skip = new Set([
    "net",
    "vat",
    "gross",
    "grand_total",
    "subtotal",
    "vat_total",
    "invoice_date",
    "document_date",
    "due_date",
    "supplier_name",
    "issuer_name",
    "invoice_no",
    "document_number",
    "lines",
    "_line_items",
  ]);

  for (const [k, v] of Object.entries(src)) {
    if (skip.has(k) || out[k]) continue;
    const f = asRawField(v);
    if (!f || !("value" in f)) continue;
    out[k] = passThrough(k, f);
  }

  return out;
}
