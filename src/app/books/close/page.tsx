"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useBooksShell } from "@/components/books/books-shell-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api-error";
import { formatMinor } from "@/lib/money";

type CloseGate = {
  key: string;
  label: string;
  status: "pass" | "fail" | "waived" | "info" | "not_set_up";
  blocking: boolean;
  count: number;
  href: string;
  detail?: string;
  balanceMinor?: number;
  waiverReason?: string | null;
  pendingWaiver?: { reason: string; requestedBy: string } | null;
};

type Checklist = {
  period: {
    id: string;
    label: string;
    start: string;
    end: string;
    status: string;
    changedSinceClose: boolean;
  };
  gates: CloseGate[];
  ready: boolean;
  failing: string[];
};

type YearEndStatus = {
  isYearEndPeriod: boolean;
  fiscalYear: number;
  state: "none" | "draft" | "posted" | "reversed" | "discarded";
  journalEntryId: string | null;
  netIncomeMinor: number | null;
  preparedByName: string | null;
  entryNo: string | null;
  canPost: boolean;
};

type CloseEvent = {
  id: string;
  action: string;
  reason: string;
  at: string;
  actorName: string | null;
};

function statusBadge(status: CloseGate["status"]) {
  const map: Record<CloseGate["status"], { label: string; className: string }> = {
    pass: { label: "Pass", className: "bg-emerald-100 text-emerald-900" },
    fail: { label: "Fail", className: "bg-red-100 text-red-900" },
    waived: { label: "Waived", className: "bg-amber-100 text-amber-900" },
    info: { label: "Info", className: "bg-slate-100 text-slate-800" },
    not_set_up: { label: "Not set up", className: "bg-muted text-muted-foreground" },
  };
  const m = map[status];
  return <Badge className={m.className}>{m.label}</Badge>;
}

