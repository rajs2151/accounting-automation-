"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DocumentReviewPanels } from "@/components/books/document-review-panels";
import { PdfPagePreview } from "@/components/books/pdf-page-preview";
import { useBooksShell } from "@/components/books/books-shell-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";
import { displayToMinor, formatMinor } from "@/lib/money";
import type { PageBBox } from "@/lib/review-bbox";
import { validateInvoiceLineSum } from "@/lib/invoice-validation";
import {
  mapWorkerFieldsToDisplay,
  type ReviewFieldState,
} from "@/lib/review-fields";

type FieldState = ReviewFieldState & { bbox?: PageBBox };

type ReviewPayload = {
  id: string;
  filename: string;
  sha256: string;
  status: string;
  error: string | null;
  fileUrl: string;
  extractionId: string | null;
  documentId: string | null;
  fieldsJson: Record<string, unknown>;
  lineItems: Array<{
    description?: string;
    vatCode?: string;
    netMinor?: number;
    vatMinor?: number;
    amount_minor?: number;
  }>;
  validationFlags: string[];
};

const LABELS: Record<string, string> = {
  doc_type: "Document type",
  company_match: "Company match",
  supplier_name: "Supplier",
  customer_name: "Customer",
  supplier_trn: "Supplier TRN",
  customer_trn: "Customer TRN",
  invoice_no: "Invoice no",
  invoice_date: "Invoice date",
  due_date: "Due date",
  currency: "Currency",
  subtotal: "Subtotal",
  vat_total: "VAT",
  grand_total: "Grand total",
};

const FIELD_ORDER = [
  "doc_type",
  "company_match",
  "supplier_name",
  "customer_name",
  "supplier_trn",
  "customer_trn",
  "invoice_no",
  "invoice_date",
  "due_date",
  "currency",
  "subtotal",
  "vat_total",
  "grand_total",
] as const;

function normalizeFields(raw: Record<string, unknown>): Record<string, FieldState> {
  return mapWorkerFieldsToDisplay(raw) as Record<string, FieldState>;
}

function moneyMinorFromDisplay(value: string | undefined): number | null {
  if (value == null || !value.trim()) return null;
  try {
    return displayToMinor(value.replace(/,/g, ""));
  } catch {
    return null;
  }
}

function normalizeLines(items: ReviewPayload["lineItems"]) {
  return (items || []).map((l, i) => ({
    description: l.description || `Line ${i + 1}`,
    vatCode: l.vatCode || "SR",
    netMinor: Number(l.netMinor ?? l.amount_minor ?? 0),
    vatMinor: Number(l.vatMinor ?? 0),
  }));
}

