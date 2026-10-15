"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/books/empty-state";
import { StatusBadge } from "@/components/books/status-badge";
import { rowOpenProps } from "@/components/books/table-peek";
import { UploadDialog } from "@/components/books/upload-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
import { findFilenameNearDuplicates } from "@/lib/inbox-classify";
import { docTypeLabel, inboxStatusLabel } from "@/lib/status-labels";

type InboxRow = {
  id: string;
  clientId: string | null;
  filename: string;
  detectedType: string | null;
  intendedType?: string | null;
  classificationConfidence: number | null;
  status: string;
  error: string | null;
  sha256: string;
  byteSize?: number;
  uploadedByName?: string | null;
  createdAt?: string;
};

type Tab = "uploads" | "needs_review" | "all";

const TYPE_OPTIONS = [
  { value: "sales_invoice", label: "Sales invoice" },
  { value: "purchase_bill", label: "Purchase bill" },
  { value: "credit_note", label: "Credit note" },
  { value: "debit_note", label: "Debit note" },
  { value: "receipt", label: "Receipt" },
  { value: "payment", label: "Payment" },
  { value: "bank_statement", label: "Bank statement" },
  { value: "card_statement", label: "Card statement" },
  { value: "gateway_statement", label: "Gateway statement" },
] as const;

function formatBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatConfidence(c: number | null | undefined): string {
  if (c == null || !Number.isFinite(c)) return "—";
  return `${Math.round(c * 100)}%`;
}

