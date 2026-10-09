"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";

import { useBooksShell } from "@/components/books/books-shell-context";
import { ReportsNav, useReportMeta } from "@/components/books/report-table";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
import { formatMinor } from "@/lib/money";

type BoxId =
  | "1a"
  | "1b"
  | "1c"
  | "1d"
  | "1e"
  | "1f"
  | "1g"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "9"
  | "10";

type Vat201Draft = {
  from: string;
  to: string;
  boxes: Record<BoxId, { amountMinor: number; vatMinor: number }>;
  box8: { amountMinor: number; vatMinor: number };
  box11: { amountMinor: number; vatMinor: number };
  box12DueTaxMinor: number;
  box13RecoverableTaxMinor: number;
  box14PayableMinor: number;
  unlinked: { outputVatMinor: number; inputVatMinor: number; lineCount: number };
};

type PosGap = {
  id: string;
  docType: string;
  documentNumber: string | null;
  issueDate: string;
  partyName: string;
  why: string;
};

const BOX_ROWS: Array<{ id: BoxId | "8" | "11" | "12" | "13" | "14"; label: string }> = [
  { id: "1a", label: "1a · Standard rated supplies — Abu Dhabi" },
  { id: "1b", label: "1b · Standard rated supplies — Dubai" },
  { id: "1c", label: "1c · Standard rated supplies — Sharjah" },
  { id: "1d", label: "1d · Standard rated supplies — Ajman" },
  { id: "1e", label: "1e · Standard rated supplies — Umm Al Quwain" },
  { id: "1f", label: "1f · Standard rated supplies — Ras Al Khaimah" },
  { id: "1g", label: "1g · Standard rated supplies — Fujairah" },
  { id: "2", label: "2 · Tax refunds provided to tourists" },
  { id: "3", label: "3 · Supplies subject to reverse charge provisions" },
  { id: "4", label: "4 · Zero-rated supplies" },
  { id: "5", label: "5 · Exempt supplies" },
  { id: "6", label: "6 · Goods imported into the UAE" },
  { id: "7", label: "7 · Adjustments and corrections" },
  { id: "8", label: "8 · Totals (output)" },
  { id: "9", label: "9 · Standard rated expenses" },
  { id: "10", label: "10 · Supplies subject to reverse charge (recoverable)" },
  { id: "11", label: "11 · Totals (input)" },
  { id: "12", label: "12 · Total due tax for the period" },
  { id: "13", label: "13 · Total recoverable tax for the period" },
  { id: "14", label: "14 · Net VAT payable / (reclaimable)" },
];

const WHY_LABEL: Record<string, string> = {
  company_emirate_missing: "Company establishment emirate not set",
  party_emirate_missing: "Party emirate missing",
  mixed_supply: "Mixed supply — set place of supply on the document",
};

function aed(n: number) {
  return formatMinor(n);
}

