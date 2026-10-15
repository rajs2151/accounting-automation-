"use client";

import { ChevronLeft, ChevronRight, Info, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DocumentReviewPanels } from "@/components/books/document-review-panels";
import { PdfPagePreview } from "@/components/books/pdf-page-preview";
import { ReviewReadField } from "@/components/books/review-read-field";
import { StatusBadge } from "@/components/books/status-badge";
import { TracePanel } from "@/components/books/trace-panel";
import { useBooksShell } from "@/components/books/books-shell-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiErrorMessage } from "@/lib/api-error";
import { displayToMinor, formatMinor } from "@/lib/money";
import type { FieldSource, PageBBox } from "@/lib/review-bbox";
import { boxesFromFieldSources } from "@/lib/review-bbox";
import { fieldConfidenceTone } from "@/lib/review-confidence";
import {
  mapWorkerFieldsToDisplay,
  type ReviewFieldState,
} from "@/lib/review-fields";
import { normalizeReviewLines, REVIEW_EMPTY_FIELD } from "@/lib/review-lines";
import { partyMismatchDiffs } from "@/lib/party-mismatch";
import { prevNextInReviewQueue, reviewQueuePositionLabel } from "@/lib/review-queue-nav";
import { validateInvoiceLineSum } from "@/lib/invoice-validation";
import { docTypeLabel, inboxStatusLabel } from "@/lib/status-labels";
import { splitValidationFlags } from "@/lib/validation-flag-labels";
import { vatByCodeSummary } from "@/lib/vat-by-code";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SPLITTER_KEY = "arnibooks.review.previewPct";
const DEFAULT_PREVIEW_PCT = 45;
const MIN_PREVIEW_PCT = 30;
const MAX_PREVIEW_PCT = 70;

const FLAG_FIELD_HINT: Record<string, string> = {
  company_not_on_invoice: "company_match",
  company_side_unknown: "company_match",
  company_mismatch: "company_match",
  low_confidence_classification: "doc_type",
  no_rule_match: "doc_type",
  unassigned: "supplier_name",
  totals_mismatch: "grand_total",
};

type FieldState = ReviewFieldState & { bbox?: PageBBox; source?: FieldSource };