export default function InboxPage() {
  const searchParams = useSearchParams();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [unassigned, setUnassigned] = useState(() => searchParams.get("unassigned") === "1");
  const [tab, setTab] = useState<Tab>("uploads");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [typeBusy, setTypeBusy] = useState<string | null>(null);
  const pageSize = 25;

  const reload = useCallback(async () => {
    const qs = unassigned ? "?unassigned=1" : "";
    const data = await fetch(`/api/books/inbox${qs}`).then((r) => r.json());
    if (Array.isArray(data)) setRows(data);
  }, [unassigned]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (searchParams.get("upload") === "1") {
      setUploadOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("upload");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  }, [searchParams]);

  const extracting = rows.some((r) => r.status === "queued" || r.status === "extracting");
  useEffect(() => {
    if (!extracting) return;
    const t = window.setInterval(() => void reload(), 3000);
    return () => window.clearInterval(t);
  }, [extracting, reload]);

  const hashDupes = useMemo(() => {
    const byHash = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.sha256 || r.error === "duplicate_file") continue;
      const list = byHash.get(r.sha256) || [];
      list.push(r.id);
      byHash.set(r.sha256, list);
    }
    const out = new Set<string>();
    for (const ids of byHash.values()) {
      if (ids.length > 1) for (const id of ids) out.add(id);
    }
    for (const r of rows) {
      if (r.error === "duplicate_file") out.add(r.id);
    }
    return out;
  }, [rows]);

  const nameDupes = useMemo(
    () => findFilenameNearDuplicates(rows.map((r) => ({ id: r.id, filename: r.filename }))),
    [rows],
  );

  const filtered = useMemo(() => {
    let list = rows;
    if (tab === "uploads") {
      list = list.filter((r) =>
        ["queued", "extracting", "needs_review", "failed", "ready"].includes(r.status),
      );
    } else if (tab === "needs_review") {
      list = list.filter((r) => r.status === "needs_review");
    }
    if (statusFilter !== "all") list = list.filter((r) => r.status === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((r) => r.filename.toLowerCase().includes(q));
    return list;
  }, [rows, tab, statusFilter, search]);

  const pageRows = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));

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

  async function routeHere(id: string) {
    const res = await fetch(`/api/books/inbox/${id}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      toast.error(apiErrorMessage(await res.json().catch(() => ({}))));
      return;
    }
    toast.success("Routed to company");
    void reload();
  }

  async function changeType(id: string, docType: string) {
    setTypeBusy(id);
    try {
      const res = await fetch(`/api/books/inbox/${id}/type`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docType }),
      });
      if (!res.ok) {
        toast.error(apiErrorMessage(await res.json().catch(() => ({}))));
        return;
      }
      toast.success("Type updated");
      void reload();
    } finally {
      setTypeBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{unassigned ? "Unassigned inbox" : "Inbox"}</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant={unassigned ? "outline" : "default"} onClick={() => setUnassigned(false)}>
            Company
          </Button>
          <Button variant={unassigned ? "default" : "outline"} onClick={() => setUnassigned(true)}>
            Unassigned
          </Button>
          <Button data-testid="inbox-upload" onClick={() => setUploadOpen(true)}>
            Upload
          </Button>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as Tab);
          setPage(0);
        }}
      >
        <TabsList>
          <TabsTrigger value="uploads" data-testid="inbox-tab-uploads">
            Uploads
          </TabsTrigger>
          <TabsTrigger value="needs_review" data-testid="inbox-tab-needs-review">
            Needs review
          </TabsTrigger>
          <TabsTrigger value="all" data-testid="inbox-tab-all">
            All documents
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Search file name"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          data-testid="inbox-search"
        />
        <select
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(0);
          }}
          data-testid="inbox-status-filter"
        >
          <option value="all">All statuses</option>
          <option value="queued">Queued</option>
          <option value="extracting">Extracting</option>
          <option value="needs_review">Needs review</option>
          <option value="review_later">Review later</option>
          <option value="ready">Ready</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {!filtered.length ? (
        <EmptyState
          data-testid="inbox-empty-state"
          icon={Inbox}
          title="No documents yet"
          hint="Upload invoices or statements to start review."
          actionLabel="Upload"
          onAction={() => setUploadOpen(true)}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm" data-testid="inbox-table">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Confidence</th>
                <th className="px-3 py-2">Uploaded</th>
                <th className="px-3 py-2">By</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => {
                const currentType = r.intendedType || r.detectedType || "";
                const isHashDupe = hashDupes.has(r.id);
                const isNameDupe = nameDupes.has(r.id);
                return (
                  <tr
                    key={r.id}
                    className="group border-t border-border"
                    {...rowOpenProps(() => {
                      window.location.href = `/books/inbox/${r.id}`;
                    })}
                  >
                    <td className="px-3 py-2">
                      <span className="text-foreground">{r.filename}</span>
                      {isHashDupe || isNameDupe ? (
                        <div className="mt-0.5 text-xs text-amber-700" data-testid="inbox-dupe-hint">
                          {isHashDupe ? "Duplicate file (same content)" : "Similar file name"}
                        </div>
                      ) : null}
                      {r.status === "failed" && r.error ? (
                        <div className="mt-0.5 text-xs text-destructive">{r.error}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {formatBytes(r.byteSize)}
                    </td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <select
                        className="h-8 max-w-[11rem] rounded-md border border-input bg-background px-1.5 text-xs"
                        value={currentType}
                        disabled={typeBusy === r.id}
                        data-testid={`inbox-type-${r.id}`}
                        onChange={(e) => void changeType(r.id, e.target.value)}
                        title={docTypeLabel(currentType).label}
                      >
                        {!currentType ? <option value="">Unknown</option> : null}
                        {TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                        {currentType && !TYPE_OPTIONS.some((o) => o.value === currentType) ? (
                          <option value={currentType}>{docTypeLabel(currentType).label}</option>
                        ) : null}
                      </select>
                    </td>
                    <td
                      className="px-3 py-2 tabular-nums text-muted-foreground"
                      data-testid={`inbox-confidence-${r.id}`}
                    >
                      {formatConfidence(r.classificationConfidence)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {r.createdAt ? formatDateUae(r.createdAt.slice(0, 10)) : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{r.uploadedByName || "—"}</td>
                    <td className="px-3 py-2">
                      <StatusBadge
                        meta={inboxStatusLabel(r.status, r.error === "duplicate_file" || isHashDupe)}
                      />
                    </td>
                    <td className="px-3 py-2 space-x-2" onClick={(e) => e.stopPropagation()}>
                      {unassigned ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void routeHere(r.id)}
                              />
                            }
                          >
                            Route here
                          </TooltipTrigger>
                          <TooltipContent>
                            Assign this upload to the company you are working as, then queue
                            extraction.
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                      {r.status === "failed" ? (
                        <Button size="sm" variant="outline" onClick={() => void retry(r.id)}>
                          Retry
                        </Button>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Link
                              href={`/books/inbox/${r.id}`}
                              className="inline-flex h-8 items-center rounded-lg px-2.5 text-sm hover:bg-muted"
                            />
                          }
                        >
                          Review
                        </TooltipTrigger>
                        <TooltipContent>
                          Open the extraction review screen for this file (fields, parties, confirm).
                        </TooltipContent>
                      </Tooltip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > pageSize ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {page + 1} of {pageCount}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} onUploaded={() => void reload()} />
    </div>
  );
}
