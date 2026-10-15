"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import {
  ReportBreadcrumbs,
  ReportTable,
  readTrail,
  useReportMeta,
  type ReportColumn,
} from "@/components/books/report-table";
import { formatDateUae } from "@/lib/date";
import { formatMinor } from "@/lib/money";

type Entry = {
  id: string;
  entryNo: string | null;
  entryDate: string;
  memo: string;
  status: string;
  voucherType?: string | null;
  lines: Array<{ id: string; accountCode: string; accountName: string; lineMemo: string | null; debitMinor: number; creditMinor: number }>;
};

type Source = {
  documentId: string;
  docType: string;
  documentNumber: string | null;
  partyName: string | null;
  issueDate: string | null;
  grossMinor: number;
  status: string;
  inboxItemId: string | null;
};

const DOC_LABEL: Record<string, string> = {
  sales_invoice: "Sales invoice",
  purchase_bill: "Purchase bill",
  credit_note: "Credit note",
  debit_note: "Debit note",
  receipt: "Receipt",
  payment: "Payment",
  contra: "Contra",
};

const COLUMNS: ReportColumn[] = [
  { key: "debit", label: "Debit" },
  { key: "credit", label: "Credit" },
];

/** Read-only journal entry view inside Reports (drill-down step before the source document). */
function EntryInner() {
  const params = useSearchParams();
  const router = useRouter();
  const meta = useReportMeta();
  const id = params.get("id") || params.get("entryId") || "";
  const trail = useMemo(() => readTrail(params.get("trail")), [params]);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [source, setSource] = useState<Source | null | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    void Promise.all([
      fetch(`/api/books/journals/${id}`).then((r) => r.json()),
      fetch(`/api/books/reports/entry-source/${id}`).then((r) => r.json()),
    ])
      .then(([e, s]) => {
        if (e?.error) setError(String(e.error));
        else setEntry(e as Entry);
        setSource(s?.error ? null : ((s?.source as Source | null) ?? null));
      })
      .catch(() => setError("load_failed"));
  }, [id]);

  const debit = entry?.lines.reduce((s, l) => s + Number(l.debitMinor), 0) ?? 0;
  const credit = entry?.lines.reduce((s, l) => s + Number(l.creditMinor), 0) ?? 0;
  const name = entry ? entry.entryNo || entry.id.slice(0, 8) : "Entry";

  return (
    <div className="space-y-4 pb-10">
      <div className="print:hidden">
        <ReportBreadcrumbs trail={trail} current={name} />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Journal entry {entry?.entryNo || ""}</h1>
        {entry ? (
          <p className="text-sm text-muted-foreground">
            {formatDateUae(entry.entryDate)} · {entry.voucherType || "Journal"} · {entry.status} · {entry.memo}
          </p>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {source !== undefined ? (
        <div className="rounded-lg border border-border bg-card p-4 text-sm" data-testid="entry-source">
          {source ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium">
                  {DOC_LABEL[source.docType] || source.docType} {source.documentNumber || ""}
                </div>
                <div className="text-muted-foreground">
                  {source.partyName || "—"} · {formatDateUae(source.issueDate)} · AED {formatMinor(source.grossMinor)} ·{" "}
                  {source.status}
                </div>
              </div>
              {source.inboxItemId ? (
                <Link
                  href={`/books/inbox/${source.inboxItemId}`}
                  className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 hover:bg-muted"
                  data-testid="entry-source-link"
                >
                  Open source document
                </Link>
              ) : (
                <span className="text-xs text-muted-foreground" data-testid="entry-source-manual">
                  Entered by hand — no uploaded file.
                </span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground" data-testid="entry-source-none">
              Manual journal — no source document.
            </span>
          )}
        </div>
      ) : null}

      {entry ? (
        <ReportTable
          testId="entry-report"
          stateKey={`entry:${id}`}
          title={`Journal entry ${name}`}
          company={meta.company}
          preparedBy={meta.preparedBy}
          periodLabel={formatDateUae(entry.entryDate)}
          labelHeader="Account"
          columns={COLUMNS}
          rows={entry.lines.map((l) => ({
            id: l.id,
            code: l.accountCode,
            label: l.lineMemo ? `${l.accountName} — ${l.lineMemo}` : l.accountName,
            values: { debit: Number(l.debitMinor), credit: Number(l.creditMinor) },
          }))}
          footer={[{ id: "total", label: "Total", values: { debit, credit }, testId: "entry-total" }]}
          difference={{ debitKey: "debit", creditKey: "credit", totals: { debit, credit } }}
          exportName={`entry-${name}`}
          onUp={() => {
            const back = trail.at(-1);
            if (back) router.push(back.href);
          }}
        />
      ) : null}
    </div>
  );
}

export default function ReportEntryPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading entry…</p>}>
      <EntryInner />
    </Suspense>
  );
}
