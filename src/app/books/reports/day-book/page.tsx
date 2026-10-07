"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { useBooksShell } from "@/components/books/books-shell-context";
import {
  ReportsNav,
  ReportTable,
  trailParam,
  useReportMeta,
  type ReportColumn,
} from "@/components/books/report-table";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";

// Same list as DAY_BOOK_TYPES (server/books/day-book.ts = vouchers.ts VOUCHER_TYPES + Reversal).
const TYPES = [
  "Sales", "Purchase", "Receipt", "Payment", "Contra", "Journal", "Expense", "Credit Note", "Debit Note", "Opening", "Closing", "Reversal",
];

type DayBook = {
  from: string;
  to: string;
  rows: Array<{
    entryId: string;
    date: string;
    particulars: string;
    party: string | null;
    partySide: "Dr" | "Cr" | null;
    type: string;
    number: string | null;
    debitMinor: number;
    creditMinor: number;
    lines?: Array<{ accountCode: string; accountName: string; debitMinor: number; creditMinor: number }>;
  }>;
  totalDebitMinor: number;
  totalCreditMinor: number;
};

const COLUMNS: ReportColumn[] = [
  { key: "date", label: "Date", kind: "text" },
  { key: "type", label: "Type", kind: "text" },
  { key: "number", label: "Number", kind: "text" },
  { key: "party", label: "Party", kind: "text" },
  { key: "debit", label: "Debit" },
  { key: "credit", label: "Credit" },
];

/** "Customer A · Cr" — the party and whether it was debited or credited by the voucher. */
function partyText(r: { party: string | null; partySide: "Dr" | "Cr" | null }): string {
  if (!r.party) return "";
  return r.partySide ? `${r.party} · ${r.partySide}` : r.party;
}

function DayBookInner() {
  const router = useRouter();
  const params = useSearchParams();
  const meta = useReportMeta();
  const { periodId } = useBooksShell();
  const [from, setFrom] = useState(params.get("from") || "");
  const [to, setTo] = useState(params.get("to") || "");
  const [type, setType] = useState(params.get("type") || "");
  const [data, setData] = useState<DayBook | null>(null);
  const [error, setError] = useState("");

  // Default range = the top-bar period.
  useEffect(() => {
    if ((from && to) || !periodId) return;
    void fetch("/api/books/periods")
      .then((r) => r.json())
      .then((list: Array<{ id: string; periodStart: string; periodEnd: string }>) => {
        const p = Array.isArray(list) ? list.find((x) => x.id === periodId) : null;
        if (p) {
          setFrom(String(p.periodStart).slice(0, 10));
          setTo(String(p.periodEnd).slice(0, 10));
        }
      });
  }, [periodId, from, to]);

  useEffect(() => {
    if (!from || !to) return;
    const qs = new URLSearchParams({ from, to });
    if (type) qs.set("type", type);
    // Keep the view in the URL so returning from a drill-down restores it.
    router.replace(`/books/reports/day-book?${qs}`, { scroll: false });
    void fetch(`/api/books/reports/day-book?${qs}`)
      .then(async (r) => [r.ok, await r.json()] as const)
      .then(([ok, json]) => {
        if (!ok) {
          setError(apiErrorMessage(json));
          setData(null);
        } else {
          setError("");
          setData(json as DayBook);
        }
      });
  }, [from, to, type, router]);

  const range = from && to ? `${formatDateUae(from)} – ${formatDateUae(to)}` : "";
  const here = `/books/reports/day-book?${new URLSearchParams({ from, to, ...(type ? { type } : {}) })}`;

  return (
    <div className="space-y-4 pb-10">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Day book</h1>
          <p className="text-sm text-muted-foreground">
            Every posted voucher in the range, in date order, with its debit and credit totals. Expand a voucher for its lines.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="text-xs text-muted-foreground">
            From
            <input type="date" className="ms-2 rounded-md border border-border bg-card px-2 py-1 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="daybook-from" />
          </label>
          <label className="text-xs text-muted-foreground">
            To
            <input type="date" className="ms-2 rounded-md border border-border bg-card px-2 py-1 text-sm" value={to} onChange={(e) => setTo(e.target.value)} data-testid="daybook-to" />
          </label>
          <label className="text-xs text-muted-foreground">
            Type
            <select className="ms-2 rounded-md border border-border bg-card px-2 py-1 text-sm" value={type} onChange={(e) => setType(e.target.value)} data-testid="daybook-type">
              <option value="">All</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <ReportsNav active="daybook" />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <ReportTable
        testId="daybook-report"
        stateKey={`daybook:${from}:${to}:${type}`}
        title={`Day book${type ? ` — ${type}` : ""}`}
        company={meta.company}
        preparedBy={meta.preparedBy}
        periodLabel={range}
        columns={COLUMNS}
        rows={(data?.rows || []).map((r) => ({
          id: r.entryId,
          label: r.particulars,
          values: { debit: r.debitMinor, credit: r.creditMinor },
          text: { date: formatDateUae(r.date), type: r.type, number: r.number || "", party: partyText(r) },
          drill: { entryId: r.entryId },
          // Expand a voucher to see which accounts were debited and credited.
          children: (r.lines || []).map((l, i) => ({
            id: `${r.entryId}:${i}`,
            label: l.accountName,
            code: l.accountCode,
            values: { debit: l.debitMinor, credit: l.creditMinor },
            drill: { entryId: r.entryId },
          })),
        }))}
        footer={
          data
            ? [{ id: "total", label: `Total · ${data.rows.length} vouchers`, values: { debit: data.totalDebitMinor, credit: data.totalCreditMinor }, testId: "daybook-total" }]
            : []
        }
        emptyText="No posted vouchers in this range."
        exportName={`day-book-${from}-${to}`}
        onDrill={(r) => {
          const entryId = (r.drill as { entryId: string }).entryId;
          router.push(`/books/reports/entry?id=${entryId}&trail=${trailParam([{ label: "Day book", href: here }])}`);
        }}
      />
    </div>
  );
}

export default function DayBookPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading day book…</p>}>
      <DayBookInner />
    </Suspense>
  );
}
