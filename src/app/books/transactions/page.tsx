"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { CellAmount } from "@/components/books/cells";
import { StatusBadge } from "@/components/books/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiErrorMessage } from "@/lib/api-error";
import { BANK_TXN_TYPE_LABEL, BANK_TXN_TYPES } from "@/lib/bank-txn-types";
import { formatDateUae } from "@/lib/date";
import { bankTxnReviewStatusLabel } from "@/lib/status-labels";

type BankAccountOpt = { id: string; code: string; name: string };
type CoaOpt = { id: string; code: string; name: string };

type TxnRow = {
  id: string;
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  txnDate: string | null;
  description: string;
  currency: string;
  debitMinor: number;
  creditMinor: number;
  amountSignedMinor: number;
  reviewStatus: string;
  txnType: string | null;
  categoryAccountId: string | null;
  note: string;
  excludeReason: string | null;
  monthKey: string | null;
  openItemId: string | null;
  openItemLabel: string | null;
  journalEntryId: string | null;
  entryNo: string | null;
};

type MatchCand = {
  openItemId: string;
  partyName: string;
  documentNumber: string | null;
  openOriginalMinor: number;
  score: number;
};

type Tab = "needs_review" | "ready" | "excluded" | "posted";

function TransactionsInner() {
  const search = useSearchParams();
  const initialAccount = search.get("accountId") || "all";
  const [accountId, setAccountId] = useState(initialAccount);
  const [tab, setTab] = useState<Tab>("needs_review");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<TxnRow[]>([]);
  const [banks, setBanks] = useState<BankAccountOpt[]>([]);
  const [coa, setCoa] = useState<CoaOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [excludeFor, setExcludeFor] = useState<string | null>(null);
  const [excludeReason, setExcludeReason] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (accountId && accountId !== "all") params.set("accountId", accountId);
    if (tab) params.set("status", tab);
    if (q.trim()) params.set("q", q.trim());
    const [txnRes, bankRes, coaRes] = await Promise.all([
      fetch(`/api/books/bank-transactions?${params}`),
      fetch("/api/books/bank-accounts"),
      fetch("/api/books/accounts?postableOnly=1"),
    ]);
    const txnData = await txnRes.json().catch(() => ({}));
    const bankData = await bankRes.json().catch(() => ([]));
    const coaData = await coaRes.json().catch(() => ([]));
    if (!txnRes.ok) {
      toast.error(apiErrorMessage(txnData));
      setLoading(false);
      return;
    }
    if (Array.isArray(txnData)) setRows(txnData);
    if (Array.isArray(bankData)) {
      setBanks(
        bankData.map((b: { id: string; code: string; name: string }) => ({
          id: String(b.id),
          code: String(b.code),
          name: String(b.name),
        })),
      );
    }
    if (Array.isArray(coaData)) {
      setCoa(
        coaData.map((a: { id: string; code: string; name: string }) => ({
          id: String(a.id),
          code: String(a.code),
          name: String(a.name),
        })),
      );
    }
    setLoading(false);
  }, [accountId, tab, q]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const counts = useMemo(() => {
    // Counts for tabs need all statuses — fetch lightly via three parallel filters would be heavy;
    // show current-tab length plus reload when switching. For badges, query without status once.
    return { current: rows.length };
  }, [rows.length]);

  const [tabCounts, setTabCounts] = useState({
    needs_review: 0,
    ready: 0,
    excluded: 0,
    posted: 0,
  });
  const [matchCands, setMatchCands] = useState<Record<string, MatchCand[]>>({});

  useEffect(() => {
    async function loadCounts() {
      const base = new URLSearchParams();
      if (accountId && accountId !== "all") base.set("accountId", accountId);
      const statuses: Tab[] = ["needs_review", "ready", "excluded", "posted"];
      const results = await Promise.all(
        statuses.map(async (s) => {
          const p = new URLSearchParams(base);
          p.set("status", s);
          const res = await fetch(`/api/books/bank-transactions?${p}`);
          const data = await res.json().catch(() => []);
          return [s, Array.isArray(data) ? data.length : 0] as const;
        }),
      );
      const next = { needs_review: 0, ready: 0, excluded: 0, posted: 0 };
      for (const [s, n] of results) next[s] = n;
      setTabCounts(next);
    }
    void loadCounts();
  }, [accountId, rows]);

  async function patchRow(
    id: string,
    body: { txnType?: string | null; categoryAccountId?: string | null },
  ) {
    const res = await fetch(`/api/books/bank-transactions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    void reload();
  }

  async function markReviewed(id: string) {
    const res = await fetch(`/api/books/bank-transactions/${id}/mark-reviewed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Marked ready");
    void reload();
  }

  async function confirmExclude() {
    if (!excludeFor) return;
    const res = await fetch(`/api/books/bank-transactions/${excludeFor}/exclude`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: excludeReason }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Excluded");
    setExcludeFor(null);
    setExcludeReason("");
    void reload();
  }

  async function loadMatchCandidates(id: string) {
    if (matchCands[id]) return;
    const res = await fetch(`/api/books/bank-transactions/${id}/match-candidates`);
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    if (Array.isArray(data)) setMatchCands((prev) => ({ ...prev, [id]: data }));
  }

  async function setMatch(id: string, openItemId: string | null) {
    const res = await fetch(`/api/books/bank-transactions/${id}/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openItemId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success(openItemId ? "Matched" : "Match cleared");
    void reload();
  }

  async function postTxn(id: string) {
    const res = await fetch(`/api/books/bank-transactions/${id}/post`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success(`Posted ${data.entryNo || ""}`.trim());
    void reload();
  }

  const grouped = useMemo(() => {
    const map = new Map<string, TxnRow[]>();
    for (const r of rows) {
      const key = r.monthKey || "unknown";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows]);

  return (
    <div className="space-y-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Transactions</h1>
          <p className="text-sm text-muted-foreground">
            Categorize, match open invoices/bills, then an approver posts
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            data-testid="txn-materialize"
            onClick={async () => {
              const res = await fetch("/api/books/bank-transactions/materialize", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  accountId: accountId !== "all" ? accountId : undefined,
                }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) {
                toast.error(apiErrorMessage(data));
                return;
              }
              toast.success(`Refreshed · ${data.inserted ?? 0} new`);
              void reload();
            }}
          >
            Refresh from statements
          </Button>
          <Link
            href="/books/banking"
            className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted"
          >
            Banking
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px]">
          <Label>Account</Label>
          <Select value={accountId} onValueChange={(v) => v && setAccountId(v)}>
            <SelectTrigger className="mt-1" data-testid="txn-account-filter">
              <SelectValue placeholder="All accounts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              {banks.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.code} · {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[200px] flex-1">
          <Label>Search</Label>
          <Input
            className="mt-1"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Description or reference"
            data-testid="txn-search"
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} data-testid="txn-tabs">
        <TabsList>
          <TabsTrigger value="needs_review" data-testid="txn-tab-needs-review">
            Needs Review ({tabCounts.needs_review})
          </TabsTrigger>
          <TabsTrigger value="ready" data-testid="txn-tab-ready">
            Ready ({tabCounts.ready})
          </TabsTrigger>
          <TabsTrigger value="excluded" data-testid="txn-tab-excluded">
            Excluded ({tabCounts.excluded})
          </TabsTrigger>
          <TabsTrigger value="posted" data-testid="txn-tab-posted">
            Posted ({tabCounts.posted})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {excludeFor ? (
        <div className="max-w-lg space-y-2 rounded-lg border border-border p-3" data-testid="txn-exclude-form">
          <p className="text-sm">Exclude reason (required)</p>
          <Input
            value={excludeReason}
            onChange={(e) => setExcludeReason(e.target.value)}
            data-testid="txn-exclude-reason"
          />
          <div className="flex gap-2">
            <Button data-testid="txn-exclude-confirm" onClick={() => void confirmExclude()}>
              Exclude
            </Button>
            <Button variant="outline" onClick={() => setExcludeFor(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm" data-testid="txn-table">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Account</th>
              <th className="px-3 py-2">Match</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  No transactions in this tab
                  {counts.current === 0 ? " — upload a balanced statement from Banking" : ""}.
                </td>
              </tr>
            ) : (
              grouped.map(([month, items]) => (
                <Fragment key={`m-${month}`}>
                  <tr className="border-t border-border bg-muted/20">
                    <td colSpan={8} className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                      {month}
                    </td>
                  </tr>
                  {items.map((r) => (
                    <tr key={r.id} className="border-t border-border" data-testid={`txn-row-${r.id}`}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.txnDate ? formatDateUae(r.txnDate) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <div>{r.description || "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.accountCode} · {r.accountName}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Select
                          value={r.txnType || undefined}
                          onValueChange={(v) => void patchRow(r.id, { txnType: v || null })}
                          disabled={r.reviewStatus === "excluded" || r.reviewStatus === "posted"}
                        >
                          <SelectTrigger className="h-8 w-[160px]" data-testid={`txn-type-${r.id}`}>
                            <SelectValue placeholder="Type" />
                          </SelectTrigger>
                          <SelectContent>
                            {BANK_TXN_TYPES.map((t) => (
                              <SelectItem key={t} value={t}>
                                {BANK_TXN_TYPE_LABEL[t]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-3 py-2">
                        <Select
                          value={r.categoryAccountId || undefined}
                          onValueChange={(v) =>
                            void patchRow(r.id, { categoryAccountId: v || null })
                          }
                          disabled={r.reviewStatus === "excluded" || r.reviewStatus === "posted"}
                        >
                          <SelectTrigger
                            className="h-8 w-[180px]"
                            data-testid={`txn-category-${r.id}`}
                          >
                            <SelectValue placeholder="COA account" />
                          </SelectTrigger>
                          <SelectContent>
                            {coa.map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.code} · {a.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-3 py-2">
                        {r.txnType === "customer_receipt" || r.txnType === "supplier_payment" ? (
                          r.reviewStatus === "posted" ? (
                            <span className="text-xs text-muted-foreground">
                              {r.openItemLabel || "—"}
                            </span>
                          ) : (
                            <Select
                              value={r.openItemId || "__none__"}
                              onValueChange={(v) =>
                                void setMatch(r.id, !v || v === "__none__" ? null : v)
                              }
                              onOpenChange={(open) => {
                                if (open) void loadMatchCandidates(r.id);
                              }}
                            >
                              <SelectTrigger
                                className="h-8 w-[200px]"
                                data-testid={`txn-match-${r.id}`}
                              >
                                <SelectValue placeholder="Match invoice/bill" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">No match</SelectItem>
                                {(matchCands[r.id] || []).map((c) => (
                                  <SelectItem key={c.openItemId} value={c.openItemId}>
                                    {(c.documentNumber || "Doc") +
                                      ` · ${c.partyName} · ${c.openOriginalMinor}`}
                                  </SelectItem>
                                ))}
                                {r.openItemId &&
                                !(matchCands[r.id] || []).some((c) => c.openItemId === r.openItemId) ? (
                                  <SelectItem value={r.openItemId}>
                                    {r.openItemLabel || r.openItemId.slice(0, 8)}
                                  </SelectItem>
                                ) : null}
                              </SelectContent>
                            </Select>
                          )
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className={r.amountSignedMinor >= 0 ? "text-emerald-700" : "text-red-700"}>
                          {r.amountSignedMinor >= 0 ? "+" : "−"}
                          <CellAmount minor={Math.abs(r.amountSignedMinor)} />
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge meta={bankTxnReviewStatusLabel(r.reviewStatus)} />
                        {r.entryNo ? (
                          <div className="text-xs text-muted-foreground">{r.entryNo}</div>
                        ) : null}
                        {r.excludeReason ? (
                          <div className="text-xs text-muted-foreground">{r.excludeReason}</div>
                        ) : null}
                      </td>
                      <td className="space-x-1 px-3 py-2 text-right whitespace-nowrap">
                        {r.reviewStatus === "needs_review" || r.reviewStatus === "ready" ? (
                          <>
                            {r.reviewStatus === "needs_review" ? (
                              <Button
                                size="sm"
                                data-testid={`txn-mark-${r.id}`}
                                onClick={() => void markReviewed(r.id)}
                              >
                                Mark reviewed
                              </Button>
                            ) : null}
                            {r.reviewStatus === "ready" ? (
                              <Button
                                size="sm"
                                data-testid={`txn-post-${r.id}`}
                                onClick={() => void postTxn(r.id)}
                              >
                                Post
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              data-testid={`txn-exclude-${r.id}`}
                              onClick={() => {
                                setExcludeFor(r.id);
                                setExcludeReason("");
                              }}
                            >
                              Exclude
                            </Button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function BooksTransactionsPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading…</p>}>
      <TransactionsInner />
    </Suspense>
  );
}
