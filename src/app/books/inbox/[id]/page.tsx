"use client";

import { ChevronLeft, ChevronRight, Info, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { DocumentReviewPanels } from "@/components/books/document-review-panels";
import { PdfPagePreview } from "@/components/books/pdf-page-preview";
import { ReviewReadField } from "@/components/books/review-read-field";
import { StatusBadge } from "@/components/books/status-badge";
import { useBooksShell } from "@/components/books/books-shell-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiErrorMessage } from "@/lib/api-error";
import { displayToMinor, formatMinor } from "@/lib/money";
import type { FieldSource, PageBBox } from "@/lib/review-bbox";
import { boxesFromFieldSources } from "@/lib/review-bbox";
import { fieldConfidenceTone } from "@/lib/review-confidence";
import {
  mapWorkerFieldsToDisplay,
  type ReviewFieldState,
} from "@/lib/review-fields";
import { prevNextInReviewQueue } from "@/lib/review-queue-nav";
import { validateInvoiceLineSum } from "@/lib/invoice-validation";
import { docTypeLabel, inboxStatusLabel } from "@/lib/status-labels";
import { splitValidationFlags } from "@/lib/validation-flag-labels";
import { vatByCodeSummary } from "@/lib/vat-by-code";
import { cn } from "@/lib/utils";

const SPLITTER_KEY = "arnibooks.review.previewPct";
const DEFAULT_PREVIEW_PCT = 55;
const MIN_PREVIEW_PCT = 30;
const MAX_PREVIEW_PCT = 70;

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

function normalizeLines(items: ReviewPayload["lineItems"]) {
  return (items || []).map((l, i) => ({
    description: l.description || `Line ${i + 1}`,
    vatCode: l.vatCode || "SR",
    netMinor: Number(l.netMinor ?? l.amount_minor ?? 0),
    vatMinor: Number(l.vatMinor ?? 0),
  }));
}

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
      <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {eyebrow}
      </p>
      <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
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

/** Split-view review: uploaded file pages + read-first fields (UI-3). */
export default function InboxReviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { periodId } = useBooksShell();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const [lineItems, setLineItems] = useState<
    Array<{ description: string; vatCode: string; netMinor: number; vatMinor: number }>
  >([]);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [parties, setParties] = useState<Array<{ id: string; name: string }>>([]);
  const [partyId, setPartyId] = useState("");
  const [pageSizes, setPageSizes] = useState<Record<number, { width: number; height: number }>>(
    {},
  );
  const [previewPct, setPreviewPct] = useState(DEFAULT_PREVIEW_PCT);
  const [wideLayout, setWideLayout] = useState(false);
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
          setParties(pts);
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
  }, [nav.prevId, nav.nextId, router]);

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
        balanced: flags.length === 0,
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
    activeField && fields[activeField]?.source?.page
      ? Number(fields[activeField].source!.page)
      : null;
  const fieldStatus = Object.fromEntries(
    Object.entries(fields).map(([k, f]) => [k, { status: f.status, confidence: f.confidence }]),
  );
  const vatRows = vatByCodeSummary(lineItems);
  const docType =
    review?.detectedType ||
    fields.doc_type?.value ||
    "sales_invoice";
  const statusMeta = inboxStatusLabel(review?.status || "needs_review");
  const typeMeta = docTypeLabel(docType);

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

  const activeChipLabel = activeField ? LABELS[activeField] || activeField : null;
  const activeChipValue = activeField ? fields[activeField]?.value ?? "" : null;
  const mergedFlagList = [
    ...((review.validationFlags as string[]) || []),
    ...flags,
  ];
  const displayFlags = splitValidationFlags(mergedFlagList);

  const headerBar = (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
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
        <h1 className="text-xl font-semibold">{typeMeta.label}</h1>
        <StatusBadge meta={statusMeta} data-testid="review-status-badge" />
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
            <DropdownMenuItem onClick={() => toast.success("Saved as profile (stub)")}>
              Save as profile
            </DropdownMenuItem>
            <DropdownMenuItem
              render={<Link href="/books/statements" data-testid="review-statement-link" />}
            >
              Statement review
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {!documentId ? (
          <Button onClick={() => void confirmFields()} data-testid="confirm-fields">
            Confirm fields
          </Button>
        ) : null}
      </div>
    </div>
  );

  const flagsBar = (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
      data-testid="validation-flags"
    >
      {displayFlags.badges.length || displayFlags.technical.length ? (
        <TooltipProvider>
          {displayFlags.badges.map((b) => (
            <StatusBadge
              key={b.key}
              meta={{ label: b.label, tone: "warning" }}
              data-testid={`flag-badge-${b.key}`}
            />
          ))}
          {displayFlags.technical.length ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                    aria-label="Technical extraction details"
                    data-testid="validation-flags-tech"
                  >
                    <Info className="size-3.5" />
                  </button>
                }
              />
              <TooltipContent>
                <span className="font-mono text-[11px]">{displayFlags.technical.join(", ")}</span>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </TooltipProvider>
      ) : (
        <span className="text-sm text-emerald-700">
          Amounts balanced (subtotal + VAT = grand total)
        </span>
      )}
    </div>
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="review-split-view"
    >
      {headerBar}
      {flagsBar}

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
            <FieldGroup
              eyebrow="DOCUMENT"
              keys={DOCUMENT_FIELDS}
              fields={fields}
              activeField={activeField}
              setActiveField={setActiveField}
              onFieldChange={onFieldChange}
            />
            <FieldGroup
              eyebrow="PARTY"
              keys={PARTY_FIELDS}
              fields={fields}
              activeField={activeField}
              setActiveField={setActiveField}
              onFieldChange={onFieldChange}
            />
            <FieldGroup
              eyebrow="AMOUNTS"
              keys={AMOUNT_FIELDS}
              fields={fields}
              activeField={activeField}
              setActiveField={setActiveField}
              onFieldChange={onFieldChange}
            />

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

            <section className="space-y-1.5 border-t border-border pt-3" data-testid="totals-panel">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular-nums">
                  {balance.subtotalMinor != null ? formatMinor(balance.subtotalMinor) : "—"}
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
                  {balance.vatTotalMinor != null ? formatMinor(balance.vatTotalMinor) : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between border-t-2 border-double border-foreground/80 pt-2 text-sm font-semibold">
                <span>Grand total</span>
                <span className="tabular-nums">
                  {balance.grandTotalMinor != null ? formatMinor(balance.grandTotalMinor) : "—"}
                </span>
              </div>
              <div className="pt-1">
                {balance.balanced ? (
                  <StatusBadge
                    meta={{ label: "Balanced", tone: "success" }}
                    data-testid="totals-balance-badge"
                  />
                ) : (
                  <StatusBadge
                    meta={{
                      label: `Off by ${formatMinor(Math.abs(balance.offByMinor ?? 0))}`,
                      tone: "danger",
                    }}
                    data-testid="totals-balance-badge"
                  />
                )}
              </div>
            </section>

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

            {documentId ? (
              <div className="border-t border-border pt-3">
                <DocumentReviewPanels documentId={documentId} onApproved={() => void load()} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