export default function BooksClosePage() {
  const { periodId, periods, reloadPeriods } = useBooksShell();
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [events, setEvents] = useState<CloseEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [waiveGate, setWaiveGate] = useState<CloseGate | null>(null);
  const [waiveAction, setWaiveAction] = useState<"request" | "confirm">("request");
  const [waiveReason, setWaiveReason] = useState("");
  const [expandedDetail, setExpandedDetail] = useState<Record<string, boolean>>({});
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [lockConfirmOpen, setLockConfirmOpen] = useState(false);
  const [unlockReason, setUnlockReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [meId, setMeId] = useState("");
  const [revaluing, setRevaluing] = useState(false);
  const [closingYear, setClosingYear] = useState(false);
  const [yearEnd, setYearEnd] = useState<YearEndStatus | null>(null);

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((d) => {
        const role = String(d?.me?.role || "");
        setCanApprove(role === "admin" || role === "approver");
        setMeId(String(d?.me?.id || ""));
      })
      .catch(() => setCanApprove(false));
  }, []);

  const reload = useCallback(async () => {
    if (!periodId) return;
    setLoading(true);
    setError("");
    try {
      const [cRes, eRes, yRes] = await Promise.all([
        fetch(`/api/books/close?periodId=${periodId}`),
        fetch(`/api/books/close/events?periodId=${periodId}`),
        fetch(`/api/books/year-end/status?periodId=${periodId}`),
      ]);
      const c = await cRes.json();
      const e = await eRes.json();
      const y = await yRes.json().catch(() => null);
      if (!cRes.ok) throw new Error(apiErrorMessage(c) || c.error || "load_failed");
      setChecklist(c);
      setEvents(Array.isArray(e) ? e : []);
      setYearEnd(yRes.ok && y ? (y as YearEndStatus) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }, [periodId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function lockPeriod() {
    if (!periodId) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/books/close/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId }),
      });
      const data = await res.json();
      if (!res.ok) {
        const failList = Array.isArray(data.failingGates)
          ? data.failingGates.map((g: { key: string; label?: string }) => g.label || g.key).join(", ")
          : "";
        throw new Error(
          apiErrorMessage(data) + (failList ? ` (${failList})` : ""),
        );
      }
      setLockConfirmOpen(false);
      toast.success(`${periodLabel} locked`);
      await reloadPeriods();
      await reload();
    } catch (err) {
      setLockConfirmOpen(false);
      const msg = err instanceof Error ? err.message : apiErrorMessage({ error: "lock_failed" });
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function confirmWaive() {
    if (!periodId || !waiveGate) return;
    if (waiveAction === "request" && !waiveReason.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/books/close/waive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodId,
          gateKey: waiveGate.key,
          reason: waiveReason.trim() || waiveGate.pendingWaiver?.reason || "",
          action: waiveAction,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(apiErrorMessage(data) || data.error);
      setWaiveGate(null);
      setWaiveReason("");
      toast.success(waiveAction === "confirm" ? "Waiver confirmed" : "Waiver requested — needs approver");
      await reloadPeriods();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "waive_failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirmUnlock() {
    if (!periodId || !unlockReason.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/books/close/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId, reason: unlockReason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(apiErrorMessage(data) || data.error);
      setUnlockOpen(false);
      setUnlockReason("");
      toast.success(`${periodLabel} unlocked`);
      await reloadPeriods();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unlock_failed");
    } finally {
      setBusy(false);
    }
  }

  const periodLabel =
    checklist?.period.label || periods.find((p) => p.id === periodId)?.label || "—";
  const locked = checklist?.period.status === "LOCKED";

  async function revalueFx() {
    if (!periodId) return;
    setRevaluing(true);
    setError("");
    try {
      const res = await fetch("/api/books/fx-revaluation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(data) || data.error || "revalue_failed");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "revalue_failed");
    } finally {
      setRevaluing(false);
    }
  }

  async function closeYear() {
    if (!periodId) return;
    setClosingYear(true);
    setError("");
    try {
      const res = await fetch("/api/books/year-end/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(data) || data.error || "year_end_failed");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "year_end_failed");
    } finally {
      setClosingYear(false);
    }
  }

  /** Step 2: a different approver/admin posts the prepared closing entry. */
  async function postYearEnd() {
    if (!yearEnd) return;
    setClosingYear(true);
    setError("");
    try {
      const res = await fetch("/api/books/year-end/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fiscalYear: yearEnd.fiscalYear }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(data) || data.error || "year_end_post_failed");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "year_end_post_failed");
    } finally {
      setClosingYear(false);
    }
  }

  const yearEndPending = yearEnd?.state === "draft";
  const yearEndClosed = yearEnd?.state === "posted";

  return (
    <div className="space-y-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Month-end close</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Checklist for {periodLabel}
            {checklist?.period.changedSinceClose ? (
              <span className="ml-2 text-amber-700">· Changed since close</span>
            ) : null}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!periodId || locked || revaluing || busy}
            onClick={() => void revalueFx()}
          >
            {revaluing ? "Revaluing…" : "Revalue FX"}
          </Button>
          {yearEndPending ? (
            <Button
              variant="outline"
              disabled={!yearEnd?.canPost || locked || closingYear || busy || !checklist?.ready}
              onClick={() => void postYearEnd()}
              title={`Prepared by ${yearEnd?.preparedByName || "another user"} — a different approver or admin must post it`}
            >
              {closingYear ? "Posting…" : "Post year-end entry"}
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={
                !periodId ||
                !canApprove ||
                locked ||
                closingYear ||
                busy ||
                !checklist?.ready ||
                yearEndClosed ||
                yearEnd?.isYearEndPeriod === false
              }
              onClick={() => void closeYear()}
              title="Prepares the closing entry as a draft (last month of the fiscal year, earlier months locked, checklist ready); a different approver posts it"
            >
              {closingYear ? "Closing…" : yearEndClosed ? "Year closed" : "Close year"}
            </Button>
          )}
          {locked ? (
            <Button
              variant="outline"
              disabled={!canApprove || busy}
              onClick={() => setUnlockOpen(true)}
            >
              Unlock
            </Button>
          ) : (
            <Button
              disabled={!canApprove || busy || !checklist?.ready}
              onClick={() => setLockConfirmOpen(true)}
              title={
                !canApprove
                  ? "Only an approver or admin can lock"
                  : !checklist?.ready
                    ? "Fix or waive failing checklist items first"
                    : undefined
              }
            >
              Lock period
            </Button>
          )}
        </div>
      </div>

      {!periodId ? (
        <p className="text-sm text-muted-foreground">Select a period in the top bar.</p>
      ) : null}
      {checklist && !locked && !checklist.ready ? (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
          data-testid="close-lock-blocked"
        >
          <p className="font-medium">Lock is disabled until these checklist items pass or are waived:</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {checklist.gates
              .filter((g) => g.blocking && g.status === "fail")
              .map((g) => (
                <li key={g.key}>
                  <Link href={g.href} className="underline-offset-2 hover:underline">
                    {g.label}
                  </Link>
                  {g.detail ? <span className="text-muted-foreground"> — {g.detail}</span> : null}
                </li>
              ))}
          </ul>
          {!canApprove ? (
            <p className="mt-1 text-muted-foreground">Only an approver or admin can lock this period.</p>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {yearEndPending ? (
        <p className="text-sm text-amber-700">
          Year-end entry FY{yearEnd?.fiscalYear} prepared
          {yearEnd?.preparedByName ? ` by ${yearEnd.preparedByName}` : ""}
          {yearEnd?.netIncomeMinor != null ? ` (net income ${formatMinor(yearEnd.netIncomeMinor)} AED)` : ""}
          {" "}— waiting for a different approver to post it.
        </p>
      ) : null}
      {loading && !checklist ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {checklist ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Checklist item</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Exceptions</th>
                <th className="px-3 py-2 font-medium">Detail</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {checklist.gates.map((g) => {
                const longDetail = Boolean(g.detail && g.detail.length > 80);
                const open = Boolean(expandedDetail[g.key]);
                const detailText =
                  g.balanceMinor != null
                    ? `${formatMinor(g.balanceMinor)} AED · ${g.detail || g.waiverReason || ""}`
                    : g.detail || g.waiverReason || "—";
                return (
                <tr key={g.key} className="border-t border-border">
                  <td className="px-3 py-2.5">
                    <Link href={g.href} className="font-medium text-foreground underline-offset-2 hover:underline">
                      {g.label}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">{statusBadge(g.status)}</td>
                  <td className="px-3 py-2.5 tabular-nums">{g.count}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {longDetail && !open ? (
                      <button
                        type="button"
                        className="text-left underline-offset-2 hover:underline"
                        onClick={() => setExpandedDetail((m) => ({ ...m, [g.key]: true }))}
                      >
                        {g.count} exception{g.count === 1 ? "" : "s"} — show detail
                      </button>
                    ) : (
                      <span>
                        {detailText}
                        {longDetail ? (
                          <button
                            type="button"
                            className="ms-2 text-xs underline-offset-2 hover:underline"
                            onClick={() => setExpandedDetail((m) => ({ ...m, [g.key]: false }))}
                          >
                            Hide
                          </button>
                        ) : null}
                      </span>
                    )}
                    {g.pendingWaiver ? (
                      <div className="mt-1 text-xs text-amber-800 dark:text-amber-200">
                        Waiver pending confirmation
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-right space-x-1">
                    {!locked &&
                    g.blocking &&
                    (g.status === "fail" || g.status === "not_set_up") &&
                    !g.pendingWaiver ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setWaiveGate(g);
                          setWaiveAction("request");
                          setWaiveReason("");
                        }}
                      >
                        Request waive
                      </Button>
                    ) : null}
                    {canApprove &&
                    !locked &&
                    g.pendingWaiver &&
                    g.pendingWaiver.requestedBy !== meId ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setWaiveGate(g);
                          setWaiveAction("confirm");
                          setWaiveReason(g.pendingWaiver?.reason || "");
                        }}
                      >
                        Confirm waive
                      </Button>
                    ) : null}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div>
        <h2 className="mb-2 text-sm font-semibold">Close history</h2>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="close-events-empty">
            {locked
              ? "Locked (no close events recorded — seed or legacy)."
              : "No lock / unlock / waive events yet."}
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {events.map((ev) => (
              <li key={ev.id} className="rounded border border-border px-3 py-2">
                <span className="font-medium">{ev.action}</span>
                {ev.actorName ? <span className="text-muted-foreground"> · {ev.actorName}</span> : null}
                {ev.reason ? <span className="text-muted-foreground"> — {ev.reason}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={Boolean(waiveGate)} onOpenChange={(o) => !o && setWaiveGate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {waiveAction === "confirm" ? "Confirm waive" : "Request waive"}: {waiveGate?.label}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {waiveAction === "confirm"
              ? "A different approver must confirm. Reason was set by the requester."
              : "Reason is required. An approver other than you must confirm before lock."}
          </p>
          <Textarea
            placeholder="Reason (required)"
            value={waiveReason}
            onChange={(e) => setWaiveReason(e.target.value)}
            disabled={waiveAction === "confirm"}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaiveGate(null)}>
              Cancel
            </Button>
            <Button
              disabled={(waiveAction === "request" && !waiveReason.trim()) || busy}
              onClick={() => void confirmWaive()}
            >
              {waiveAction === "confirm" ? "Confirm waive" : "Request waive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={lockConfirmOpen} onOpenChange={(o) => !busy && setLockConfirmOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lock {periodLabel}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Nothing can be posted, changed or reversed in {periodLabel} once it is locked. Unlocking later needs an
            approver or admin and a reason, and is recorded in the close history.
          </p>
          {checklist?.gates.some((g) => g.status === "waived") ? (
            <p className="text-sm text-amber-700">
              Waived gates:{" "}
              {checklist.gates
                .filter((g) => g.status === "waived")
                .map((g) => g.label)
                .join(", ")}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setLockConfirmOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void lockPeriod()} data-testid="close-lock-confirm">
              {busy ? "Locking…" : "Lock period"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={unlockOpen} onOpenChange={setUnlockOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unlock period</DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder="Reason (required)"
            value={unlockReason}
            onChange={(e) => setUnlockReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnlockOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!unlockReason.trim() || busy} onClick={() => void confirmUnlock()}>
              Unlock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