type ReviewPayload = {
  id: string;
  filename: string;
  sha256: string;
  status: string;
  error: string | null;
  fileUrl: string;
  extractionId: string | null;
  documentId: string | null;
  detectedType?: string | null;
  parentInboxItemId?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
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

type InboxListRow = {
  id: string;
  status: string;
  createdAt?: string;
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

const DOCUMENT_FIELDS = ["doc_type", "invoice_no", "invoice_date", "due_date", "currency"] as const;
const PARTY_FIELDS = [
  "company_match",
  "supplier_name",
  "customer_name",
  "supplier_trn",
  "customer_trn",
] as const;
const AMOUNT_FIELDS = ["subtotal", "vat_total", "grand_total"] as const;

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

const EMPTY_FIELD = REVIEW_EMPTY_FIELD;

function normalizeLines(items: ReviewPayload["lineItems"]) {
  return normalizeReviewLines(items);
}

const REVIEW_VAT_CODES = ["SR", "ZR", "EX", "OOS"] as const;

function FieldGroup({
  eyebrow,
  keys,
  fields,
  activeField,
  setActiveField,
  onFieldChange,
}: {
  eyebrow: string;
  keys: readonly string[];
  fields: Record<string, FieldState>;
  activeField: string | null;
  setActiveField: (k: string | null) => void;
  onFieldChange: (key: string, value: string) => void;
}) {
  const present = keys.filter((k) => fields[k]);
  if (!present.length) return null;
  return (
    <div className="space-y-2">
      {eyebrow ? (
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          {eyebrow}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-2 min-[1600px]:grid-cols-3">
        {present.map((key) => {
          const field = fields[key]!;
          const tone = fieldConfidenceTone({ fieldConfidence: field.confidence });
          return (
            <ReviewReadField
              key={key}
              name={key}
              label={LABELS[key] || key}
              value={field.value}
              status={field.status}
              confidenceTone={tone}
              locationMissing={field.source === null}
              onChange={(v) => onFieldChange(key, v)}
              onActivate={() => setActiveField(key)}
              onDeactivate={() => {
                if (activeField === key) setActiveField(null);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function ReviewCard({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid={testId}
    >
      <h2 className="text-sm font-semibold tracking-wide text-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** Split-view review: uploaded file pages + read-first fields (UI-3). */
export default function InboxReviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { periodId, setSidebarCollapsed } = useBooksShell();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const [lineItems, setLineItems] = useState<
    Array<{
      description: string;
      vatCode: string;
      netMinor: number | null;
      vatMinor: number | null;
    }>
  >([]);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [parties, setParties] = useState<Array<{ id: string; name: string; trn: string | null }>>(
    [],
  );
  const [partyId, setPartyId] = useState("");
  const [lineMode, setLineMode] = useState<"item" | "accounting">("item");
  const [newSupplier, setNewSupplier] = useState(false);
  const [mismatchKeep, setMismatchKeep] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [pageSizes, setPageSizes] = useState<Record<number, { width: number; height: number }>>(
    {},
  );
  const [previewPct, setPreviewPct] = useState(DEFAULT_PREVIEW_PCT);
  const [wideLayout, setWideLayout] = useState(false);
  const [sideTab, setSideTab] = useState<"fields" | "trace">("fields");
  const splitRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SPLITTER_KEY);
      if (!raw) return;
      const n = Number(raw);
      if (Number.isFinite(n) && n >= MIN_PREVIEW_PCT && n <= MAX_PREVIEW_PCT) {
        setPreviewPct(n);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    setSidebarCollapsed(true);
    return () => setSidebarCollapsed(false);
  }, [setSidebarCollapsed]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWideLayout(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const onSplitterPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onSplitterPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current || !splitRef.current) return;
    const rect = splitRef.current.getBoundingClientRect();
    if (rect.width < 1) return;
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    const clamped = Math.min(MAX_PREVIEW_PCT, Math.max(MIN_PREVIEW_PCT, pct));
    setPreviewPct(clamped);
  }, []);

  const onSplitterPointerUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      localStorage.setItem(SPLITTER_KEY, String(Math.round(previewPct)));
    } catch {
      /* ignore */
    }
  }, [previewPct]);
  const [queue, setQueue] = useState<InboxListRow[]>([]);

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
          setParties(
            pts.map((p: { id: string; name: string; trn?: string | null }) => ({
              id: p.id,
              name: p.name,
              trn: p.trn ?? null,
            })),
          );
          setPartyId((prev) => prev || pts[0].id);
        }
      });
    void fetch("/api/books/inbox")
      .then((r) => r.json())
      .then((rows) => {
        if (Array.isArray(rows)) {
          setQueue(
            rows.map((r: { id: string; status: string; createdAt?: string }) => ({
              id: r.id,
              status: r.status,
              createdAt: r.createdAt,
            })),
          );
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  // New-supplier badge: no fuzzy match on extracted supplier name/TRN.
  useEffect(() => {
    const name = fields.supplier_name?.value?.trim();
    const trn = fields.supplier_trn?.value?.trim() || null;
    if (!name) {
      setNewSupplier(false);
      return;
    }
    let cancelled = false;
    void fetch("/api/books/parties/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partyType: "supplier", name, trn }),
    })
      .then((r) => r.json())
      .then((suggestions) => {
        if (cancelled) return;
        setNewSupplier(Array.isArray(suggestions) && suggestions.length === 0);
      })
      .catch(() => {
        if (!cancelled) setNewSupplier(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fields.supplier_name?.value, fields.supplier_trn?.value]);

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

  const nav = useMemo(
    () => prevNextInReviewQueue(queue, String(params.id)),
    [queue, params.id],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void approveAndNext();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;

      const goPrev = e.key === "k" || e.key === "K" || (e.altKey && e.key === "ArrowLeft");
      const goNext = e.key === "j" || e.key === "J" || (e.altKey && e.key === "ArrowRight");
      if (goPrev && nav.prevId) {
        e.preventDefault();
        router.push(`/books/inbox/${nav.prevId}`);
      } else if (goNext && nav.nextId) {
        e.preventDefault();
        router.push(`/books/inbox/${nav.nextId}`);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.prevId, nav.nextId, router, documentId, partyId, periodId, lineItems]);

  function resolveConfirmDocType(): "sales_invoice" | "purchase_bill" {
    const raw = String(review?.detectedType || fields.doc_type?.value || "").toLowerCase();
    if (raw === "purchase_bill" || raw.includes("purchase") || raw.includes("bill")) {
      return "purchase_bill";
    }
    return "sales_invoice";
  }

  async function confirmFields(): Promise<string | null> {
    if (documentId) return documentId;
    if (!partyId || !periodId) {
      toast.error(apiErrorMessage({ error: "party_and_period_required" }));
      return null;
    }
    const missingVat = lineItems.filter((l) => !l.vatCode?.trim());
    if (missingVat.length) {
      toast.error("Pick a VAT code for every line before confirm (do not assume 5%).");
      return null;
    }
    if (lineItems.some((l) => l.netMinor == null)) {
      toast.error("Enter a net amount for every line before confirm.");
      return null;
    }
    const res = await fetch(`/api/books/inbox/${params.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        partyId,
        periodId,
        docType: resolveConfirmDocType(),
        lines: lineItems.map((l) => ({
          description: l.description || "Line",
          vatCode: l.vatCode || null,
          netMinor: l.netMinor,
          vatMinor: l.vatMinor ?? 0,
        })),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return null;
    }
    toast.success("Draft document created");
    const id = String(data.documentId);
    setDocumentId(id);
    void load();
    return id;
  }

  async function approveAndNext() {
    const docId = await confirmFields();
    if (!docId) return;
    const res = await fetch(`/api/books/documents/${docId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data, "approve_failed"));
      void load();
      return;
    }
    toast.success(data.entryNo ? `Posted ${data.entryNo}` : "Posted");
    if (nav.nextId) {
      router.push(`/books/inbox/${nav.nextId}`);
    } else {
      toast.success("Queue complete");
      void load();
    }
  }

  async function updatePartyFromExtraction() {
    const master = parties.find((p) => p.id === partyId);
    if (!master) return;
    const name = fields.supplier_name?.value?.trim() || fields.customer_name?.value?.trim();
    const trn = fields.supplier_trn?.value?.trim() || fields.customer_trn?.value?.trim() || null;
    const res = await fetch(`/api/books/parties/${partyId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name || master.name,
        trn,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Party master updated from extraction");
    setParties((prev) =>
      prev.map((p) =>
        p.id === partyId ? { ...p, name: name || p.name, trn: trn } : p,
      ),
    );
    setMismatchKeep(false);
  }

  async function retry() {
    // Keep the page on an extracting shell immediately — do not flip `loading`
    // (that blanked the whole review view and felt frozen).
    setReview((prev) =>
      prev ? { ...prev, status: "queued", error: null, extractionId: prev.extractionId } : prev,
    );
    const res = await fetch(`/api/books/inbox/${params.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      void load({ quiet: true });
      return;
    }
    toast.success("Extraction queued — this page will update when it finishes");
    void load({ quiet: true });
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

  const balance = (() => {
    const subtotal = moneyMinorFromDisplay(fields.subtotal?.value);
    const vat = moneyMinorFromDisplay(fields.vat_total?.value);
    const grand = moneyMinorFromDisplay(fields.grand_total?.value);
    if (subtotal == null || vat == null || grand == null) {
      const flags = (review?.validationFlags as string[]) || [];
      return {
        flags,
        subtotalMinor: subtotal,
        vatTotalMinor: vat,
        grandTotalMinor: grand,
        offByMinor: null as number | null,
        // Missing totals are incomplete — never show Balanced or Off by 0.00.
        balanced: null as boolean | null,
      };
    }
    const v = validateInvoiceLineSum({
      lines: [{ netMinor: subtotal, vatMinor: vat }],
      grandTotalMinor: grand,
    });
    return {
      flags: v.flags,
      subtotalMinor: subtotal,
      vatTotalMinor: vat,
      grandTotalMinor: grand,
      offByMinor: v.computedGrandMinor - grand,
      balanced: v.flags.length === 0,
    };
  })();

  const flags = balance.flags;
  const boxes = boxesFromFieldSources(fields, pageSizes);
  const focusPage =
    (activeField && fields[activeField]?.source?.page
      ? Number(fields[activeField].source!.page)
      : null) ??
    (review?.pageStart != null ? Number(review.pageStart) : null);
  const pageCount = Object.keys(pageSizes).length;
  const canSplitByPages =
    Boolean(review) &&
    !review?.parentInboxItemId &&
    pageCount >= 2 &&
    ["needs_review", "ready", "review_later"].includes(String(review?.status || ""));
  async function splitByPages() {
    if (!review || pageCount < 2) return;
    setSplitting(true);
    try {
      const ranges = Array.from({ length: pageCount }, (_, i) => ({
        pageStart: i + 1,
        pageEnd: i + 1,
      }));
      const res = await fetch(`/api/books/inbox/${params.id}/split-pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ranges, pageCount }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        children?: Array<{ id: string }>;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        toast.error(apiErrorMessage(data) || "Split failed");
        return;
      }
      const first = data.children?.[0]?.id;
      toast.success(`Split into ${data.children?.length ?? 0} snippets`);
      if (first) router.push(`/books/inbox/${first}`);
      else window.location.href = "/books/inbox?tab=needs_review";
    } finally {
      setSplitting(false);
    }
  }
  const fieldStatus = Object.fromEntries(
    Object.entries(fields).map(([k, f]) => [k, { status: f.status, confidence: f.confidence }]),
  );
  const vatRows = vatByCodeSummary(
    lineItems
      .filter((l) => l.netMinor != null)
      .map((l) => ({
        vatCode: l.vatCode,
        netMinor: l.netMinor as number,
        vatMinor: l.vatMinor ?? 0,
      })),
  );
  const docType =
    review?.detectedType ||
    fields.doc_type?.value ||
    "sales_invoice";
  const statusMeta = inboxStatusLabel(review?.status || "needs_review");
  const typeMeta = docTypeLabel(docType);
  const queueKind: "bill" | "invoice" =
    String(docType).toLowerCase().includes("purchase") ||
    String(docType).toLowerCase().includes("bill")
      ? "bill"
      : "invoice";
  const queueLabel = reviewQueuePositionLabel(queueKind, nav.index, nav.total);
  const selectedParty = parties.find((p) => p.id === partyId) || null;
  const extractedParty = {
    name: fields.supplier_name?.value || fields.customer_name?.value || null,
    trn: fields.supplier_trn?.value || fields.customer_trn?.value || null,
  };
  const mismatchDiffs =
    !mismatchKeep && !documentId
      ? partyMismatchDiffs(extractedParty, selectedParty)
      : [];

  if (loading && !review) {
    return (
      <div className="space-y-4 py-4" data-testid="review-split-view">
        <h1 className="text-2xl font-semibold">Review extraction</h1>
        <p className="text-sm text-muted-foreground" data-testid="review-loading">
          Loading document…
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
    const phaseLabel = review.status === "queued" ? "Queued" : "Extracting";
    const phaseHint =
      review.status === "queued"
        ? "Waiting for the worker to pick up this file."
        : "Reading the document and filling fields — usually under a minute.";
    return (
      <div className="flex h-[calc(100vh-3.5rem)] flex-col" data-testid="review-split-view">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              href="/books/inbox"
              className="text-sm text-muted-foreground underline-offset-2 hover:underline"
            >
              Inbox
            </Link>
            <span className="text-muted-foreground">/</span>
            <h1 className="truncate text-base font-semibold">Review extraction</h1>
            <StatusBadge meta={inboxStatusLabel(review.status)} data-testid="review-status-badge" />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load({ quiet: true })}>
            Refresh now
          </Button>
        </div>
        <div
          className="grid min-h-0 flex-1 gap-0 lg:grid-cols-2"
          data-testid="review-extracting"
        >
          <div className="min-h-0 overflow-auto border-b border-border p-3 lg:border-b-0 lg:border-r">
            {review.fileUrl ? (
              <PdfPagePreview
                className="h-full min-h-[320px]"
                fileUrl={review.fileUrl}
                boxes={[]}
                activeLabel={null}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Document preview unavailable.</p>
            )}
          </div>
          <div className="flex min-h-0 flex-col items-start justify-center gap-4 p-6">
            <div
              className="size-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
              aria-hidden
            />
            <div className="space-y-1">
              <p className="text-lg font-medium">{phaseLabel}</p>
              <p className="max-w-md text-sm text-muted-foreground">{phaseHint}</p>
              <p className="text-sm text-muted-foreground">
                File: <span className="text-foreground">{review.filename}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                This page refreshes automatically every few seconds. You can leave and come back from
                Inbox.
              </p>
            </div>
            <Link
              href="/books/inbox"
              className="text-sm text-primary underline underline-offset-2"
            >
              Back to inbox
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (review.status === "failed" && !review.extractionId) {
    return (
      <div className="space-y-4 py-4" data-testid="review-split-view">
        <h1 className="text-2xl font-semibold">Review extraction</h1>
        <p className="text-sm text-red-600" data-testid="review-failed">
          Extraction failed: {review.error || "unknown error"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="review-retry" onClick={() => void retry()}>
            Retry extract
          </Button>
          <Link
            href="/books/inbox"
            className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted"
          >
            Back to inbox
          </Link>
        </div>
      </div>
    );
  }

  if (!review.extractionId) {
    return (
      <div className="space-y-4 py-4" data-testid="review-split-view">
        <h1 className="text-2xl font-semibold">Review extraction</h1>
        <p className="text-sm text-muted-foreground">
          No extraction yet for <span className="font-medium text-foreground">{review.filename}</span>.
          Queue it again, or wait if it was just uploaded.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="review-retry" onClick={() => void retry()}>
            Retry extract
          </Button>
          <Link
            href="/books/inbox"
            className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted"
          >
            Back to inbox
          </Link>
        </div>
      </div>
    );
  }

  const activeChipLabel = activeField ? LABELS[activeField] || activeField : null;
  const activeChipValue = activeField ? fields[activeField]?.value ?? "" : null;
  const mergedFlagList = [
    ...((review.validationFlags as string[]) || []),
    ...flags,
  ];
  const displayFlags = splitValidationFlags(mergedFlagList);

  const flagCount = displayFlags.badges.length;
  const headerBar = (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Link
          href="/books/inbox"
          className="inline-flex h-8 items-center rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid="review-back"
        >
          ‹ Back
        </Link>
        <h1 className="max-w-[min(40vw,28rem)] truncate text-base font-semibold" title={review.filename}>
          {review.filename}
        </h1>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            data-testid="review-queue-prev"
            disabled={!nav.prevId}
            aria-label="Previous needs-review document"
            onClick={() => nav.prevId && router.push(`/books/inbox/${nav.prevId}`)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          {queueLabel ? (
            <span
              className="text-sm text-muted-foreground tabular-nums"
              data-testid="review-queue-position"
            >
              {queueLabel}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground" data-testid="review-queue-position">
              {typeMeta.label}
            </span>
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            data-testid="review-queue-next"
            disabled={!nav.nextId}
            aria-label="Next needs-review document"
            onClick={() => nav.nextId && router.push(`/books/inbox/${nav.nextId}`)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <StatusBadge meta={statusMeta} data-testid="review-status-badge" />
        {newSupplier ? (
          <StatusBadge
            meta={{ label: "New supplier", tone: "warning" }}
            data-testid="new-supplier-badge"
          />
        ) : null}
        {flagCount > 0 || displayFlags.technical.length ? (
          <Popover>
            <PopoverTrigger
              type="button"
              data-testid="validation-flags"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted"
            >
              <Info className="size-3.5" />
              {flagCount} thing{flagCount === 1 ? "" : "s"} to check
            </PopoverTrigger>
            <PopoverContent className="w-80" align="start">
              <ul className="space-y-1.5 text-sm" data-testid="flags-popover-list">
                {displayFlags.badges.map((b) => {
                  const fieldKey = FLAG_FIELD_HINT[b.key];
                  return (
                    <li key={b.key}>
                      <button
                        type="button"
                        className="text-start text-primary underline-offset-2 hover:underline"
                        data-testid={`flag-badge-${b.key}`}
                        onClick={() => {
                          if (fieldKey) setActiveField(fieldKey);
                        }}
                      >
                        {b.label}
                      </button>
                    </li>
                  );
                })}
                {displayFlags.technical.length ? (
                  <li
                    className="pt-1 font-mono text-[11px] text-muted-foreground"
                    data-testid="validation-flags-tech"
                  >
                    {displayFlags.technical.join(", ")}
                  </li>
                ) : null}
              </ul>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="text-sm text-emerald-700" data-testid="validation-flags">
            Amounts look balanced
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                data-testid="review-kebab"
                aria-label="More actions"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-testid="review-retry" onClick={() => void retry()}>
              Retry extract
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                toast.message("Discard keeps the file in storage; remove from the Uploads list later.");
                router.push("/books/inbox");
              }}
            >
              Discard
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="outline"
          onClick={() => void confirmFields()}
          data-testid="confirm-fields"
        >
          Save draft
        </Button>
        <Button
          variant="ghost"
          data-testid="review-later"
          onClick={() => {
            void fetch(`/api/books/inbox/${params.id}/review-later`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ later: true }),
            }).then((r) => {
              if (r.ok) window.location.href = "/books/inbox?tab=needs_review";
            });
          }}
        >
          Review later
        </Button>
        {canSplitByPages ? (
          <Button
            variant="outline"
            data-testid="split-by-pages"
            disabled={splitting}
            onClick={() => void splitByPages()}
          >
            {splitting ? "Splitting…" : "Split by pages"}
          </Button>
        ) : null}
        <Button onClick={() => void approveAndNext()} data-testid="review-approve-next">
          Approve &amp; next
        </Button>
      </div>
    </div>
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="review-split-view"
    >
      {headerBar}

      <div
        ref={splitRef}
        className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row"
        data-testid="review-workspace"
      >
        <div
          className="flex min-h-0 min-w-0 flex-col overflow-hidden max-lg:h-[60vh] max-lg:w-full max-lg:shrink-0"
          style={
            wideLayout
              ? { flexBasis: `${previewPct}%`, flexGrow: 0, flexShrink: 0 }
              : undefined
          }
          data-testid="review-preview-panel"
        >
          <div className="min-h-0 flex-1 p-2">
            <PdfPagePreview
              className="h-full"
              fileUrl={review.fileUrl}
              boxes={boxes}
              activeLabel={activeField}
              activeChipLabel={activeChipLabel}
              activeChipValue={activeChipValue}
              fieldStatus={fieldStatus}
              onSelectField={setActiveField}
              focusPage={focusPage}
              focusBBox={Boolean(activeField && fields[activeField!]?.source)}
              onPageMeta={(meta) => setPageSizes(meta.pageSizes)}
            />
          </div>
          <p className="shrink-0 truncate px-3 pb-1 text-xs text-muted-foreground" data-testid="review-file-meta">
            File: {review.filename} · sha256 {String(review.sha256).slice(0, 12)}… · Inbox {params.id}
            {review.pageStart != null && review.pageEnd != null
              ? ` · Pages ${review.pageStart}–${review.pageEnd}`
              : ""}
          </p>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={Math.round(previewPct)}
          data-testid="review-splitter"
          className={cn(
            "hidden shrink-0 cursor-col-resize touch-none bg-border hover:bg-primary/40 lg:block",
            "w-1.5",
          )}
          onPointerDown={onSplitterPointerDown}
          onPointerMove={onSplitterPointerMove}
          onPointerUp={onSplitterPointerUp}
          onPointerCancel={onSplitterPointerUp}
        />

        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-border lg:border-t-0 lg:border-s"
          data-testid="review-fields-panel"
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <Tabs
              value={sideTab}
              onValueChange={(v) => setSideTab(v === "trace" ? "trace" : "fields")}
              data-testid="review-side-tabs"
            >
              <TabsList>
                <TabsTrigger value="fields" data-testid="review-tab-fields">
                  Fields
                </TabsTrigger>
                <TabsTrigger value="trace" data-testid="review-tab-trace">
                  Trace
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {sideTab === "trace" ? (
              <TracePanel
                kind={documentId ? "document" : "inbox"}
                id={documentId || String(params.id)}
              />
            ) : null}
            {sideTab === "fields" ? (
              <>
            <ReviewCard title="Party" testId="review-card-party">
              <FieldGroup
                eyebrow=""
                keys={PARTY_FIELDS}
                fields={fields}
                activeField={activeField}
                setActiveField={setActiveField}
                onFieldChange={onFieldChange}
              />
              {!documentId ? (
                <div className="space-y-2 border-t border-border pt-3">
                  <Label className="text-xs">Party for draft</Label>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={partyId}
                    onChange={(e) => {
                      setPartyId(e.target.value);
                      setMismatchKeep(false);
                    }}
                    data-testid="confirm-party"
                  >
                    {parties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {mismatchDiffs.length ? (
                    <div
                      className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3"
                      data-testid="party-mismatch-banner"
                    >
                      <p className="text-sm font-semibold text-amber-900">Party mismatch</p>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-amber-900/80">
                            <th className="py-1">Field</th>
                            <th>Extracted</th>
                            <th>Master</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mismatchDiffs.map((d) => (
                            <tr key={d.field} className="border-t border-amber-200">
                              <td className="py-1 capitalize">{d.field}</td>
                              <td data-testid={`mismatch-extracted-${d.field}`}>{d.extracted}</td>
                              <td data-testid={`mismatch-master-${d.field}`}>{d.master}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          data-testid="party-mismatch-update"
                          onClick={() => void updatePartyFromExtraction()}
                        >
                          Update party
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="party-mismatch-keep"
                          onClick={() => setMismatchKeep(true)}
                        >
                          Keep master
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </ReviewCard>

            <ReviewCard title="Document" testId="review-card-document">
              <FieldGroup
                eyebrow=""
                keys={DOCUMENT_FIELDS}
                fields={fields}
                activeField={activeField}
                setActiveField={setActiveField}
                onFieldChange={onFieldChange}
              />
            </ReviewCard>

            <ReviewCard title="Lines" testId="review-card-lines">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <Label className="text-xs font-medium text-muted-foreground">Line items</Label>
                <Tabs
                  value={lineMode}
                  onValueChange={(v) => setLineMode(v as "item" | "accounting")}
                  data-testid="line-mode-tabs"
                >
                  <TabsList className="h-8">
                    <TabsTrigger value="item" className="text-xs" data-testid="line-mode-item">
                      Item mode
                    </TabsTrigger>
                    <TabsTrigger
                      value="accounting"
                      className="text-xs"
                      data-testid="line-mode-accounting"
                    >
                      Accounting mode
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
              <table className="mt-1 w-full text-sm" data-testid="review-line-items">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1">Description</th>
                    {lineMode === "accounting" ? <th>Account</th> : null}
                    <th>VAT</th>
                    <th className="text-right">Net</th>
                    <th className="text-right">VAT amt</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((l, idx) => (
                    <tr key={`${l.description || "line"}-${idx}`} className="border-t border-border">
                      <td className="py-1">
                        {l.description || (
                          <span className="text-muted-foreground">{EMPTY_FIELD}</span>
                        )}
                      </td>
                      {lineMode === "accounting" ? (
                        <td className="text-muted-foreground" data-testid={`line-account-${idx}`}>
                          {EMPTY_FIELD}
                        </td>
                      ) : null}
                      <td>
                        <select
                          className="h-8 rounded-md border border-input bg-background px-1 text-xs"
                          data-testid={`line-vat-${idx}`}
                          value={l.vatCode}
                          onChange={(e) => {
                            const vatCode = e.target.value;
                            setLineItems((prev) =>
                              prev.map((row, i) => (i === idx ? { ...row, vatCode } : row)),
                            );
                          }}
                        >
                          <option value="">—</option>
                          {REVIEW_VAT_CODES.map((code) => (
                            <option key={code} value={code}>
                              {code}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="text-right tabular-nums">
                        {l.netMinor != null ? (
                          formatMinor(l.netMinor)
                        ) : (
                          <span className="text-muted-foreground">{EMPTY_FIELD}</span>
                        )}
                      </td>
                      <td className="text-right tabular-nums">
                        {l.vatMinor != null ? (
                          formatMinor(l.vatMinor)
                        ) : (
                          <span className="text-muted-foreground">{EMPTY_FIELD}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ReviewCard>

            <ReviewCard title="Totals" testId="totals-panel">
              <FieldGroup
                eyebrow=""
                keys={AMOUNT_FIELDS}
                fields={fields}
                activeField={activeField}
                setActiveField={setActiveField}
                onFieldChange={onFieldChange}
              />
              <div className="space-y-1.5 border-t border-border pt-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums">
                    {balance.subtotalMinor != null ? (
                      formatMinor(balance.subtotalMinor)
                    ) : (
                      <span className="text-muted-foreground font-normal">{EMPTY_FIELD}</span>
                    )}
                  </span>
                </div>
                {vatRows.map((row) => (
                  <div
                    key={row.code}
                    className="flex items-center justify-between gap-2 text-sm"
                    data-testid={`vat-by-code-${row.code}`}
                  >
                    <span className="text-muted-foreground">{row.display}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">VAT total</span>
                  <span className="tabular-nums">
                    {balance.vatTotalMinor != null ? (
                      formatMinor(balance.vatTotalMinor)
                    ) : (
                      <span className="text-muted-foreground font-normal">{EMPTY_FIELD}</span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t-2 border-double border-foreground/80 pt-2 text-sm font-semibold">
                  <span>Grand total</span>
                  <span className="tabular-nums">
                    {balance.grandTotalMinor != null ? (
                      formatMinor(balance.grandTotalMinor)
                    ) : (
                      <span className="text-muted-foreground font-normal">{EMPTY_FIELD}</span>
                    )}
                  </span>
                </div>
                <div className="pt-1">
                  {balance.balanced === true ? (
                    <StatusBadge
                      meta={{ label: "Balanced", tone: "success" }}
                      data-testid="totals-balance-badge"
                    />
                  ) : balance.balanced === false && balance.offByMinor != null ? (
                    <StatusBadge
                      meta={{
                        label: `Off by ${formatMinor(Math.abs(balance.offByMinor))}`,
                        tone: "danger",
                      }}
                      data-testid="totals-balance-badge"
                    />
                  ) : null}
                </div>
              </div>
            </ReviewCard>

            {documentId ? (
              <details className="rounded-lg border border-border bg-card p-4" open>
                <summary className="cursor-pointer text-sm font-semibold">
                  Payments · Journal preview · VAT
                </summary>
                <div className="mt-3">
                  <DocumentReviewPanels
                    documentId={documentId}
                    hideApproveActions
                    onApproved={() => void load()}
                    onApprovedAndNext={() => {
                      if (nav.nextId) {
                        router.push(`/books/inbox/${nav.nextId}`);
                      } else {
                        toast.success("Queue complete");
                        void load();
                      }
                    }}
                  />
                </div>
              </details>
            ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
