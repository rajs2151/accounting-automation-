"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { displayToMinor, formatMinor, MoneyTypeError } from "@/lib/money";

type Doc = {
  id: string;
  status: string;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  printedNetMinor: number | null;
  printedVatMinor: number | null;
  printedGrossMinor: number | null;
  printedPaidMinor: number | null;
  printedBalanceDueMinor: number | null;
  currency?: string;
};

type PreviewLine = {
  accountCode: string;
  accountName: string;
  vatCode: string | null;
  debitMinor: number;
  creditMinor: number;
  currency: string;
  aedMinor: number;
};

function moneyClass(computed: number, printed: number | null) {
  if (printed == null) return "tabular-nums";
  return printed !== computed ? "tabular-nums text-red-600" : "tabular-nums";
}

export function DocumentReviewPanels({
  documentId,
  onApproved,
}: {
  documentId: string;
  onApproved?: () => void;
}) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [preview, setPreview] = useState<{
    lines: PreviewLine[];
    debitMinor: number;
    creditMinor: number;
    balanced: boolean;
  } | null>(null);
  const [printedNet, setPrintedNet] = useState("");
  const [printedVat, setPrintedVat] = useState("");
  const [printedGross, setPrintedGross] = useState("");
  const [printedPaid, setPrintedPaid] = useState("");
  const [printedBalance, setPrintedBalance] = useState("");
  const [blockReason, setBlockReason] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [dRes, pRes] = await Promise.all([
      fetch(`/api/books/documents/${documentId}`),
      fetch(`/api/books/documents/${documentId}/journal-preview`),
    ]);
    const d = await dRes.json();
    const p = await pRes.json();
    if (!dRes.ok) {
      toast.error(d.error || "document_load_failed");
      return;
    }
    if (!pRes.ok) {
      toast.error(p.error || "preview_failed");
      return;
    }
    setDoc(d as Doc);
    setPreview(p);
    setPrintedNet(d.printedNetMinor == null ? "" : formatMinor(d.printedNetMinor));
    setPrintedVat(d.printedVatMinor == null ? "" : formatMinor(d.printedVatMinor));
    setPrintedGross(d.printedGrossMinor == null ? "" : formatMinor(d.printedGrossMinor));
    setPrintedPaid(d.printedPaidMinor == null ? "" : formatMinor(d.printedPaidMinor));
    setPrintedBalance(
      d.printedBalanceDueMinor == null ? "" : formatMinor(d.printedBalanceDueMinor),
    );

    const reasons: string[] = [];
    const pn = d.printedNetMinor == null ? null : Number(d.printedNetMinor);
    const pv = d.printedVatMinor == null ? null : Number(d.printedVatMinor);
    const pg = d.printedGrossMinor == null ? null : Number(d.printedGrossMinor);
    if (pn != null && pn !== Number(d.netMinor)) reasons.push("Printed net ≠ computed");
    if (pv != null && pv !== Number(d.vatMinor)) reasons.push("Printed VAT ≠ computed");
    if (pg != null && pg !== Number(d.grossMinor)) reasons.push("Printed gross ≠ computed");
    // Soft UI check for VAT rate (server is authoritative)
    const maxVat = Math.floor((Number(d.netMinor) * 500 + 5000) / 10000) + 1;
    if (Number(d.vatMinor) > maxVat) reasons.push("VAT exceeds 5% of net");
    setBlockReason(reasons.length ? reasons.join("; ") : null);
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePrinted() {
    try {
      const body = {
        printedNetMinor: printedNet.trim() ? displayToMinor(printedNet) : null,
        printedVatMinor: printedVat.trim() ? displayToMinor(printedVat) : null,
        printedGrossMinor: printedGross.trim() ? displayToMinor(printedGross) : null,
        printedPaidMinor: printedPaid.trim() ? displayToMinor(printedPaid) : null,
        printedBalanceDueMinor: printedBalance.trim() ? displayToMinor(printedBalance) : null,
      };
      const res = await fetch(`/api/books/documents/${documentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "save_failed");
        return;
      }
      toast.success("Printed totals saved");
      void load();
    } catch (e) {
      toast.error(e instanceof MoneyTypeError ? "Invalid amount" : "save_failed");
    }
  }

  async function approve() {
    const res = await fetch(`/api/books/documents/${documentId}/approve`, {
      method: "POST",
      body: "{}",
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "approve_failed");
      void load();
      return;
    }
    toast.success(`Posted ${data.entryNo}`);
    onApproved?.();
    void load();
  }

  if (!doc) {
    return (
      <div data-testid="document-review-panels" className="text-sm text-muted-foreground">
        Loading review…
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="document-review-panels">
      <section
        className="space-y-2 rounded-lg border border-border p-3"
        data-testid="totals-panel"
      >
        <h3 className="text-sm font-semibold">Totals</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1" />
              <th>Computed</th>
              <th>Printed</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="py-1">Net</td>
              <td className="tabular-nums">{formatMinor(doc.netMinor)}</td>
              <td className={moneyClass(doc.netMinor, doc.printedNetMinor)}>
                <Input
                  data-testid="printed-net"
                  className="h-8"
                  value={printedNet}
                  onChange={(e) => setPrintedNet(e.target.value)}
                  placeholder="—"
                />
              </td>
            </tr>
            <tr>
              <td className="py-1">VAT</td>
              <td className="tabular-nums">{formatMinor(doc.vatMinor)}</td>
              <td className={moneyClass(doc.vatMinor, doc.printedVatMinor)}>
                <Input
                  data-testid="printed-vat"
                  className="h-8"
                  value={printedVat}
                  onChange={(e) => setPrintedVat(e.target.value)}
                  placeholder="—"
                />
              </td>
            </tr>
            <tr>
              <td className="py-1">Gross</td>
              <td className="tabular-nums">{formatMinor(doc.grossMinor)}</td>
              <td className={moneyClass(doc.grossMinor, doc.printedGrossMinor)}>
                <Input
                  data-testid="printed-gross"
                  className="h-8"
                  value={printedGross}
                  onChange={(e) => setPrintedGross(e.target.value)}
                  placeholder="—"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <Button size="sm" variant="outline" onClick={() => void savePrinted()}>
          Save printed totals
        </Button>
        {blockReason ? (
          <p className="text-sm text-red-600" data-testid="approve-block-reason">
            {blockReason}
          </p>
        ) : null}
      </section>

      <section
        className="space-y-2 rounded-lg border border-border p-3"
        data-testid="payments-made-panel"
      >
        <h3 className="text-sm font-semibold">Payments made / Balance due</h3>
        <p className="text-xs text-muted-foreground">Info only — not a payment</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Payments made</Label>
            <Input
              data-testid="printed-paid"
              value={printedPaid}
              onChange={(e) => setPrintedPaid(e.target.value)}
              placeholder="—"
            />
          </div>
          <div>
            <Label className="text-xs">Balance due</Label>
            <Input
              data-testid="printed-balance-due"
              value={printedBalance}
              onChange={(e) => setPrintedBalance(e.target.value)}
              placeholder="—"
            />
          </div>
        </div>
      </section>

      <section
        className="space-y-2 rounded-lg border border-border p-3"
        data-testid="journal-preview-panel"
      >
        <h3 className="text-sm font-semibold">Journal preview</h3>
        {preview ? (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">Account</th>
                  <th>VAT</th>
                  <th className="text-right">Debit</th>
                  <th className="text-right">Credit</th>
                  <th className="text-right">AED</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l, i) => (
                  <tr key={`${l.accountCode}-${i}`} className="border-t border-border">
                    <td className="py-1">
                      {l.accountCode} {l.accountName}
                    </td>
                    <td>{l.vatCode || "—"}</td>
                    <td className="text-right tabular-nums">
                      {l.debitMinor ? formatMinor(l.debitMinor) : ""}
                    </td>
                    <td className="text-right tabular-nums">
                      {l.creditMinor ? formatMinor(l.creditMinor) : ""}
                    </td>
                    <td className="text-right tabular-nums">{formatMinor(l.aedMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p
              className={
                preview.balanced ? "text-xs text-emerald-700" : "text-xs text-red-600"
              }
              data-testid="journal-preview-balance"
            >
              {preview.balanced
                ? `Balanced · Dr ${formatMinor(preview.debitMinor)} = Cr ${formatMinor(preview.creditMinor)}`
                : `Unbalanced · Dr ${formatMinor(preview.debitMinor)} ≠ Cr ${formatMinor(preview.creditMinor)}`}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Loading preview…</p>
        )}
      </section>

      {doc.status === "draft" ? (
        <Button
          data-testid="review-approve"
          disabled={Boolean(blockReason)}
          title={blockReason || undefined}
          onClick={() => void approve()}
        >
          Approve
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">Status: {doc.status}</p>
      )}
    </div>
  );
}
