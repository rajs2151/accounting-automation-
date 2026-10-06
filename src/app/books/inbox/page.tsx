"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/books/empty-state";
import { StatusBadge } from "@/components/books/status-badge";
import { showUploadFeedback } from "@/components/books/upload-feedback";
import { Button } from "@/components/ui/button";
import { docTypeLabel, inboxStatusLabel } from "@/lib/status-labels";
import { Inbox } from "lucide-react";
import { apiErrorMessage } from "@/lib/api-error";

type InboxRow = {
  id: string;
  clientId: string | null;
  filename: string;
  detectedType: string | null;
  classificationConfidence: number | null;
  status: string;
  error: string | null;
  sha256: string;
};

export default function InboxPage() {
  const searchParams = useSearchParams();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<InboxRow[]>([]);
  // Deep link from the dashboard: /books/inbox?unassigned=1 opens the firm-wide unassigned list.
  const [unassigned, setUnassigned] = useState(() => searchParams.get("unassigned") === "1");

  const reload = useCallback(async () => {
    const qs = unassigned ? "?unassigned=1" : "";
    const data = await fetch(`/api/books/inbox${qs}`).then((r) => r.json());
    if (Array.isArray(data)) setRows(data);
  }, [unassigned]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (searchParams.get("upload") !== "1") return;
    uploadInputRef.current?.click();
    const url = new URL(window.location.href);
    url.searchParams.delete("upload");
    window.history.replaceState({}, "", url.pathname + url.search);
  }, [searchParams]);

  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData();
    if (unassigned) form.set("unassigned", "1");
    for (const f of Array.from(files)) form.append("files", f);
    const res = await fetch("/api/books/inbox/upload", { method: "POST", body: form });
    showUploadFeedback(res.ok, await res.json().catch(() => ({})));
    if (!res.ok) return;
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

  async function pickType(id: string, docType: string) {
    const res = await fetch(`/api/books/inbox/${id}/type`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType }),
    });
    if (!res.ok) {
      toast.error(apiErrorMessage(await res.json().catch(() => ({}))));
      return;
    }
    void reload();
  }

  return (
    <div className="space-y-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{unassigned ? "Unassigned inbox" : "Inbox"}</h1>
        <div className="flex gap-2">
          <Button variant={unassigned ? "outline" : "default"} onClick={() => setUnassigned(false)}>
            Company
          </Button>
          <Button variant={unassigned ? "default" : "outline"} onClick={() => setUnassigned(true)}>
            Unassigned
          </Button>
          <label className="inline-flex cursor-pointer items-center rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
            Upload
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              className="hidden"
              data-testid="inbox-upload"
              onChange={(e) => void onUpload(e.target.files)}
            />
          </label>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Nothing extracted posts without human confirmation. Low-confidence types need a manual pick.
      </p>

      {!rows.length ? (
        <EmptyState
          data-testid="inbox-empty-state"
          icon={Inbox}
          title="No documents yet"
          hint="Upload invoices or statements to start review."
          actionLabel="Upload"
          onAction={() => uploadInputRef.current?.click()}
        />
      ) : (
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">File</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Confidence</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="group cursor-pointer border-t border-border hover:bg-muted/30"
                onClick={() => {
                  window.location.href = `/books/inbox/${r.id}`;
                }}
              >
                <td className="px-3 py-2">
                  <span className="text-foreground">{r.filename}</span>
                  {r.error === "duplicate_file" && (
                    <span className="ml-2 text-xs text-amber-700">already uploaded - see the original</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge meta={docTypeLabel(r.detectedType)} />
                </td>
                <td className="px-3 py-2">
                  {r.classificationConfidence == null
                    ? "—"
                    : `${Math.round(Number(r.classificationConfidence) * 100)}%`}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge
                    meta={inboxStatusLabel(r.status, r.error === "duplicate_file")}
                  />
                </td>
                <td className="px-3 py-2 space-x-2" onClick={(e) => e.stopPropagation()}>
                  {unassigned && (
                    <Button size="sm" variant="outline" onClick={() => void routeHere(r.id)}>
                      Route here
                    </Button>
                  )}
                  {!r.detectedType && r.status !== "failed" && (
                    <select
                      className="h-8 rounded border border-input bg-background px-1 text-xs"
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) void pickType(r.id, e.target.value);
                      }}
                    >
                      <option value="">Pick type…</option>
                      <option value="sales_invoice">Sales invoice</option>
                      <option value="purchase_bill">Purchase bill</option>
                      <option value="bank_statement">Bank statement</option>
                      <option value="card_statement">Card statement</option>
                      <option value="gateway_statement">Gateway CSV</option>
                      <option value="trial_balance">Trial balance</option>
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
