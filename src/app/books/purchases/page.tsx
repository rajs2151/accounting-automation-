"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Filter } from "lucide-react";
import { toast } from "sonner";

import { BooksDateInput } from "@/components/books/date-input";
import { CellAmount } from "@/components/books/cells";
import { RowKebabMenu, RowReviewLink } from "@/components/books/row-kebab-menu";
import { StatusBadge } from "@/components/books/status-badge";
import { useBooksShell } from "@/components/books/books-shell-context";
import { DocumentReviewPanels } from "@/components/books/document-review-panels";
import { OpenItemKpiTiles } from "@/components/books/open-item-kpis";
import { BooksSideDrawer } from "@/components/books/side-drawer";
import { showUploadFeedback } from "@/components/books/upload-feedback";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiErrorMessage } from "@/lib/api-error";
import { displayToMinor, MoneyTypeError } from "@/lib/money";
import { docTypeLabel, documentStatusLabel, inboxStatusLabel } from "@/lib/status-labels";

type Doc = {
  id: string;
  documentNumber: string | null;
  partyName: string;
  issueDate: string;
  status: string;
  grossMinor: number;
};

type Party = { id: string; name: string; trn: string | null };

type InboxRow = {
  id: string;
  filename: string;
  status: string;
  error: string | null;
  detectedType: string | null;
  intendedType?: string | null;
};

function isPurchaseUpload(u: InboxRow): boolean {
  const t = String(u.intendedType || u.detectedType || "").toLowerCase();
  if (!t) return true;
  if (t.includes("bank") || t.includes("statement")) return false;
  if (t.includes("sales")) return false;
  return t.includes("purchase") || t.includes("bill");
}

type Tab = "all" | "needs_review" | "uploads";

