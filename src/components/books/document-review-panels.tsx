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
  docType?: string;
  partyId?: string | null;
  issueDate?: string | null;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  printedNetMinor: number | null;
  printedVatMinor: number | null;
  printedGrossMinor: number | null;
  printedPaidMinor: number | null;
  printedBalanceDueMinor: number | null;
  checkVatReason?: string | null;
  checkVatAckBy?: string | null;
  checkVatAckAt?: string | null;
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
  onApprovedAndNext,
  hideApproveActions = false,
}: {
  documentId: string;
  onApproved?: () => void;
  /** After a successful approve, navigate to the next needs-review item (C1-3). */
  onApprovedAndNext?: () => void;
  /** When true, header chrome owns Approve (ING-3 full review). */
  hideApproveActions?: boolean;
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
  const [advanceBalanceMinor, setAdvanceBalanceMinor] = useState(0);
  const [applyAdvance, setApplyAdvance] = useState(false);
  const [applyAdvanceAed, setApplyAdvanceAed] = useState("");

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
    setApplyAdvance(false);
    setApplyAdvanceAed("");
    setAdvanceBalanceMinor(0);
    if (d.docType === "sales_invoice" && d.partyId && d.status === "draft") {
      const advRes = await fetch(
        `/api/books/parties/${d.partyId}/advances?currency=${encodeURIComponent(d.currency || "AED")}`,
      );
      const adv = await advRes.json().catch(() => ({}));
      if (advRes.ok) {
        const bal = Number(adv.balanceOriginalMinor || 0);
        setAdvanceBalanceMinor(bal);
        if (bal > 0) {
          const max = Math.min(bal, Number(d.grossMinor || 0));
          setApplyAdvanceAed(formatMinor(max));
        }
      }
    }
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
    if (d.checkVatReason && !d.checkVatAckAt) {
      reasons.push("Check VAT — acknowledge before approve");
    }
    setBlockReason(reasons.length ? reasons.join("; ") : null);
  }, [documentId]);

  async function ackCheckVat() {
    const res = await fetch(`/api/books/documents/${documentId}/ack-check-vat`, {
      method: "POST",
      body: "{}",
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "ack_failed");
      return;
    }
    toast.success("VAT check acknowledged");
    void load();
  }

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

  async function approve(opts?: { andNext?: boolean }) {
    let applyAdvanceOriginalMinor: number | undefined;
    if (applyAdvance && doc?.docType === "sales_invoice") {
      try {
        const n = displayToMinor(applyAdvanceAed);
        if (n != null && n > 0) applyAdvanceOriginalMinor = n;
      } catch {
        toast.error("Invalid advance amount");
        return;
      }
      if (applyAdvanceOriginalMinor != null) {
        const max = Math.min(advanceBalanceMinor, Number(doc.grossMinor || 0));
        if (applyAdvanceOriginalMinor > max) {
          toast.error(`Advance apply cannot exceed ${formatMinor(max)}`);
          return;
        }
      }
    }
    const res = await fetch(`/api/books/documents/${documentId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ applyAdvanceOriginalMinor }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "approve_failed");
      void load();
      return;
    }
    toast.success(
      data.advanceAllocation
        ? `Posted ${data.entryNo} · applied advance ${formatMinor(data.advanceAllocation.amountOriginalMinor)}`
        : `Posted ${data.entryNo}`,
    );
    if (opts?.andNext && onApprovedAndNext) {
      onApprovedAndNext();
      return;
    }
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
        data-testid="document-totals-panel"
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

      {doc.checkVatReason ? (
        <section
          className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3"
          data-testid="check-vat-banner"
        >
          <h3 className="text-sm font-semibold text-amber-900">Check VAT</h3>
          <p className="text-sm text-amber-900" data-testid="check-vat-reason">
            {doc.checkVatReason}
          </p>
          {doc.checkVatAckAt ? (
            <p className="text-xs text-muted-foreground" data-testid="check-vat-acked">
              Acknowledged
            </p>
          ) : doc.status === "draft" ? (
            <Button size="sm" variant="outline" data-testid="ack-check-vat" onClick={() => void ackCheckVat()}>
              Acknowledge
            </Button>
          ) : null}
        </section>
      ) : null}

      {doc.status === "draft" &&
      doc.docType === "sales_invoice" &&
      advanceBalanceMinor > 0 ? (
        <section
          className="space-y-2 rounded-lg border border-border p-3"
          data-testid="apply-advance-panel"
        >
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={applyAdvance}
              onChange={(e) => setApplyAdvance(e.target.checked)}
              data-testid="apply-advance-toggle"
            />
            <span>
              Apply customer advance{" "}
              <span className="text-muted-foreground">
                (available {formatMinor(advanceBalanceMinor)}; off by default)
              </span>
            </span>
          </label>
          {applyAdvance ? (
            <div>
              <Label className="text-xs">Amount to apply</Label>
              <Input
                value={applyAdvanceAed}
                onChange={(e) => setApplyAdvanceAed(e.target.value)}
                inputMode="decimal"
                data-testid="apply-advance-amount"
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {doc.status === "draft" && !hideApproveActions ? (
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="review-approve"
            disabled={Boolean(blockReason)}
            title={blockReason || undefined}
            onClick={() => void approve()}
          >
            Approve
          </Button>
          {onApprovedAndNext ? (
            <Button
              data-testid="review-approve-next"
              variant="secondary"
              disabled={Boolean(blockReason)}
              title={blockReason || undefined}
              onClick={() => void approve({ andNext: true })}
            >
              Approve &amp; Next
            </Button>
          ) : null}
        </div>
      ) : doc.status !== "draft" ? (
        <p className="text-sm text-muted-foreground">Status: {doc.status}</p>
      ) : null}
    </div>
  );
}
