"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { CellAmount } from "@/components/books/cells";
import { BooksSideDrawer } from "@/components/books/side-drawer";
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
import { bankTxnUnallocatedMinor } from "@/lib/bank-txn-alloc";
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
  linkedTxnId: string | null;
  linkedTxnLabel: string | null;
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

type TransferCand = {
  txnId: string;
  accountCode: string | null;
  accountName: string | null;
  description: string;
  debitMinor: number;
  creditMinor: number;
};

type AllocDraft = {
  allocKind: string;
  openItemId?: string | null;
  accountId?: string | null;
  partyId?: string | null;
  amountOriginalMinor: number;
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
  const [transferCands, setTransferCands] = useState<Record<string, TransferCand[]>>({});
  const [peekId, setPeekId] = useState<string | null>(null);
  const [allocDraft, setAllocDraft] = useState<AllocDraft[]>([]);
  const [feeAccountId, setFeeAccountId] = useState("");

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

  async function loadTransferCandidates(id: string) {
    if (transferCands[id]) return;
    const res = await fetch(`/api/books/bank-transactions/${id}/transfer-candidates`);
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    if (Array.isArray(data)) setTransferCands((prev) => ({ ...prev, [id]: data }));
  }

  async function setTransferLink(id: string, counterpartId: string | null) {
    if (!counterpartId) {
      const res = await fetch(`/api/books/bank-transactions/${id}/transfer-link`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(apiErrorMessage(data));
        return;
      }
      toast.success("Transfer unlinked");
      setTransferCands((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      void reload();
      return;
    }
    const res = await fetch(`/api/books/bank-transactions/${id}/transfer-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ counterpartId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Transfer linked");
    setTransferCands((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    void reload();
  }

  const peekRow = useMemo(() => rows.find((r) => r.id === peekId) || null, [rows, peekId]);
  const peekUnallocated = useMemo(() => {
    if (!peekRow) return 0;
    if (peekRow.txnType !== "customer_receipt" && peekRow.txnType !== "supplier_payment") return 0;
    const bank =
      peekRow.txnType === "customer_receipt" ? peekRow.creditMinor : peekRow.debitMinor;
    return bankTxnUnallocatedMinor(
      bank,
      allocDraft,
      peekRow.txnType === "customer_receipt" ? "receipt" : "payment",
    );
  }, [peekRow, allocDraft]);

  async function openPeek(id: string) {
    setPeekId(id);
    const res = await fetch(`/api/books/bank-transactions/${id}/allocations`);
    const data = await res.json().catch(() => []);
    if (res.ok && Array.isArray(data)) {
      setAllocDraft(
        data.map((l: AllocDraft & { allocKind: string }) => ({
          allocKind: String(l.allocKind),
          openItemId: l.openItemId || null,
          accountId: l.accountId || null,
          partyId: l.partyId || null,
          amountOriginalMinor: Number(l.amountOriginalMinor),
        })),
      );
    } else {
      setAllocDraft([]);
    }
    void loadMatchCandidates(id);
  }

  async function saveAllocations() {
    if (!peekId) return;
    const res = await fetch(`/api/books/bank-transactions/${peekId}/allocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: allocDraft }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success(
      data.unallocatedMinor === 0
        ? "Allocations saved · unallocated 0"
        : `Saved · unallocated ${data.unallocatedMinor}`,
    );
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
                    <tr
                      key={r.id}
                      className="border-t border-border cursor-pointer"
                      data-testid={`txn-row-${r.id}`}
                      onClick={() => void openPeek(r.id)}
                    >
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.txnDate ? formatDateUae(r.txnDate) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <div>{r.description || "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.accountCode} · {r.accountName}
                        </div>
                      </td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
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
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        {r.txnType === "transfer" ? (
                          <span className="text-xs text-muted-foreground">Pair (CV)</span>
                        ) : (
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
                        )}
                      </td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        {r.txnType === "transfer" ? (
                          r.reviewStatus === "posted" ? (
                            <span className="text-xs text-muted-foreground">
                              {r.linkedTxnLabel || "—"}
                            </span>
                          ) : (
                            <Select
                              value={r.linkedTxnId || "__none__"}
                              onValueChange={(v) =>
                                void setTransferLink(r.id, !v || v === "__none__" ? null : v)
                              }
                              onOpenChange={(open) => {
                                if (open) void loadTransferCandidates(r.id);
                              }}
                            >
                              <SelectTrigger
                                className="h-8 w-[220px]"
                                data-testid={`txn-transfer-${r.id}`}
                              >
                                <SelectValue placeholder="Link other account" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">No link</SelectItem>
                                {(transferCands[r.id] || []).map((c) => (
                                  <SelectItem key={c.txnId} value={c.txnId}>
                                    {(c.accountCode || "?") +
                                      ` · ${c.description || "Transfer"} · ${
                                        c.creditMinor > 0 ? "+" : "−"
                                      }${Math.max(c.debitMinor, c.creditMinor)}`}
                                  </SelectItem>
                                ))}
                                {r.linkedTxnId &&
                                !(transferCands[r.id] || []).some((c) => c.txnId === r.linkedTxnId) ? (
                                  <SelectItem value={r.linkedTxnId}>
                                    {r.linkedTxnLabel || r.linkedTxnId.slice(0, 8)}
                                  </SelectItem>
                                ) : null}
                              </SelectContent>
                            </Select>
                          )
                        ) : r.txnType === "customer_receipt" || r.txnType === "supplier_payment" ? (
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
                      <td
                        className="space-x-1 px-3 py-2 text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
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

      <BooksSideDrawer
        open={Boolean(peekId && peekRow)}
        onOpenChange={(o) => {
          if (!o) setPeekId(null);
        }}
        title={peekRow?.description || "Transaction"}
        status={peekRow?.reviewStatus}
        entryType={peekRow?.txnType || undefined}
      >
        {peekRow ? (
          <div className="space-y-4" data-testid="txn-alloc-drawer">
            <p className="text-sm text-muted-foreground">
              {peekRow.txnDate ? formatDateUae(peekRow.txnDate) : "—"} ·{" "}
              {peekRow.accountCode} ·{" "}
              <span className={peekRow.amountSignedMinor >= 0 ? "text-emerald-700" : "text-red-700"}>
                {peekRow.amountSignedMinor >= 0 ? "+" : "−"}
                <CellAmount minor={Math.abs(peekRow.amountSignedMinor)} />
              </span>
            </p>
            {(peekRow.txnType === "customer_receipt" || peekRow.txnType === "supplier_payment") &&
            peekRow.reviewStatus !== "posted" ? (
              <>
                <div className="space-y-2">
                  <Label>Allocations (against item / fee / advance)</Label>
                  <p className="text-xs text-muted-foreground">
                    Unallocated must be 0 to mark Ready. Advance lines: no VAT (owner policy TBD).
                  </p>
                  {allocDraft.map((l, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="w-28">{l.allocKind}</span>
                      <span className="tabular-nums">{l.amountOriginalMinor}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setAllocDraft((prev) => prev.filter((_, j) => j !== i))}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    <Select
                      onValueChange={(v) => {
                        if (!v) return;
                        const c = (matchCands[peekRow.id] || []).find((x) => x.openItemId === v);
                        if (!c) return;
                        setAllocDraft((prev) => [
                          ...prev,
                          {
                            allocKind: "against_item",
                            openItemId: c.openItemId,
                            amountOriginalMinor: c.openOriginalMinor,
                          },
                        ]);
                      }}
                    >
                      <SelectTrigger className="h-8 w-[220px]" data-testid="txn-alloc-add-item">
                        <SelectValue placeholder="Add against item" />
                      </SelectTrigger>
                      <SelectContent>
                        {(matchCands[peekRow.id] || []).map((c) => (
                          <SelectItem key={c.openItemId} value={c.openItemId}>
                            {(c.documentNumber || "Doc") + ` · ${c.openOriginalMinor}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={feeAccountId || undefined} onValueChange={(v) => v && setFeeAccountId(v)}>
                      <SelectTrigger className="h-8 w-[180px]">
                        <SelectValue placeholder="Fee account" />
                      </SelectTrigger>
                      <SelectContent>
                        {coa.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.code} · {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!feeAccountId}
                      onClick={() => {
                        const bank =
                          peekRow.txnType === "customer_receipt"
                            ? peekRow.creditMinor
                            : peekRow.debitMinor;
                        const gap = bankTxnUnallocatedMinor(
                          bank,
                          allocDraft,
                          peekRow.txnType === "customer_receipt" ? "receipt" : "payment",
                        );
                        // Receipt: against > bank → gap negative; add fee = −gap.
                        // Payment: bank > against → gap positive; add fee = gap.
                        const feeAmt =
                          peekRow.txnType === "customer_receipt"
                            ? gap < 0
                              ? -gap
                              : 0
                            : gap > 0
                              ? gap
                              : 0;
                        if (feeAmt <= 0) {
                          toast.error("Nothing to allocate as fee from current gap");
                          return;
                        }
                        setAllocDraft((prev) => [
                          ...prev,
                          {
                            allocKind: "bank_fee",
                            accountId: feeAccountId,
                            amountOriginalMinor: feeAmt,
                          },
                        ]);
                      }}
                    >
                      Add bank fee
                    </Button>
                  </div>
                  <p
                    className={`text-sm font-medium ${peekUnallocated === 0 ? "text-emerald-700" : "text-red-700"}`}
                    data-testid="txn-unallocated"
                  >
                    Unallocated: {peekUnallocated}
                  </p>
                  <Button data-testid="txn-alloc-save" onClick={() => void saveAllocations()}>
                    Save allocations
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {peekRow.openItemLabel || peekRow.linkedTxnLabel || "No allocation panel for this type."}
              </p>
            )}
          </div>
        ) : null}
      </BooksSideDrawer>
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
