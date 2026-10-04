"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { BooksDateInput } from "@/components/books/date-input";
import { useBooksShell } from "@/components/books/books-shell-context";
import { DocumentReviewPanels } from "@/components/books/document-review-panels";
import { OpenItemKpiTiles } from "@/components/books/open-item-kpis";
import { BooksSideDrawer } from "@/components/books/side-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { displayToMinor, formatMinor, MoneyTypeError } from "@/lib/money";

type Doc = {
  id: string;
  documentNumber: string | null;
  partyName: string;
  issueDate: string;
  status: string;
  grossMinor: number;
  deferRevenue: boolean;
};

type Party = { id: string; name: string };

export default function SalesPage() {
  const { periodId, periods } = useBooksShell();
  const [rows, setRows] = useState<Doc[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(null);
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
  });

  const reload = useCallback(async () => {
    const [docs, pts] = await Promise.all([
      fetch("/api/books/documents?docType=sales_invoice").then((r) => r.json()),
      fetch("/api/books/parties?partyType=customer").then((r) => r.json()),
    ]);
    if (Array.isArray(docs)) setRows(docs);
    if (Array.isArray(pts)) {
      setParties(pts);
      if (!form.partyId && pts[0]) setForm((f) => ({ ...f, partyId: pts[0].id }));
    }
  }, [form.partyId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function createInvoice() {
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
      documentNumber: form.documentNumber || undefined,
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
      toast.error(data.error || "create_failed");
      return;
    }
    toast.success("Draft invoice created — switch to approver to post");
    void reload();
  }

  async function approve(id: string) {
    const res = await fetch(`/api/books/documents/${id}/approve`, { method: "POST", body: "{}" });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "approve_failed");
      return;
    }
    toast.success(`Posted ${data.entryNo}`);
    void reload();
  }

  const periodLabel = periods.find((p) => p.id === periodId)?.label;

  return (
    <div className="space-y-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Sales invoices</h1>
          <p className="text-sm text-muted-foreground">Period context: {periodLabel || "—"}</p>
        </div>
        <div className="flex gap-2">
          <label className="inline-flex cursor-pointer items-center rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
            Upload Invoices
            <input
              type="file"
              multiple
              accept=".pdf,image/*"
              className="hidden"
              data-testid="sales-upload"
              onChange={(e) => {
                const files = e.target.files;
                if (!files?.length) return;
                const body = new FormData();
                for (const f of Array.from(files)) body.append("files", f);
                void fetch("/api/books/inbox/upload", { method: "POST", body }).then(async (res) => {
                  const data = await res.json();
                  if (!res.ok) toast.error(data.error || "upload_failed");
                  else toast.success(`Uploaded ${data.results?.length || 0} — review in Inbox`);
                });
              }}
            />
          </label>
          <Button variant="outline" onClick={() => toast.message("Use the form below to record manually")}>
            Record manually
          </Button>
        </div>
      </div>

      <OpenItemKpiTiles side="AR" />

      <div className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3">
        <div>
          <Label>Customer</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={form.partyId}
            onChange={(e) => setForm({ ...form, partyId: e.target.value })}
          >
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Invoice no</Label>
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
          <Label>Service start / end (multi-month → defer default)</Label>
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
          <Button onClick={() => void createInvoice()}>Save draft</Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Number</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Gross</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2">{r.documentNumber || "—"}</td>
                <td className="px-3 py-2">{r.partyName}</td>
                <td className="px-3 py-2">{String(r.issueDate).slice(0, 10)}</td>
                <td className="px-3 py-2">{formatMinor(r.grossMinor)}</td>
                <td className="px-3 py-2">
                  {r.status}
                  {r.deferRevenue ? " · deferred" : ""}
                </td>
                <td className="space-x-2 px-3 py-2">
                  <Button size="sm" variant="outline" onClick={() => setReviewId(r.id)}>
                    Review
                  </Button>
                  {r.status === "draft" && (
                    <Button size="sm" variant="outline" onClick={() => void approve(r.id)}>
                      Approve
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
