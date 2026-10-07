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
import { rowOpenProps } from "@/components/books/table-peek";
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
import { formatDateUae } from "@/lib/date";
import { displayToMinor, MoneyTypeError } from "@/lib/money";
import { docTypeLabel, documentStatusLabel, inboxStatusLabel } from "@/lib/status-labels";

type Doc = {
  id: string;
  docType?: string;
  documentNumber: string | null;
  partyName: string;
  issueDate: string;
  dueDate?: string | null;
  status: string;
  grossMinor: number;
  outstandingMinor?: number | null;
  deferRevenue: boolean;
};

type Party = { id: string; name: string };

type InboxRow = {
  id: string;
  filename: string;
  status: string;
  error: string | null;
  detectedType: string | null;
  intendedType?: string | null;
};

type Tab = "all" | "needs_review" | "uploads";

function isSalesUpload(u: InboxRow): boolean {
  const t = String(u.intendedType || u.detectedType || "").toLowerCase();
  if (!t) return true;
  if (t.includes("bank") || t.includes("statement")) return false;
  if (t.includes("purchase") || t.includes("bill")) return false;
  return t.includes("sales") || t.includes("invoice");
}

export default function SalesPage() {
  const { periodId, periods } = useBooksShell();
  const [tab, setTab] = useState<Tab>("all");
  const [statusFilter, setStatusFilter] = useState<string | "all">("all");
  const [rows, setRows] = useState<Doc[]>([]);
  const [uploads, setUploads] = useState<InboxRow[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [myRole, setMyRole] = useState("");
  // Approving posts the document: approver/admin only, and never the preparer (server-enforced).
  const approveBlocked =
    myRole && myRole !== "admin" && myRole !== "approver"
      ? "Only an approver or admin can approve — the preparer can't post their own document"
      : null;
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [selectedUploads, setSelectedUploads] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({
    partyId: "",
    documentNumber: "",
    issueDate: "2026-05-15",
    netAed: "100.00",
    lineKind: "revenue" as "revenue" | "disbursement" | "taxable_recharge",
    vatCode: "SR",
    serviceStart: "",
    serviceEnd: "",
    deferRevenue: "" as "" | "true" | "false",
    currency: "AED",
    fxRateScaled: "100000000",
    manualReason: "",
  });

  const reload = useCallback(async () => {
    const [docs, pts, inbox, notes, sess] = await Promise.all([
      fetch("/api/books/documents?docType=sales_invoice").then((r) => r.json()),
      fetch("/api/books/parties?partyType=customer").then((r) => r.json()),
      fetch("/api/books/inbox").then((r) => r.json()),
      fetch("/api/books/documents?docType=credit_note").then((r) => r.json()),
      fetch("/api/session").then((r) => r.json()).catch(() => null),
    ]);
    if (Array.isArray(docs)) {
      // Credit notes are listed with the documents they adjust (type badge in the number column).
      const all = [...docs, ...(Array.isArray(notes) ? notes : [])] as Doc[];
      all.sort((a, b) => String(b.issueDate || "").localeCompare(String(a.issueDate || "")));
      setRows(all);
    }
    if (sess?.me?.role) setMyRole(String(sess.me.role));
    if (Array.isArray(pts)) {
      setParties(pts);
      if (!form.partyId && pts[0]) setForm((f) => ({ ...f, partyId: pts[0].id }));
    }
    if (Array.isArray(inbox)) {
      setUploads(inbox.filter((u: InboxRow) => isSalesUpload(u)));
    }
    setSelectedDocs(new Set());
    setSelectedUploads(new Set());
  }, [form.partyId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const needsReviewDocs = useMemo(() => rows.filter((r) => r.status === "draft"), [rows]);
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
    body.append("intendedType", "sales_invoice");
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

  async function createInvoice() {
    if (!form.partyId) {
      toast.error("Pick a customer");
      return;
    }
    if (!form.documentNumber.trim()) {
      toast.error("Invoice number is required (from the client's document)");
      return;
    }
    if (!form.manualReason.trim()) {
      toast.error("Add a reason for recording manually (or upload the invoice)");
      return;
    }
    let net: number;
    try {
      net = displayToMinor(form.netAed) ?? 0;
    } catch (e) {
      toast.error(e instanceof MoneyTypeError ? "Invalid amount" : "Invalid amount");
      return;
    }
    const vat = form.lineKind === "disbursement" ? 0 : Math.floor((net * 500 + 5000) / 10000);
    const body = {
      docType: "sales_invoice",
      partyId: form.partyId,
      issueDate: form.issueDate,
      periodId,
      documentNumber: form.documentNumber.trim(),
      recordSource: "manual" as const,
      manualRecordReason: form.manualReason.trim(),
      currency: form.currency,
      fxRateScaled: Number(form.fxRateScaled),
      serviceStart: form.serviceStart || null,
      serviceEnd: form.serviceEnd || null,
      deferRevenue: form.deferRevenue === "" ? null : form.deferRevenue === "true",
      lines: [
        {
          description: form.lineKind === "disbursement" ? "Gov fee rebill" : "Consulting",
          lineKind: form.lineKind,
          vatCode: form.lineKind === "disbursement" ? null : form.vatCode,
          netMinor: net,
          vatMinor: vat,
        },
      ],
    };
    const res = await fetch("/api/books/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Draft invoice recorded — switch to approver to post");
    setManualOpen(false);
    setForm((f) => ({ ...f, manualReason: "", documentNumber: "" }));
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
    const ids = [...selectedDocs].filter((id) => rows.find((r) => r.id === id)?.status === "draft");
    if (!ids.length) {
      toast.error("Select draft invoices to revert");
      return;
    }
    let ok = 0;
    for (const id of ids) {
      const res = await fetch(`/api/books/documents/${id}`, { method: "DELETE" });
      if (res.ok) ok += 1;
      else toast.error(apiErrorMessage(await res.json().catch(() => ({}))));
    }
    toast.success(`Reverted ${ok} draft(s)`);
    void reload();
  }

  const periodLabel = periods.find((p) => p.id === periodId)?.label;
  const showUploadsBulk = tab === "uploads" && selectedUploads.size > 0;
  const showDocsBulk = (tab === "all" || tab === "needs_review") && selectedDocs.size > 0;

  return (
    <div className="space-y-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Sales invoices</h1>
          <p className="text-sm text-muted-foreground">
            Record-only · Period {periodLabel || "—"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label
            className="inline-flex cursor-pointer items-center rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
            data-testid="sales-upload"
          >
            Upload Invoices
            <input
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,.heic,.csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => void onUpload(e.target.files)}
            />
          </label>
          <Button variant="outline" onClick={() => setManualOpen((v) => !v)}>
            Record manually
          </Button>
        </div>
      </div>

      <OpenItemKpiTiles side="AR" />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} data-testid="sales-tabs">
          <TabsList>
            <TabsTrigger value="all" data-testid="sales-tab-all">
              All ({rows.length})
            </TabsTrigger>
            <TabsTrigger value="needs_review" data-testid="sales-tab-needs-review">
              Needs Review ({needsReviewCount})
            </TabsTrigger>
            <TabsTrigger value="uploads" data-testid="sales-uploads-tab">
              Uploads ({uploads.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {tab !== "uploads" ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="outline" size="sm" data-testid="sales-filter-menu">
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
          data-testid="sales-bulk-bar"
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
                  <DropdownMenuItem onClick={() => void bulkChangeType("sales_invoice")}>
                    Sales invoice
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void bulkChangeType("purchase_bill")}>
                    Purchase bill
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
        <table className="w-full text-sm" data-testid="sales-uploads-table">
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
                className="group border-t border-border"
                {...rowOpenProps(() => {
                  window.location.href = `/books/inbox/${u.id}`;
                })}
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
                  <StatusBadge meta={inboxStatusLabel(u.status, u.error === "duplicate_file")} />
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
            <div
              className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3"
              data-testid="sales-manual-form"
            >
              <p className="md:col-span-3 text-sm text-muted-foreground">
                Record an invoice the client already issued. Upload is preferred; a reason is required
                when recording manually.
              </p>
              <div>
                <Label>Customer</Label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={form.partyId}
                  onChange={(e) => setForm({ ...form, partyId: e.target.value })}
                  data-testid="sales-manual-customer"
                >
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Invoice no (from client document)</Label>
                <Input
                  value={form.documentNumber}
                  onChange={(e) => setForm({ ...form, documentNumber: e.target.value })}
                  data-testid="sales-manual-number"
                />
              </div>
              <div>
                <Label>Issue date</Label>
                <BooksDateInput
                  value={form.issueDate}
                  onChange={(iso) => setForm({ ...form, issueDate: iso })}
                  data-testid="sales-issue-date"
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
                    setForm({
                      ...form,
                      lineKind: e.target.value as typeof form.lineKind,
                    })
                  }
                >
                  <option value="disbursement">disbursement (no VAT)</option>
                  <option value="revenue">revenue</option>
                  <option value="taxable_recharge">taxable recharge (5%)</option>
                </select>
              </div>
              <div>
                <Label>Service start / end</Label>
                <div className="flex gap-2">
                  <Input
                    type="date"
                    value={form.serviceStart}
                    onChange={(e) => setForm({ ...form, serviceStart: e.target.value })}
                  />
                  <Input
                    type="date"
                    value={form.serviceEnd}
                    onChange={(e) => setForm({ ...form, serviceEnd: e.target.value })}
                  />
                </div>
              </div>
              <div className="md:col-span-3">
                <Label>Reason for manual record</Label>
                <Input
                  value={form.manualReason}
                  onChange={(e) => setForm({ ...form, manualReason: e.target.value })}
                  placeholder="e.g. Client emailed PDF without portal upload"
                  data-testid="sales-manual-reason"
                />
              </div>
              <div className="md:col-span-3">
                <Button onClick={() => void createInvoice()} data-testid="sales-manual-save">
                  Save draft
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-end gap-3 rounded-lg border border-dashed border-border p-3">
              <div>
                <Label>Default issue date</Label>
                <BooksDateInput
                  value={form.issueDate}
                  onChange={(iso) => setForm({ ...form, issueDate: iso })}
                  data-testid="sales-issue-date"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Primary path is upload. arnibooks records invoices — it does not issue them.
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

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm" data-testid="sales-invoices-table">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2">Invoice no</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Due</th>
                  <th className="px-3 py-2">Outstanding</th>
                  <th className="px-3 py-2">Total</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {visibleDocs.map((r) => {
                  const outstanding =
                    r.outstandingMinor == null ? null : Number(r.outstandingMinor);
                  const gross = Number(r.grossMinor || 0);
                  return (
                    <tr key={r.id} className="border-t border-border" {...rowOpenProps(() => setReviewId(r.id))}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedDocs.has(r.id)}
                          onChange={() => toggleDoc(r.id)}
                          data-testid={`invoice-select-${r.id}`}
                          aria-label={`Select ${r.documentNumber || r.id}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span>{r.documentNumber || "—"}</span>
                          {r.docType && r.docType !== "sales_invoice" ? (
                            <StatusBadge meta={docTypeLabel(r.docType)} />
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2">{r.partyName || "—"}</td>
                      <td className="px-3 py-2">
                        {formatDateUae(String(r.issueDate).slice(0, 10))}
                      </td>
                      <td className="px-3 py-2">
                        {r.dueDate ? formatDateUae(String(r.dueDate).slice(0, 10)) : "—"}
                      </td>
                      <td className="px-3 py-2 tabular-nums" data-testid={`outstanding-${r.id}`}>
                        {outstanding == null ? "—" : <CellAmount minor={outstanding} />}
                      </td>
                      <td className="px-3 py-2">
                        {r.grossMinor != null ? <CellAmount minor={r.grossMinor} /> : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge meta={documentStatusLabel(r.status)} />
                          {r.deferRevenue ? (
                            <StatusBadge meta={{ label: "Deferred", tone: "info" }} />
                          ) : null}
                          {outstanding != null && outstanding > gross ? (
                            <StatusBadge meta={{ label: "Outstanding > total", tone: "danger" }} />
                          ) : null}
                        </div>
                      </td>
                      <td className="space-x-2 px-3 py-2">
                        <Button size="sm" variant="outline" onClick={() => setReviewId(r.id)}>
                          Review
                        </Button>
                        {r.status === "draft" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!r.partyName || Boolean(approveBlocked)}
                            title={!r.partyName ? "Customer required" : approveBlocked || undefined}
                            onClick={() => void approve(r.id)}
                          >
                            Approve
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {!visibleDocs.length ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-muted-foreground">
                      {tab === "needs_review" ? "No invoices need review." : "No invoices yet."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}

      <BooksSideDrawer
        open={Boolean(reviewId)}
        onOpenChange={(open) => {
          if (!open) setReviewId(null);
        }}
        title="Invoice review"
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
