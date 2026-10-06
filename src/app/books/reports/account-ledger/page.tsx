"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import {
  ReportBreadcrumbs,
  ReportTable,
  readTrail,
  trailParam,
  useReportMeta,
  type ReportColumn,
} from "@/components/books/report-table";
import { formatDateUae } from "@/lib/date";
import type { ReportRow } from "@/lib/report-table";

type Ledger = {
  account: { id: string; code: string; name: string; normalBalance: "debit" | "credit" };
  period: { id: string; label: string; start: string; end: string };
  opening: { debitMinor: number; creditMinor: number; balanceMinor: number };
  lines: Array<{
    entryId: string;
    entryNo: string | null;
    date: string;
    memo: string;
    debitMinor: number;
    creditMinor: number;
    balanceMinor: number;
  }>;
  currentTotal: { debitMinor: number; creditMinor: number };
  closing: { debitMinor: number; creditMinor: number; balanceMinor: number };
};

const COLUMNS: ReportColumn[] = [
  { key: "date", label: "Date", kind: "text" },
  { key: "entry", label: "Entry", kind: "text" },
  { key: "debit", label: "Debit" },
  { key: "credit", label: "Credit" },
  { key: "balance", label: "Balance" },
];

function AccountLedgerInner() {
  const params = useSearchParams();
  const router = useRouter();
  const meta = useReportMeta();
  const periodId = params.get("periodId") || "";
  const accountId = params.get("accountId") || "";
  const trail = useMemo(() => readTrail(params.get("trail")), [params]);
  const [data, setData] = useState<Ledger | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!periodId || !accountId) return;
    fetch(`/api/books/reports/ledger?periodId=${periodId}&accountId=${accountId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setError(String(json.error));
        else setData(json as Ledger);
      })
      .catch(() => setError("load_failed"));
  }, [periodId, accountId]);

  const rows: Array<ReportRow & { text: Record<string, string> }> = (data?.lines || []).map((l, i) => ({
    id: `${l.entryId}:${i}`,
    label: l.memo || "—",
    values: { debit: l.debitMinor, credit: l.creditMinor, balance: l.balanceMinor },
    text: { date: formatDateUae(l.date), entry: l.entryNo || l.entryId.slice(0, 8) },
    drill: { entryId: l.entryId },
  }));
  const title = data ? `${data.account.code} · ${data.account.name}` : "Account ledger";
  const here = `/books/reports/account-ledger?periodId=${periodId}&accountId=${accountId}&trail=${trailParam(trail)}`;

  return (
    <div className="space-y-4 pb-10">
      <div className="print:hidden">
        <ReportBreadcrumbs trail={trail} current={data ? `${data.account.code} ${data.account.name}` : "Account ledger"} />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Account ledger</h1>
        {data ? (
          <p className="text-sm text-muted-foreground">
            {title} · {data.period.label} ({formatDateUae(data.period.start)} – {formatDateUae(data.period.end)})
          </p>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {data ? (
        <ReportTable
          testId="ledger-report"
          stateKey={`ledger:${periodId}:${accountId}`}
          title={`Account ledger — ${title}`}
          company={meta.company}
          preparedBy={meta.preparedBy}
          periodLabel={data.period.label}
          labelHeader="Particulars"
          columns={COLUMNS}
          rows={rows}
          emptyText="No postings in this period."
          exportName={`ledger-${data.account.code}-${data.period.label}`.replace(/\s+/g, "-")}
          footer={[
            {
              id: "opening",
              label: "Opening balance",
              values: { debit: data.opening.debitMinor, credit: data.opening.creditMinor, balance: data.opening.balanceMinor },
              testId: "ledger-opening",
            },
            {
              id: "current",
              label: "Current total",
              values: { debit: data.currentTotal.debitMinor, credit: data.currentTotal.creditMinor },
              testId: "ledger-current",
            },
            {
              id: "closing",
              label: "Closing balance",
              values: { debit: data.closing.debitMinor, credit: data.closing.creditMinor, balance: data.closing.balanceMinor },
              testId: "ledger-closing",
            },
          ]}
          onUp={() => {
            const back = trail.at(-1);
            if (back) router.push(back.href);
          }}
          onDrill={(r) => {
            const entryId = (r.drill as { entryId: string }).entryId;
            const next = [...trail, { label: `${data.account.code} ledger`, href: here }];
            router.push(`/books/reports/entry?id=${entryId}&trail=${trailParam(next)}`);
          }}
        />
      ) : null}
    </div>
  );
}

export default function AccountLedgerPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading account ledger…</p>}>
      <AccountLedgerInner />
    </Suspense>
  );
}
