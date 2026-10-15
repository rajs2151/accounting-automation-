"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
import { formatMinor } from "@/lib/money";

type AdvanceRow = {
  partyId: string;
  partyName: string;
  currency: string;
  balanceOriginalMinor: number;
  balanceAedMinor: number;
  vatOriginalMinor?: number;
  vatAedMinor?: number;
};

type DeferredRow = {
  id: string;
  documentId: string;
  documentNumber: string | null;
  partyName: string | null;
  releaseDate: string;
  amountAedMinor: number;
  revenueAccountCode: string;
  revenueAccountName: string;
  status: string;
};

type Panel = {
  advances: AdvanceRow[];
  advancesTotalAedMinor: number;
  deferred: DeferredRow[];
  deferredPendingTotalMinor: number;
  gl2320CreditMinor: number;
  subledgerAedMinor: number;
  driftMinor: number;
  drift: boolean;
};

export default function AdvancesPanelPage() {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/books/advances-panel");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(data) || data.error || "load_failed");
      setPanel(data as Panel);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
      setPanel(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6 py-4" data-testid="advances-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Advances & deferred revenue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only view of customer advances (2320) and pending deferred revenue releases (2310).
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {panel?.drift ? (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950"
          data-testid="advances-drift"
          role="status"
        >
          2320 GL ({formatMinor(panel.gl2320CreditMinor)} AED) does not match the advances subledger (
          {formatMinor(panel.subledgerAedMinor)} AED) — gap {formatMinor(panel.driftMinor)} AED.
        </div>
      ) : panel ? (
        <p className="text-sm text-muted-foreground" data-testid="advances-tieout-ok">
          2320 GL matches advances subledger ({formatMinor(panel.gl2320CreditMinor)} AED).
        </p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Customer advances (2320)</h2>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Currency</th>
                <th className="px-3 py-2 font-medium text-right">Net (2320)</th>
                <th className="px-3 py-2 font-medium text-right">VAT (2210)</th>
                <th className="px-3 py-2 font-medium text-right">Gross AED</th>
              </tr>
            </thead>
            <tbody>
              {(panel?.advances || []).map((r) => (
                <tr key={`${r.partyId}-${r.currency}`} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link className="underline-offset-2 hover:underline" href={`/books/parties`}>
                      {r.partyName}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.currency}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMinor(r.balanceAedMinor)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMinor(r.vatAedMinor || 0)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMinor(r.balanceAedMinor + (r.vatAedMinor || 0))}
                  </td>
                </tr>
              ))}
              {!loading && panel && panel.advances.length === 0 ? (
                <tr className="border-t border-border">
                  <td className="px-3 py-3 text-muted-foreground" colSpan={5}>
                    No open customer advances
                  </td>
                </tr>
              ) : null}
            </tbody>
            {panel && panel.advances.length > 0 ? (
              <tfoot>
                <tr className="border-t border-border bg-muted/20 font-medium">
                  <td className="px-3 py-2" colSpan={4}>
                    Net total AED (ties to 2320)
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMinor(panel.advancesTotalAedMinor)}
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Deferred revenue releases</h2>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Release date</th>
                <th className="px-3 py-2 font-medium">Document</th>
                <th className="px-3 py-2 font-medium">Party</th>
                <th className="px-3 py-2 font-medium">Revenue account</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right">AED</th>
              </tr>
            </thead>
            <tbody>
              {(panel?.deferred || []).map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 tabular-nums">{formatDateUae(r.releaseDate)}</td>
                  <td className="px-3 py-2">
                    <Link
                      className="underline-offset-2 hover:underline"
                      href={`/books/documents/${r.documentId}`}
                    >
                      {r.documentNumber || "Document"}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.partyName || "—"}</td>
                  <td className="px-3 py-2">
                    {r.revenueAccountCode} {r.revenueAccountName}
                  </td>
                  <td className="px-3 py-2 capitalize">{r.status}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMinor(r.amountAedMinor)}</td>
                </tr>
              ))}
              {!loading && panel && panel.deferred.length === 0 ? (
                <tr className="border-t border-border">
                  <td className="px-3 py-3 text-muted-foreground" colSpan={6}>
                    No pending deferred releases
                  </td>
                </tr>
              ) : null}
            </tbody>
            {panel && panel.deferred.length > 0 ? (
              <tfoot>
                <tr className="border-t border-border bg-muted/20 font-medium">
                  <td className="px-3 py-2" colSpan={5}>
                    Pending total
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMinor(panel.deferredPendingTotalMinor)}
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </section>
    </div>
  );
}
