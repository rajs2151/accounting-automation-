"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/books/status-badge";
import { rowOpenProps } from "@/components/books/table-peek";
import { showUploadFeedback } from "@/components/books/upload-feedback";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
import { formatMinor } from "@/lib/money";
import { balanceCheckLabel, statementStatusLabel } from "@/lib/status-labels";

type Row = {
  id: string;
  filename?: string | null;
  bankName: string | null;
  iban: string | null;
  accountLabel?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  status: string;
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
  lineCount?: number;
  balanceCheck?: "ok" | "failed" | null;
  inboxItemId?: string | null;
  error?: string | null;
  rowKind?: "statement" | "pending";
  validationFlags?: unknown;
};

function periodLabel(from: string | null | undefined, to: string | null | undefined): string {
  if (!from && !to) return "—";
  const a = from ? formatDateUae(String(from).slice(0, 10)) : "—";
  const b = to ? formatDateUae(String(to).slice(0, 10)) : "—";
  return `${a} – ${b}`;
}

function bankLabel(r: Row): string {
  const bank = r.bankName || r.accountLabel;
  if (bank && r.iban) return `${bank} · ${r.iban}`;
  if (bank) return bank;
  if (r.iban) return r.iban;
  return "—";
}

export default function StatementsListPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [csvText, setCsvText] = useState(
    "id,Type,Amount,Fee,Net,Currency,Created (UTC),Description\ntxn_1,charge,100.00,3.20,96.80,aed,2026-05-05 10:00:00,Payment\n",
  );
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const data = await fetch("/api/books/statements").then((r) => r.json());
    if (Array.isArray(data)) setRows(data);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Poll while any upload is still Queued / Extracting.
  useEffect(() => {
    const pending = rows.some((r) => r.status === "queued" || r.status === "extracting");
    if (!pending) return;
    const t = setInterval(() => void reload(), 2500);
    return () => clearInterval(t);
  }, [rows, reload]);

  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    const body = new FormData();
    for (const f of Array.from(files)) body.append("files", f);
    body.append("userDocType", "bank_statement");
    const res = await fetch("/api/books/inbox/upload", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    showUploadFeedback(res.ok, data);
    if (fileRef.current) fileRef.current.value = "";
    if (!res.ok) return;
    void reload();
  }

  async function ingestStripe() {
    await fetch("/api/books/statements/csv", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csvText, issuerKey: "stripe", openingBalanceMinor: 0 }),
    });
    void reload();
  }

  async function retry(inboxItemId: string) {
    const res = await fetch(`/api/books/inbox/${inboxItemId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      toast.error(apiErrorMessage(await res.json().catch(() => ({}))));
      return;
    }
    toast.success("Retry queued");
    void reload();
  }

  return (
    <div className="space-y-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bank statements</h1>
          <p className="text-sm text-muted-foreground">
            Check each upload balances (opening + lines = closing). Its lines then appear in Bank transactions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href="/samples/bank-statement-sample.csv"
            download="bank-statement-sample.csv"
            className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted"
            data-testid="statement-sample-csv"
          >
            Download sample sheet
          </a>
          <label
            className="inline-flex cursor-pointer items-center rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
            data-testid="statement-upload"
          >
            Upload statement
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,.heic,.csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => void onUpload(e.target.files)}
            />
          </label>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm" data-testid="statements-table">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">File</th>
              <th className="px-3 py-2">Bank / IBAN</th>
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2">Rows</th>
              <th className="px-3 py-2">Opening</th>
              <th className="px-3 py-2">Closing</th>
              <th className="px-3 py-2">Balance check</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                  No statements yet — upload a PDF or CSV, or ingest the Stripe preset below.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isPending = r.rowKind === "pending" || r.status === "queued" || r.status === "extracting";
                const href =
                  !isPending && r.rowKind !== "pending" ? `/books/statements/${r.id}` : null;
                const fileLabel = r.filename || r.bankName || "Statement";
                return (
                  <tr
                    key={r.id}
                    className="border-t border-border"
                    data-testid={`statement-row-${r.id}`}
                    {...(href ? rowOpenProps(() => router.push(href)) : {})}
                  >
                    <td className="px-3 py-2">
                      {href ? (
                        <Link className="text-primary underline" href={href}>
                          {fileLabel}
                        </Link>
                      ) : (
                        <span>{fileLabel}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{bankLabel(r)}</td>
                    <td className="px-3 py-2">{periodLabel(r.periodFrom, r.periodTo)}</td>
                    <td className="px-3 py-2 tabular-nums">{r.lineCount ?? 0}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {r.openingBalanceMinor == null ? "—" : formatMinor(r.openingBalanceMinor)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {r.closingBalanceMinor == null ? "—" : formatMinor(r.closingBalanceMinor)}
                    </td>
                    <td className="px-3 py-2" data-testid={`balance-check-${r.id}`}>
                      {r.balanceCheck ? (
                        <StatusBadge meta={balanceCheckLabel(r.balanceCheck)} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2" data-testid={`statement-status-${r.id}`}>
                      <StatusBadge meta={statementStatusLabel(r.status)} />
                      {r.status === "failed" && r.error ? (
                        <div className="text-xs text-red-600">{r.error}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {r.status === "failed" && r.inboxItemId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void retry(String(r.inboxItemId))}
                        >
                          Retry
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-sm font-medium">Stripe CSV preset</p>
        <textarea
          className="min-h-24 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          data-testid="stripe-csv-textarea"
        />
        <Button onClick={() => void ingestStripe()}>Ingest Stripe CSV preset</Button>
      </div>
    </div>
  );
}
