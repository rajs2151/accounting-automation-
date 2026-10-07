"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiErrorMessage } from "@/lib/api-error";
import { formatMinor } from "@/lib/money";

type FirmRow = {
  clientId: string;
  clientName: string;
  periodId: string | null;
  periodLabel: string | null;
  periodStatus: string | null;
  closeReady: boolean | null;
  tbBalanced: boolean | null;
  unmatchedBankLines: number;
  pendingExpenses: number;
  suspenseMinor: number;
  vatDueDate: string | null;
  vatDaysUntilDue: number | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
};

export default function FirmHealthBoardPage() {
  const [rows, setRows] = useState<FirmRow[]>([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "not_ready" | "tb_off">("all");

  function load() {
    setError("");
    void fetch("/api/books/health/firm")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(apiErrorMessage(j) || "firm_board_failed");
        return j as { rows: FirmRow[] };
      })
      .then((j) => setRows(j.rows || []))
      .catch((e: Error) => setError(e.message));
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    if (filter === "not_ready") return rows.filter((r) => r.closeReady === false);
    if (filter === "tb_off") return rows.filter((r) => r.tbBalanced === false);
    return rows;
  }, [rows, filter]);

  async function openCompany(clientId: string) {
    const dir = await fetch("/api/session").then((r) => r.json()).catch(() => null);
    const userId = dir?.me?.id as string | undefined;
    if (!userId) {
      window.location.href = "/books/health";
      return;
    }
    await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, clientId }),
    }).catch(() => undefined);
    window.location.href = "/books/health";
  }

  return (
    <div className="space-y-4 pb-10" data-testid="firm-health-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Firm health board</h1>
          <p className="text-sm text-muted-foreground">
            All synthetic companies you can see · close, TB, bank, expenses, suspense, VAT
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            data-testid="firm-filter"
          >
            <option value="all">All companies</option>
            <option value="not_ready">Close not ready</option>
            <option value="tb_off">TB unbalanced</option>
          </select>
          <button
            type="button"
            className="rounded-md bg-muted px-2 py-1 text-sm"
            onClick={load}
            data-testid="firm-refresh"
          >
            Refresh
          </button>
          <Link href="/books/health" className="text-sm underline-offset-2 hover:underline">
            Back to Company Health
          </Link>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive" data-testid="firm-error">
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Company</th>
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2">Close</th>
              <th className="px-3 py-2">TB</th>
              <th className="px-3 py-2 text-right">Unmatched bank</th>
              <th className="px-3 py-2 text-right">Pending exp.</th>
              <th className="px-3 py-2 text-right">Suspense</th>
              <th className="px-3 py-2">VAT due</th>
              <th className="px-3 py-2">Assignee</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-4 text-muted-foreground">
                  No companies match this filter.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.clientId} className="border-t border-border" data-testid={`firm-row-${r.clientId}`}>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="font-medium underline-offset-2 hover:underline"
                      onClick={() => void openCompany(r.clientId)}
                    >
                      {r.clientName}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    {r.periodLabel || "—"}
                    {r.periodStatus ? (
                      <span className="ml-1 text-xs text-muted-foreground">({r.periodStatus})</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {r.closeReady == null ? "—" : r.closeReady ? "Ready" : "Blocked"}
                  </td>
                  <td className="px-3 py-2">
                    {r.tbBalanced == null ? "—" : r.tbBalanced ? "OK" : "Out"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.unmatchedBankLines}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.pendingExpenses}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMinor(r.suspenseMinor)}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {r.vatDueDate
                      ? `${r.vatDueDate}${r.vatDaysUntilDue != null ? ` (${r.vatDaysUntilDue}d)` : ""}`
                      : "—"}
                  </td>
                  <td className="px-3 py-2">{r.assigneeName || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
