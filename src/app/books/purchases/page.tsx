"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { BooksDateInput } from "@/components/books/date-input";
import { useBooksShell } from "@/components/books/books-shell-context";
import { DocumentReviewPanels } from "@/components/books/document-review-panels";
import { OpenItemKpiTiles } from "@/components/books/open-item-kpis";
import { BooksSideDrawer } from "@/components/books/side-drawer";
import { showUploadFeedback } from "@/components/books/upload-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";
import { displayToMinor, formatMinor, MoneyTypeError } from "@/lib/money";

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
};

type Tab = "bills" | "uploads";

export default function PurchasesPage() {
  const { periodId } = useBooksShell();
  const [tab, setTab] = useState<Tab>("bills");
  const [rows, setRows] = useState<Doc[]>([]);
  const [uploads, setUploads] = useState<InboxRow[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
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
    if (Array.isArray(inbox)) setUploads(inbox);
  }, [form.partyId]);

  useEffect(() => {
    void reload();
  }, [reload]);

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

      <div className="flex gap-2" data-testid="purchase-tabs">
        <Button variant={tab === "bills" ? "default" : "outline"} onClick={() => setTab("bills")}>
          Bills
        </Button>
        <Button
          variant={tab === "uploads" ? "default" : "outline"}
          onClick={() => setTab("uploads")}
          data-testid="purchase-uploads-tab"
        >
          Uploads
        </Button>
      </div>

      {tab === "uploads" ? (
        <table className="w-full text-sm" data-testid="purchase-uploads-table">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2">File</th>
              <th>Status</th>
              <th>Type</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {uploads.map((u) => (
              <tr key={u.id} className="border-t border-border">
                <td className="py-2">
                  <Link className="text-primary underline" href={`/books/inbox/${u.id}`}>
                    {u.filename}
                  </Link>
                </td>
                <td data-testid={`upload-status-${u.id}`}>
                  {u.error === "duplicate_file" ? "Duplicate" : u.status}
                </td>
                <td>{u.detectedType || "—"}</td>
                <td className="space-x-2 text-right">
                  {u.error !== "duplicate_file" && (u.status === "failed" || u.status === "needs_review") ? (
                    <Button size="sm" variant="outline" onClick={() => void retry(u.id)}>
                      Retry
                    </Button>
                  ) : null}
                  <Link
                    className="text-sm text-primary underline"
                    href={`/books/inbox/${u.id}`}
                  >
                    Review
                  </Link>
                </td>
              </tr>
            ))}
            {!uploads.length ? (
              <tr>
                <td colSpan={4} className="py-6 text-muted-foreground">
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

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-2">Number</th>
                <th>Supplier</th>
                <th>Date</th>
                <th>Gross</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-2">{r.documentNumber || "—"}</td>
                  <td>{r.partyName}</td>
                  <td>{r.issueDate?.slice(0, 10).split("-").reverse().join("/")}</td>
                  <td>{formatMinor(r.grossMinor)}</td>
                  <td>{r.status}</td>
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