export default function PurchasesPage() {
  const { periodId } = useBooksShell();
  const [tab, setTab] = useState<Tab>("all");
  const [statusFilter, setStatusFilter] = useState<string | "all">("all");
  const [rows, setRows] = useState<Doc[]>([]);
  const [uploads, setUploads] = useState<InboxRow[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [selectedUploads, setSelectedUploads] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({
    partyId: "",
    documentNumber: "",
    issueDate: "2026-05-16",
    netAed: "200.00",
    lineKind: "expense" as "expense" | "disbursement",
    vatCode: "SR",
  });

  const reload = useCallback(async () => {
    const [docs, pts, inbox] = await Promise.all([
      fetch("/api/books/documents?docType=purchase_bill").then((r) => r.json()),
      fetch("/api/books/parties?partyType=supplier").then((r) => r.json()),
      fetch("/api/books/inbox").then((r) => r.json()),
    ]);
    if (Array.isArray(docs)) setRows(docs);
    if (Array.isArray(pts)) {
      setParties(pts);
      if (!form.partyId && pts[0]) setForm((f) => ({ ...f, partyId: pts[0].id }));
    }
    if (Array.isArray(inbox)) {
      setUploads(inbox.filter((u: InboxRow) => isPurchaseUpload(u)));
    }
    setSelectedDocs(new Set());
    setSelectedUploads(new Set());
  }, [form.partyId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const needsReviewDocs = useMemo(
    () => rows.filter((r) => r.status === "draft"),
    [rows],
  );
  const needsReviewUploads = useMemo(
    () => uploads.filter((u) => u.status === "needs_review"),
    [uploads],
  );
  const needsReviewCount = needsReviewDocs.length + needsReviewUploads.length;

  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.status, (m.get(r.status) || 0) + 1);
    return m;
  }, [rows]);

  const visibleDocs = useMemo(() => {
    const base = tab === "needs_review" ? needsReviewDocs : rows;
    if (statusFilter === "all") return base;
    return base.filter((r) => r.status === statusFilter);
  }, [tab, rows, needsReviewDocs, statusFilter]);

  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    const body = new FormData();
    for (const f of Array.from(files)) body.append("files", f);
    body.append("intendedType", "purchase_bill");
    const res = await fetch("/api/books/inbox/upload", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    showUploadFeedback(res.ok, data);
    if (!res.ok) return;
    setTab("uploads");
    void reload();
  }

  async function retry(id: string) {
    const res = await fetch(`/api/books/inbox/${id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      toast.error(apiErrorMessage(await res.json().catch(() => ({}))));
      return;
    }
    toast.success("Retry queued");
    void reload();
  }

  async function createBill() {
    let net: number;
    try {
      net = displayToMinor(form.netAed) ?? 0;
    } catch (e) {
      toast.error(e instanceof MoneyTypeError ? "Invalid amount" : "Invalid amount");
      return;
    }
    const vat = form.lineKind === "disbursement" ? 0 : Math.floor((net * 500 + 5000) / 10000);
    const res = await fetch("/api/books/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docType: "purchase_bill",
        partyId: form.partyId,
        issueDate: form.issueDate,
        periodId,
        documentNumber: form.documentNumber || undefined,
        lines: [
          {
            description:
              form.lineKind === "disbursement" ? "Gov fee paid for client" : "Office supplies",
            lineKind: form.lineKind,
            vatCode: form.lineKind === "disbursement" ? null : form.vatCode,
            netMinor: net,
            vatMinor: vat,
          },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Draft bill created — switch to approver to post");
    setManualOpen(false);
    void reload();
  }

  async function approve(id: string) {
    const res = await fetch(`/api/books/documents/${id}/approve`, { method: "POST", body: "{}" });
    const data = await res.json();
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success(`Posted ${data.entryNo}`);
    void reload();
  }

  function toggleDoc(id: string) {
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleUpload(id: string) {
    setSelectedUploads((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkChangeType(docType: "purchase_bill" | "sales_invoice") {
    const ids = [...selectedUploads];
    if (!ids.length) return;
    let ok = 0;
    for (const id of ids) {
      const res = await fetch(`/api/books/inbox/${id}/type`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docType }),
      });
      if (res.ok) ok += 1;
    }
    toast.success(`Changed type on ${ok} of ${ids.length}`);
    void reload();
  }

  async function bulkAssign() {
    const ids = [...selectedUploads];
    if (!ids.length) return;
    let ok = 0;
    for (const id of ids) {
      const res = await fetch(`/api/books/inbox/${id}/route`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (res.ok) ok += 1;
    }
    toast.success(`Assigned ${ok} of ${ids.length} to this company`);
    void reload();
  }

  async function bulkRevertDraft() {
    const ids = [...selectedDocs].filter((id) => {
      const row = rows.find((r) => r.id === id);
      return row?.status === "draft";
    });
    if (!ids.length) {
      toast.error("Select draft bills to revert");
      return;
    }
    let ok = 0;
    for (const id of ids) {
      const res = await fetch(`/api/books/documents/${id}`, { method: "DELETE" });
      if (res.ok) ok += 1;
      else {
        const data = await res.json().catch(() => ({}));
        toast.error(apiErrorMessage(data));
      }
    }
    toast.success(`Reverted ${ok} draft(s)`);
    void reload();
  }

  const showUploadsBulk = tab === "uploads" && selectedUploads.size > 0;
  const showDocsBulk =
    (tab === "all" || tab === "needs_review") && selectedDocs.size > 0;

  return (
    <div className="space-y-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Purchase bills</h1>
        <div className="flex flex-wrap gap-2">
          <label
            className="inline-flex cursor-pointer items-center rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
            data-testid="purchase-upload"
          >
            Upload Invoices
            <input
              type="file"
              multiple
              accept=".pdf,image/*"
              className="hidden"
              onChange={(e) => void onUpload(e.target.files)}
            />
          </label>
          <Button variant="outline" onClick={() => setManualOpen((v) => !v)}>
            Record manually
          </Button>
        </div>
      </div>

      <OpenItemKpiTiles side="AP" />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} data-testid="purchase-tabs">
          <TabsList>
            <TabsTrigger value="all" data-testid="purchase-tab-all">
              All ({rows.length})
            </TabsTrigger>
            <TabsTrigger value="needs_review" data-testid="purchase-tab-needs-review">
              Needs Review ({needsReviewCount})
            </TabsTrigger>
            <TabsTrigger value="uploads" data-testid="purchase-uploads-tab">
              Uploads ({uploads.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {tab !== "uploads" ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="purchase-filter-menu"
                >
                  <Filter className="size-3.5" />
                  Filter
                  {statusFilter !== "all" ? ` · ${statusFilter}` : ""}
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                data-testid="filter-status-all"
                onClick={() => setStatusFilter("all")}
              >
                All statuses ({rows.length})
              </DropdownMenuItem>
              {[...statusCounts.entries()].map(([status, n]) => (
                <DropdownMenuItem
                  key={status}
                  data-testid={`filter-status-${status}`}
                  onClick={() => setStatusFilter(status)}
                >
                  {documentStatusLabel(status).label} ({n})
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {showUploadsBulk || showDocsBulk ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2"
          data-testid="purchase-bulk-bar"
        >
          <span className="text-sm text-muted-foreground">
            {showUploadsBulk ? selectedUploads.size : selectedDocs.size} selected
          </span>
          {showUploadsBulk ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button size="sm" variant="outline" data-testid="bulk-change-type">
                      Change type
                    </Button>
                  }
                />
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => void bulkChangeType("purchase_bill")}>
                    Purchase bill
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void bulkChangeType("sales_invoice")}>
                    Sales invoice
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="sm" variant="outline" data-testid="bulk-assign" onClick={() => void bulkAssign()}>
                Assign
              </Button>
            </>
          ) : null}
          {showDocsBulk ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="bulk-revert-draft"
              onClick={() => void bulkRevertDraft()}
            >
              Revert draft
            </Button>
          ) : null}
        </div>
      ) : null}

      {tab === "uploads" ? (
        <table className="w-full text-sm" data-testid="purchase-uploads-table">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="w-8 py-2" />
              <th>File</th>
              <th>Status</th>
              <th>Type</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {uploads.map((u) => (
              <tr
                key={u.id}
                className="group border-t border-border hover:bg-muted/30"
                onClick={() => {
                  window.location.href = `/books/inbox/${u.id}`;
                }}
              >
                <td className="py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedUploads.has(u.id)}
                    onChange={() => toggleUpload(u.id)}
                    data-testid={`upload-select-${u.id}`}
                    aria-label={`Select ${u.filename}`}
                  />
                </td>
                <td>
                  <span className="inline-flex items-center gap-2">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    {u.filename}
                  </span>
                </td>
                <td data-testid={`upload-status-${u.id}`}>
                  <StatusBadge
                    meta={inboxStatusLabel(u.status, u.error === "duplicate_file")}
                  />
                </td>
                <td>
                  <StatusBadge meta={docTypeLabel(u.detectedType)} />
                </td>
                <td className="text-right" onClick={(e) => e.stopPropagation()}>
                  <RowKebabMenu data-testid={`upload-row-menu-${u.id}`}>
                    {u.error !== "duplicate_file" &&
                    (u.status === "failed" || u.status === "needs_review") ? (
                      <DropdownMenuItem onClick={() => void retry(u.id)}>Retry</DropdownMenuItem>
                    ) : null}
                    <RowReviewLink href={`/books/inbox/${u.id}`} testId={`upload-review-${u.id}`} />
                  </RowKebabMenu>
                </td>
              </tr>
            ))}
            {!uploads.length ? (
              <tr>
                <td colSpan={5} className="py-6 text-muted-foreground">
                  No uploads yet — use Upload Invoices.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : (
        <>
          {manualOpen ? (
            <div className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3">
              <div>
                <Label>Supplier</Label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={form.partyId}
                  onChange={(e) => setForm({ ...form, partyId: e.target.value })}
                >
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.trn ? "" : " (no TRN)"}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Bill no</Label>
                <Input
                  value={form.documentNumber}
                  onChange={(e) => setForm({ ...form, documentNumber: e.target.value })}
                />
              </div>
              <div>
                <Label>Issue date</Label>
                <BooksDateInput
                  value={form.issueDate}
                  onChange={(iso) => setForm({ ...form, issueDate: iso })}
                  data-testid="purchase-issue-date"
                />
              </div>
              <div>
                <Label>Net (AED)</Label>
                <Input
                  value={form.netAed}
                  onChange={(e) => setForm({ ...form, netAed: e.target.value })}
                  inputMode="decimal"
                  placeholder="0.00"
                />
              </div>
              <div>
                <Label>Line type</Label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={form.lineKind}
                  onChange={(e) =>
                    setForm({ ...form, lineKind: e.target.value as typeof form.lineKind })
                  }
                >
                  <option value="expense">expense</option>
                  <option value="disbursement">disbursement (no VAT) → 1220</option>
                </select>
              </div>
              <div className="flex items-end">
                <Button onClick={() => void createBill()}>Save draft</Button>
              </div>
            </div>
          ) : (
            <div className="flex items-end gap-3 rounded-lg border border-dashed border-border p-3">
              <div>
                <Label>Default issue date</Label>
                <BooksDateInput
                  value={form.issueDate}
                  onChange={(iso) => setForm({ ...form, issueDate: iso })}
                  data-testid="purchase-issue-date"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Primary path is upload. Use Record manually for edge cases.
              </p>
            </div>
          )}

          {tab === "needs_review" && needsReviewUploads.length ? (
            <div className="rounded-lg border border-border p-3" data-testid="needs-review-uploads">
              <p className="mb-2 text-sm font-medium">Uploads needing review</p>
              <ul className="space-y-1 text-sm">
                {needsReviewUploads.map((u) => (
                  <li key={u.id}>
                    <a className="text-primary underline" href={`/books/inbox/${u.id}`}>
                      {u.filename}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <table className="w-full text-sm" data-testid="purchase-bills-table">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="w-8 py-2" />
                <th>Number</th>
                <th>Supplier</th>
                <th>Date</th>
                <th>Gross</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleDocs.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-2">
                    <input
                      type="checkbox"
                      checked={selectedDocs.has(r.id)}
                      onChange={() => toggleDoc(r.id)}
                      data-testid={`bill-select-${r.id}`}
                      aria-label={`Select ${r.documentNumber || r.id}`}
                    />
                  </td>
                  <td>{r.documentNumber || "—"}</td>
                  <td>{r.partyName}</td>
                  <td>{r.issueDate?.slice(0, 10).split("-").reverse().join("/")}</td>
                  <td className="text-end tabular-nums">
                    {r.grossMinor != null ? <CellAmount minor={r.grossMinor} /> : "—"}
                  </td>
                  <td>
                    <StatusBadge meta={documentStatusLabel(r.status)} />
                  </td>
                  <td className="space-x-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => setReviewId(r.id)}>
                      Review
                    </Button>
                    {r.status === "draft" ? (
                      <Button size="sm" variant="outline" onClick={() => void approve(r.id)}>
                        Approve
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!visibleDocs.length ? (
                <tr>
                  <td colSpan={7} className="py-6 text-muted-foreground">
                    {tab === "needs_review" ? "No bills need review." : "No bills yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </>
      )}

      <BooksSideDrawer
        open={Boolean(reviewId)}
        onOpenChange={(open) => {
          if (!open) setReviewId(null);
        }}
        title="Bill review"
        entryNo={rows.find((r) => r.id === reviewId)?.documentNumber}
        status={rows.find((r) => r.id === reviewId)?.status}
      >
        {reviewId ? (
          <div className="p-4">
            <DocumentReviewPanels
              documentId={reviewId}
              onApproved={() => {
                setReviewId(null);
                void reload();
              }}
            />
          </div>
        ) : null}
      </BooksSideDrawer>
    </div>
  );
}
