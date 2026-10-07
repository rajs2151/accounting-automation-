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
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
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

function formatBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Uploaded</th>
                <th className="px-3 py-2">By</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr
                  key={r.id}
                  className="group border-t border-border"
                  {...rowOpenProps(() => {
                    window.location.href = `/books/inbox/${r.id}`;
                  })}
                >
                  <td className="px-3 py-2">
                    <span className="text-foreground">{r.filename}</span>
                    {r.status === "failed" && r.error ? (
                      <div className="mt-0.5 text-xs text-destructive">{r.error}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {formatBytes(r.byteSize)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge meta={docTypeLabel(r.intendedType || r.detectedType)} />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.createdAt ? formatDateUae(r.createdAt.slice(0, 10)) : "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{r.uploadedByName || "—"}</td>
                  <td className="px-3 py-2">
                    <StatusBadge
                      meta={inboxStatusLabel(r.status, r.error === "duplicate_file")}
                    />
                  </td>
                  <td className="px-3 py-2 space-x-2" onClick={(e) => e.stopPropagation()}>
                    {unassigned ? (
                      <Button size="sm" variant="outline" onClick={() => void routeHere(r.id)}>
                        Route here
                      </Button>
                    ) : null}
                    {r.status === "failed" ? (
                      <Button size="sm" variant="outline" onClick={() => void retry(r.id)}>
                        Retry
                      </Button>
                    ) : null}
                    <Link
                      href={`/books/inbox/${r.id}`}
                      className="inline-flex h-8 items-center rounded-lg px-2.5 text-sm hover:bg-muted"
                    >
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
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
