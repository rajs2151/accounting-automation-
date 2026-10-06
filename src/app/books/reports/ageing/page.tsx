"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import {
  ReportsNav,
  ReportTable,
  trailParam,
  useReportMeta,
  type ReportColumn,
} from "@/components/books/report-table";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
import type { ReportRow } from "@/lib/report-table";

const BUCKETS = ["not_due", "0-30", "31-60", "61-90", "90+"] as const;
const BUCKET_LABEL: Record<(typeof BUCKETS)[number], string> = {
  not_due: "Not due",
  "0-30": "0-30",
  "31-60": "31-60",
  "61-90": "61-90",
  "90+": "90+",
};
const KIND_LABEL = { item: "", on_account: "On account", advance: "Advance" } as const;

type Totals = Record<(typeof BUCKETS)[number], number> & { total: number };
type Ageing = {
  side: "AR" | "AP";
  asOf: string;
  rows: Array<{
    kind: "item" | "on_account" | "advance";
    date: string;
    ref: string;
    partyId: string;
    partyName: string;
    pendingMinor: number;
    dueDate: string | null;
    overdueDays: number;
    bucket: (typeof BUCKETS)[number];
    journalEntryId: string | null;
  }>;
  parties: Array<{ partyId: string; partyName: string; totals: Totals }>;
  totals: Totals;
};

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function bucketValues(t: Partial<Totals>) {
  const v: Record<string, number> = { pending: t.total ?? 0 };
  for (const b of BUCKETS) v[b] = t[b] ?? 0;
  return v;
}

function AgeingInner() {
  const router = useRouter();
  const params = useSearchParams();
  const meta = useReportMeta();
  const side = (params.get("side") || "ar").toLowerCase() === "ap" ? "ap" : "ar";
  const [asOf, setAsOf] = useState(params.get("asOf") || todayIso());
  const [byParty, setByParty] = useState(params.get("byParty") !== "0");
  const [data, setData] = useState<Ageing | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return;
    router.replace(`/books/reports/ageing?side=${side}&asOf=${asOf}&byParty=${byParty ? 1 : 0}`, { scroll: false });
    void fetch(`/api/books/reports/ageing?side=${side}&asOf=${asOf}`)
      .then(async (r) => [r.ok, await r.json()] as const)
      .then(([ok, json]) => {
        if (!ok) {
          setError(apiErrorMessage(json));
          setData(null);
        } else {
          setError("");
          setData(json as Ageing);
        }
      });
  }, [side, asOf, byParty, router]);

  const columns: ReportColumn[] = [
    { key: "date", label: "Date", kind: "text" },
    ...(byParty ? [] : [{ key: "party", label: "Party", kind: "text" as const }]),
    { key: "due", label: "Due date", kind: "text" },
    { key: "days", label: "Overdue days", kind: "text" },
    ...BUCKETS.map((b) => ({ key: b, label: BUCKET_LABEL[b] })),
    { key: "pending", label: "Pending" },
  ];

  const rows = useMemo(() => {
    if (!data) return [] as Array<ReportRow & { text?: Record<string, string> }>;
    const leaf = (r: Ageing["rows"][number], i: number) => ({
      id: `${r.partyId}:${r.ref}:${i}`,
      label: `${r.ref}${KIND_LABEL[r.kind] ? ` · ${KIND_LABEL[r.kind]}` : ""}`,
      values: { [r.bucket]: r.pendingMinor, pending: r.pendingMinor },
      text: {
        date: formatDateUae(r.date),
        party: r.partyName,
        due: r.dueDate ? formatDateUae(r.dueDate) : "",
        days: r.kind === "item" ? String(Math.max(0, r.overdueDays)) : "",
      },
      drill: r.journalEntryId ? { entryId: r.journalEntryId } : undefined,
    });
    if (!byParty) return data.rows.map(leaf);
    return data.parties.map((p) => ({
      id: `party:${p.partyId}`,
      label: p.partyName,
      values: bucketValues(p.totals),
      children: data.rows.map((r, i) => [r, i] as const).filter(([r]) => r.partyId === p.partyId).map(([r, i]) => leaf(r, i)),
    }));
  }, [data, byParty]);

  const title = side === "ap" ? "Payables ageing" : "Receivables ageing";
  const here = `/books/reports/ageing?side=${side}&asOf=${asOf}&byParty=${byParty ? 1 : 0}`;

  return (
    <div className="space-y-4 pb-10">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">
            Open {side === "ap" ? "bills" : "invoices"} as of the date, by days past due. On-account and advance amounts
            are shown as their own negative rows.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <div className="flex rounded-lg border border-border">
            {(["ar", "ap"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={`px-3 py-1 ${s === side ? "bg-primary text-primary-foreground" : ""}`}
                onClick={() => router.push(`/books/reports/ageing?side=${s}&asOf=${asOf}&byParty=${byParty ? 1 : 0}`)}
                data-testid={`ageing-side-${s}`}
              >
                {s === "ar" ? "Receivables" : "Payables"}
              </button>
            ))}
          </div>
          <label className="text-xs text-muted-foreground">
            As of
            <input type="date" className="ms-2 rounded-md border border-border bg-card px-2 py-1 text-sm" value={asOf} onChange={(e) => setAsOf(e.target.value)} data-testid="ageing-asof" />
          </label>
          <label className="flex items-center gap-2" data-testid="ageing-by-party">
            <input type="checkbox" checked={byParty} onChange={(e) => setByParty(e.target.checked)} />
            By party
          </label>
        </div>
      </div>
      <ReportsNav active={side} />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <ReportTable
        testId="ageing-report"
        stateKey={`ageing:${side}:${asOf}:${byParty}`}
        title={title}
        company={meta.company}
        preparedBy={meta.preparedBy}
        periodLabel={`As of ${formatDateUae(asOf)}`}
        labelHeader={byParty ? "Party / Ref" : "Ref"}
        columns={columns}
        rows={rows}
        brackets
        footer={data ? [{ id: "total", label: "Grand total", values: bucketValues(data.totals), testId: "ageing-total" }] : []}
        emptyText="Nothing outstanding."
        exportName={`${side}-ageing-${asOf}`}
        onDrill={(r) => {
          const d = r.drill as { entryId: string } | undefined;
          if (!d) return;
          router.push(`/books/reports/entry?id=${d.entryId}&trail=${trailParam([{ label: title, href: here }])}`);
        }}
      />
    </div>
  );
}

export default function AgeingPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading ageing…</p>}>
      <AgeingInner />
    </Suspense>
  );
}