/** Split-view review: uploaded file page 1 + fields from books_extractions for this inbox id. */
export default function InboxReviewPage() {
  const params = useParams<{ id: string }>();
  const { periodId } = useBooksShell();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const [lineItems, setLineItems] = useState<
    Array<{ description: string; vatCode: string; netMinor: number; vatMinor: number }>
  >([]);
  const [activeField, setActiveField] = useState<string | null>("invoice_no");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [parties, setParties] = useState<Array<{ id: string; name: string }>>([]);
  const [partyId, setPartyId] = useState("");

  async function load(opts?: { quiet?: boolean }) {
    if (!opts?.quiet) {
      setLoading(true);
      setError("");
    }
    const res = await fetch(`/api/books/inbox/${params.id}`);
    const data = await res.json();
    if (res.status === 404) {
      setError("Inbox item not found");
      setReview(null);
      setLoading(false);
      return;
    }
    if (!res.ok) {
      setError(apiErrorMessage(data, "Could not load this document."));
      setLoading(false);
      return;
    }
    setReview(data as ReviewPayload);
    setFields(normalizeFields((data.fieldsJson || {}) as Record<string, unknown>));
    setLineItems(normalizeLines(data.lineItems || []));
    setDocumentId(data.documentId || null);
    setLoading(false);
  }

  useEffect(() => {
    void load();
    void fetch("/api/books/parties")
      .then((r) => r.json())
      .then((pts) => {
        if (Array.isArray(pts) && pts.length) {
          setParties(pts);
          setPartyId((prev) => prev || pts[0].id);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  // Poll while the worker is still extracting (Queued → Extracting → done).
  useEffect(() => {
    if (!review) return;
    if (review.status !== "queued" && review.status !== "extracting") return;
    const timer = setInterval(() => {
      void load({ quiet: true });
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.status, params.id]);

  async function confirmFields() {
    if (!partyId || !periodId) {
      toast.error(apiErrorMessage({ error: "party_and_period_required" }));
      return;
    }
    const res = await fetch(`/api/books/inbox/${params.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partyId, periodId, docType: "sales_invoice" }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Draft document created");
    setDocumentId(String(data.documentId));
    void load();
  }

  async function retry() {
    const res = await fetch(`/api/books/inbox/${params.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Extraction retried");
    void load();
  }

  function onFieldChange(key: string, value: string) {
    setFields((prev) => {
      const next = { ...prev, [key]: { ...prev[key], value } };
      if (key === "grand_total" || key === "subtotal" || key === "vat_total") {
        const subtotal = moneyMinorFromDisplay(next.subtotal?.value);
        const vat = moneyMinorFromDisplay(next.vat_total?.value);
        const grand = moneyMinorFromDisplay(next.grand_total?.value);
        if (subtotal != null && vat != null && grand != null && next.grand_total) {
          const v = validateInvoiceLineSum({
            lines: [{ netMinor: subtotal, vatMinor: vat }],
            grandTotalMinor: grand,
          });
          next.grand_total = { ...next.grand_total, status: v.fieldStatus.grand_total };
        }
      }
      return next;
    });
  }

  const flags = (() => {
    const subtotal = moneyMinorFromDisplay(fields.subtotal?.value);
    const vat = moneyMinorFromDisplay(fields.vat_total?.value);
    const grand = moneyMinorFromDisplay(fields.grand_total?.value);
    if (subtotal == null || vat == null || grand == null) {
      return (review?.validationFlags as string[]) || [];
    }
    return validateInvoiceLineSum({
      lines: [{ netMinor: subtotal, vatMinor: vat }],
      grandTotalMinor: grand,
    }).flags;
  })();

  const boxes = Object.values(fields)
    .map((f) => f.bbox)
    .filter(Boolean) as PageBBox[];

  const fieldStatus = Object.fromEntries(
    Object.entries(fields).map(([k, f]) => [k, { status: f.status, confidence: f.confidence }]),
  );

  if (loading) {
    return (
      <div className="space-y-4 py-4" data-testid="review-split-view">
        <h1 className="text-2xl font-semibold">Review extraction</h1>
        <p className="text-sm text-muted-foreground" data-testid="review-extracting">
          Extracting…
        </p>
      </div>
    );
  }

  if (error || !review) {
    return (
      <div className="space-y-4 py-4" data-testid="review-split-view">
        <h1 className="text-2xl font-semibold">Review extraction</h1>
        <p className="text-sm text-red-600" data-testid="review-error">
          {error || "Not found"}
        </p>
        <Link href="/books/inbox" className="text-sm text-primary underline">
          Back to inbox
        </Link>
      </div>
    );
  }

  if (review.status === "queued" || review.status === "extracting") {
    return (
      <div className="space-y-4 py-4" data-testid="review-split-view">
        <h1 className="text-2xl font-semibold">Review extraction</h1>
        <p className="text-sm text-muted-foreground" data-testid="review-extracting">
          Extracting… status={review.status}
        </p>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
    );
  }

  if (review.status === "failed" && !review.extractionId) {
    return (
      <div className="space-y-4 py-4" data-testid="review-split-view">
        <h1 className="text-2xl font-semibold">Review extraction</h1>
        <p className="text-sm text-red-600" data-testid="review-failed">
          Failed: {review.error || "extraction_failed"}
        </p>
        <Button data-testid="review-retry" onClick={() => void retry()}>
          Retry extract
        </Button>
      </div>
    );
  }

  if (!review.extractionId) {
    return (
      <div className="space-y-4 py-4" data-testid="review-split-view">
        <h1 className="text-2xl font-semibold">Review extraction</h1>
        <p className="text-sm text-muted-foreground">No extraction row yet for this inbox item.</p>
        <Button data-testid="review-retry" onClick={() => void retry()}>
          Retry extract
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 py-4" data-testid="review-split-view">
      <h1 className="text-2xl font-semibold">Review extraction</h1>
      {flags.length ? (
        <p className="text-sm text-red-600" data-testid="validation-flags">
          Flags: {flags.join(", ")}
        </p>
      ) : (
        <p className="text-sm text-emerald-700" data-testid="validation-flags">
          Amounts balanced (subtotal + VAT = grand total)
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <PdfPagePreview
            fileUrl={review.fileUrl}
            boxes={boxes}
            activeLabel={activeField}
            fieldStatus={fieldStatus}
            onSelectField={setActiveField}
          />
          <p className="mt-1 text-xs text-muted-foreground" data-testid="review-file-meta">
            File: {review.filename} · sha256 {String(review.sha256).slice(0, 12)}… · Inbox{" "}
            {params.id}
          </p>
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4">
          {FIELD_ORDER.map((key) => {
            const field = fields[key];
            if (!field) return null;
            const low = (field.confidence ?? 1) < 0.8;
            const bad = field.status === "fail";
            return (
              <div key={key}>
                <Label className="text-xs font-medium text-muted-foreground">
                  {LABELS[key] || key}
                  {low || bad ? (
                    <span className={bad ? "ml-2 text-red-600" : "ml-2 text-amber-600"}>
                      {bad ? "fail" : "low confidence"}
                    </span>
                  ) : null}
                </Label>
                <Input
                  data-testid={`field-${key}`}
                  className={bad ? "border-red-500" : low ? "border-amber-500" : undefined}
                  value={field.value}
                  onFocus={() => setActiveField(key)}
                  onChange={(e) => onFieldChange(key, e.target.value)}
                />
              </div>
            );
          })}

          <div>
            <Label className="text-xs font-medium text-muted-foreground">Line items</Label>
            <table className="mt-1 w-full text-sm" data-testid="review-line-items">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">Description</th>
                  <th>VAT</th>
                  <th className="text-right">Net</th>
                  <th className="text-right">VAT amt</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((l) => (
                  <tr key={l.description} className="border-t border-border">
                    <td className="py-1">{l.description}</td>
                    <td>{l.vatCode}</td>
                    <td className="text-right tabular-nums">{formatMinor(l.netMinor)}</td>
                    <td className="text-right tabular-nums">{formatMinor(l.vatMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-2 pt-2">
            {!documentId ? (
              <div>
                <Label className="text-xs">Party for draft</Label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={partyId}
                  onChange={(e) => setPartyId(e.target.value)}
                  data-testid="confirm-party"
                >
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void retry()} data-testid="review-retry">
                Retry extract
              </Button>
              <Button
                variant="outline"
                onClick={() => toast.success("Saved as profile (stub)")}
              >
                Save as profile
              </Button>
              {!documentId ? (
                <Button onClick={() => void confirmFields()} data-testid="confirm-fields">
                  Confirm fields
                </Button>
              ) : null}
              <Link
                className="inline-flex h-8 items-center text-sm text-primary underline"
                href="/books/statements"
              >
                Statement review
              </Link>
            </div>
          </div>

          {documentId ? (
            <div className="border-t border-border pt-3">
              <DocumentReviewPanels documentId={documentId} onApproved={() => void load()} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