/** FTA VAT return due date = period end + 28 days (same rule as dashboard). */
function dueDateFromPeriodEnd(periodEnd: string): string {
  const d = new Date(`${periodEnd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 28);
  return d.toISOString().slice(0, 10);
}

type SettlementStatus = {
  id: string;
  periodFrom: string;
  periodTo: string;
  dueDate: string;
  payableMinor: number;
  journalEntryId: string;
  journalStatus: string;
  journalReference: string | null;
  alreadyPrepared: boolean;
};

function Vat201Inner() {
  const meta = useReportMeta();
  const { periodId, periods } = useBooksShell();
  const [draft, setDraft] = useState<Vat201Draft | null>(null);
  const [error, setError] = useState("");
  const [gaps, setGaps] = useState<PosGap[]>([]);
  const [loading, setLoading] = useState(false);
  const [settlement, setSettlement] = useState<SettlementStatus | null>(null);
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleMsg, setSettleMsg] = useState("");

  const periodEnd = useMemo(() => {
    const p = periods.find((x) => x.id === periodId);
    return p?.periodEnd ? String(p.periodEnd).slice(0, 10) : "";
  }, [periods, periodId]);

  useEffect(() => {
    if (!periodEnd) return;
    setLoading(true);
    setGaps([]);
    setSettlement(null);
    setSettleMsg("");
    void fetch(`/api/books/vat201/draft?monthEnd=${encodeURIComponent(periodEnd)}`)
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        return [r.ok, r.status, json] as const;
      })
      .then(([ok, status, json]) => {
        if (!ok) {
          setDraft(null);
          setError(apiErrorMessage(json));
          if (status === 409 && Array.isArray(json.gaps)) {
            setGaps(json.gaps as PosGap[]);
          } else {
            setGaps([]);
          }
        } else {
          setError("");
          setGaps([]);
          setDraft(json as Vat201Draft);
        }
      })
      .finally(() => setLoading(false));

    void fetch(`/api/books/vat201/settlement?monthEnd=${encodeURIComponent(periodEnd)}`)
      .then(async (r) => {
        const json = await r.json().catch(() => null);
        if (r.ok && json && json.journalEntryId) setSettlement(json as SettlementStatus);
      })
      .catch(() => undefined);
  }, [periodEnd]);

  async function prepareSettlement() {
    if (!periodEnd) return;
    setSettleBusy(true);
    setSettleMsg("");
    try {
      const res = await fetch("/api/books/vat201/settlement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthEnd: periodEnd }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSettleMsg(apiErrorMessage(json));
        return;
      }
      const s = json as SettlementStatus;
      setSettlement(s);
      setSettleMsg(
        s.alreadyPrepared
          ? `Settlement already prepared (${s.journalStatus}).`
          : "Draft settlement journal prepared — an approver must post it.",
      );
    } finally {
      setSettleBusy(false);
    }
  }

  const amountFor = (id: (typeof BOX_ROWS)[number]["id"]): { amount: number | null; vat: number | null } => {
    if (!draft) return { amount: null, vat: null };
    if (id === "8") return { amount: draft.box8.amountMinor, vat: draft.box8.vatMinor };
    if (id === "11") return { amount: draft.box11.amountMinor, vat: draft.box11.vatMinor };
    if (id === "12") return { amount: null, vat: draft.box12DueTaxMinor };
    if (id === "13") return { amount: null, vat: draft.box13RecoverableTaxMinor };
    if (id === "14") return { amount: null, vat: draft.box14PayableMinor };
    const b = draft.boxes[id];
    return { amount: b.amountMinor, vat: b.vatMinor };
  };

  const rangeLabel =
    draft?.from && draft?.to
      ? `${formatDateUae(draft.from)} – ${formatDateUae(draft.to)}`
      : periodEnd
        ? `VAT period containing ${formatDateUae(periodEnd)}`
        : "—";

  return (
    <div className="space-y-4" data-testid="vat201-report">
      <ReportsNav active="vat201" />
      <header className="space-y-1">
        <h1 className="font-heading text-2xl tracking-tight">VAT 201 (draft)</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Draft boxes from posted journals for the company&apos;s VAT return window (monthly or
          quarterly). Filing stays in the FTA portal; use Prepare settlement JV to clear 2210/1430 into
          2220 as a draft (dual-control post).
        </p>
        <p className="text-sm text-muted-foreground" data-testid="vat201-range">
          {meta.company ? `${meta.company} · ` : null}
          {rangeLabel}
          {draft?.to ? ` · Due ${formatDateUae(settlement?.dueDate || dueDateFromPeriodEnd(draft.to))}` : null}
          {meta.preparedBy ? ` · Prepared as ${meta.preparedBy}` : null}
        </p>
      </header>

      {loading ? <p className="text-sm text-muted-foreground">Loading draft…</p> : null}
      {error ? (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <p data-testid="vat201-error">{error}</p>
          {gaps.length ? (
            <ul className="list-disc space-y-1 pl-5" data-testid="vat201-gaps">
              {gaps.slice(0, 12).map((g) => {
                const sales =
                  g.docType === "sales_invoice" || g.docType === "credit_note";
                return (
                  <li key={g.id}>
                    <Link
                      className="underline underline-offset-2"
                      href={sales ? "/books/sales?tab=needs_review" : "/books/purchases?tab=needs_review"}
                    >
                      {g.documentNumber || g.docType}
                    </Link>
                    {` · ${g.partyName} · ${formatDateUae(g.issueDate)} · ${WHY_LABEL[g.why] || g.why}`}
                  </li>
                );
              })}
              {gaps.length > 12 ? <li>…and {gaps.length - 12} more</li> : null}
            </ul>
          ) : null}
          {(error.includes("emirate") || error.includes("stagger") || error.includes("VAT")) && (
            <p>
              <Link href="/books/settings" className="underline underline-offset-2">
                Open company VAT settings
              </Link>
            </p>
          )}
        </div>
      ) : null}

      {draft ? (
        <>
          {draft.unlinked.lineCount > 0 ? (
            <p
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              data-testid="vat201-unlinked"
            >
              {draft.unlinked.lineCount} VAT control line(s) not linked to a document (output{" "}
              {aed(draft.unlinked.outputVatMinor)}, input {aed(draft.unlinked.inputVatMinor)}). Review
              manual journals before filing.
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm" data-testid="vat201-boxes">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-3 py-2 font-medium">Box</th>
                  <th className="px-3 py-2 text-right font-medium">Amount (AED)</th>
                  <th className="px-3 py-2 text-right font-medium">VAT (AED)</th>
                </tr>
              </thead>
              <tbody>
                {BOX_ROWS.map((row) => {
                  const { amount, vat } = amountFor(row.id);
                  const strong = row.id === "8" || row.id === "11" || row.id === "14";
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-border ${strong ? "bg-muted/20 font-medium" : ""}`}
                      data-testid={`vat201-box-${row.id}`}
                    >
                      <td className="px-3 py-2">{row.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {amount == null ? "—" : amount === 0 ? "" : aed(amount)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {vat == null ? "—" : vat === 0 && !strong ? "" : aed(vat)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.print()}
              data-testid="vat201-print"
            >
              Print
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={settleBusy || Boolean(error)}
              onClick={() => void prepareSettlement()}
              data-testid="vat201-prepare-settlement"
            >
              {settlement ? "Open settlement draft" : "Prepare settlement JV"}
            </Button>
            {settlement ? (
              <Link
                href={`/books/journals?q=${encodeURIComponent(settlement.journalReference || settlement.journalEntryId)}`}
                className="inline-flex h-8 items-center rounded-lg border border-input px-3 text-sm hover:bg-muted"
                data-testid="vat201-settlement-link"
              >
                {settlement.journalReference || "Draft JV"} · {settlement.journalStatus}
                {settlement.payableMinor !== 0
                  ? ` · ${aed(Math.abs(settlement.payableMinor))} ${settlement.payableMinor > 0 ? "payable" : "reclaim"}`
                  : ""}
              </Link>
            ) : null}
            <Link
              href="/books/close"
              className="inline-flex h-8 items-center rounded-lg border border-input px-3 text-sm hover:bg-muted"
            >
              Close checklist
            </Link>
          </div>
          {settleMsg ? (
            <p className="text-sm text-muted-foreground" data-testid="vat201-settle-msg">
              {settleMsg}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default function BooksVat201ReportPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      <Vat201Inner />
    </Suspense>
  );
}
