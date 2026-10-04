"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { BooksDateInput } from "@/components/books/date-input";
import { useBooksShell } from "@/components/books/books-shell-context";
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
};

type Party = { id: string; name: string; trn: string | null };

export default function PurchasesPage() {
  const { periodId } = useBooksShell();
  const [rows, setRows] = useState<Doc[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [form, setForm] = useState({
    partyId: "",
    documentNumber: "",
    issueDate: "2026-05-16",
    netAed: "200.00",
    lineKind: "expense" as "expense" | "disbursement",
    vatCode: "SR",
  });

  const reload = useCallback(async () => {
    const [docs, pts] = await Promise.all([
      fetch("/api/books/documents?docType=purchase_bill").then((r) => r.json()),
      fetch("/api/books/parties?partyType=supplier").then((r) => r.json()),
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
      toast.error(data.error || "create_failed");
      return;
    }
    toast.success("Draft bill created — switch to approver to post");
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

  return (
    <div className="space-y-4 py-4">
      <h1 className="text-2xl font-semibold">Purchase bills</h1>
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
          <Button onClick={() => void createBill()}>New Bill</Button>
        </div>
      </div>

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
              <td className="text-right">
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
    </div>
  );
}
