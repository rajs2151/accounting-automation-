"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

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
  const { periodId, periods } = useBooksShell();
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [events, setEvents] = useState<CloseEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [waiveGate, setWaiveGate] = useState<CloseGate | null>(null);
  const [waiveReason, setWaiveReason] = useState("");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockReason, setUnlockReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [revaluing, setRevaluing] = useState(false);

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((d) => {
        const role = String(d?.me?.role || "");
        setCanApprove(role === "admin" || role === "approver");
      })
      .catch(() => setCanApprove(false));
  }, []);

  const reload = useCallback(async () => {
    if (!periodId) return;
    setLoading(true);
    setError("");
    try {
      const [cRes, eRes] = await Promise.all([
        fetch(`/api/books/close?periodId=${periodId}`),
        fetch(`/api/books/close/events?periodId=${periodId}`),
      ]);
      const c = await cRes.json();
      const e = await eRes.json();
      if (!cRes.ok) throw new Error(apiErrorMessage(c) || c.error || "load_failed");
      setChecklist(c);
      setEvents(Array.isArray(e) ? e : []);
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
          ? data.failingGates.map((g: { key: string }) => g.key).join(", ")
          : "";
        throw new Error(
          apiErrorMessage(data) + (failList ? ` (${failList})` : ""),
        );
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "lock_failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirmWaive() {
    if (!periodId || !waiveGate || !waiveReason.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/books/close/waive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodId,
          gateKey: waiveGate.key,
          reason: waiveReason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(apiErrorMessage(data) || data.error);
      setWaiveGate(null);
      setWaiveReason("");
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
          {locked ? (
            <Button
              variant="outline"
              disabled={!canApprove || busy}
              onClick={() => setUnlockOpen(true)}
            >
              Unlock
            </Button>
          ) : (
            <Button disabled={!canApprove || busy || !checklist?.ready} onClick={() => void lockPeriod()}>
              Lock period
            </Button>
          )}
        </div>
      </div>

      {!periodId ? (
        <p className="text-sm text-muted-foreground">Select a period in the top bar.</p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {loading && !checklist ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {checklist ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Gate</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Count</th>
                <th className="px-3 py-2 font-medium">Detail</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {checklist.gates.map((g) => (
                <tr key={g.key} className="border-t border-border">
                  <td className="px-3 py-2.5">
                    <Link href={g.href} className="font-medium text-foreground underline-offset-2 hover:underline">
                      {g.label}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">{statusBadge(g.status)}</td>
                  <td className="px-3 py-2.5 tabular-nums">{g.count}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {g.balanceMinor != null ? `${formatMinor(g.balanceMinor)} AED · ` : ""}
                    {g.detail || g.waiverReason || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {canApprove && !locked && g.blocking && g.status === "fail" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setWaiveGate(g);
                          setWaiveReason("");
                        }}
                      >
                        Waive
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div>
        <h2 className="mb-2 text-sm font-semibold">Close history</h2>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No lock / unlock / waive events yet.</p>
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
            <DialogTitle>Waive: {waiveGate?.label}</DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder="Reason (required)"
            value={waiveReason}
            onChange={(e) => setWaiveReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaiveGate(null)}>
              Cancel
            </Button>
            <Button disabled={!waiveReason.trim() || busy} onClick={() => void confirmWaive()}>
              Waive gate
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
