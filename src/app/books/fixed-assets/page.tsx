"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useBooksShell } from "@/components/books/books-shell-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";
import { displayToMinor, formatMinor, MoneyTypeError } from "@/lib/money";

type Asset = {
  id: string;
  name: string;
  assetAccountCode: string;
  accumulatedAccountCode: string;
  expenseAccountCode: string;
  costMinor: number;
  residualMinor: number;
  inServiceDate: string;
  lifeMonths: number;
  method: string;
  disposedAt: string | null;
};

type ScheduleLine = {
  monthIndex: number;
  periodLabelHint: string;
  amountMinor: number;
};

export default function BooksFixedAssetsPage() {
  const { periodId, periods } = useBooksShell();
  const [rows, setRows] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [cost, setCost] = useState("36000.00");
  const [residual, setResidual] = useState("0.00");
  const [inService, setInService] = useState("2026-05-01");
  const [lifeMonths, setLifeMonths] = useState("36");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [scheduleFor, setScheduleFor] = useState<Asset | null>(null);
  const [schedule, setSchedule] = useState<ScheduleLine[]>([]);

  const periodLabel = periods.find((p) => p.id === periodId)?.label || "";

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/books/fixed-assets");
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      setLoading(false);
      return;
    }
    setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function addAsset() {
    setSaving(true);
    try {
      const costMinor = displayToMinor(cost);
      const residualMinor = displayToMinor(residual);
      const res = await fetch("/api/books/fixed-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          costMinor,
          residualMinor,
          inServiceDate: inService,
          lifeMonths: Number(lifeMonths),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(apiErrorMessage(data));
        return;
      }
      toast.success("Asset registered");
      setAddOpen(false);
      setName("");
      await reload();
    } catch (e) {
      toast.error(e instanceof MoneyTypeError ? e.message : "Could not save asset");
    } finally {
      setSaving(false);
    }
  }

  async function showSchedule(asset: Asset) {
    setScheduleFor(asset);
    const res = await fetch(`/api/books/fixed-assets/${asset.id}/schedule`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      setSchedule([]);
      return;
    }
    setSchedule(Array.isArray(data.schedule) ? data.schedule : []);
  }

  async function runDepreciation() {
    if (!periodId) {
      toast.error("Select a period");
      return;
    }
    setRunning(true);
    try {
      const res = await fetch("/api/books/fixed-assets/run-depreciation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(apiErrorMessage(data));
        return;
      }
      if (!data.journalEntryId) {
        toast.message("No depreciation due for this period");
      } else if (data.created) {
        toast.success(
          `Draft JV created (${formatMinor(data.totalMinor)} AED) — approver must post`,
        );
      } else {
        toast.message("Depreciation already run for this period (idempotent)");
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">Fixed assets</h1>
          <p className="text-sm text-muted-foreground">
            Straight-line depreciation (full month from in-service month). Last month absorbs
            remainder fils. Run creates a draft JV for dual-control posting.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!periodId || running} onClick={() => void runDepreciation()}>
            {running ? "Running…" : `Run depreciation${periodLabel ? ` — ${periodLabel}` : ""}`}
          </Button>
          <Button onClick={() => setAddOpen(true)}>Add asset</Button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No fixed assets yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">In service</th>
                <th className="px-3 py-2 font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Residual</th>
                <th className="px-3 py-2 font-medium">Life</th>
                <th className="px-3 py-2 font-medium">Accounts</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    {a.name}
                    {a.disposedAt ? (
                      <span className="ml-2 text-xs text-muted-foreground">(disposed)</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{a.inServiceDate}</td>
                  <td className="px-3 py-2 tabular-nums">{formatMinor(a.costMinor)}</td>
                  <td className="px-3 py-2 tabular-nums">{formatMinor(a.residualMinor)}</td>
                  <td className="px-3 py-2 tabular-nums">{a.lifeMonths} mo</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {a.assetAccountCode} / {a.accumulatedAccountCode} / {a.expenseAccountCode}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => void showSchedule(a)}>
                      Schedule
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register fixed asset</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1">
              <Label htmlFor="fa-name">Name</Label>
              <Input id="fa-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <Label htmlFor="fa-cost">Cost (AED)</Label>
                <Input id="fa-cost" value={cost} onChange={(e) => setCost(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="fa-res">Residual (AED)</Label>
                <Input
                  id="fa-res"
                  value={residual}
                  onChange={(e) => setResidual(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <Label htmlFor="fa-svc">In service</Label>
                <Input
                  id="fa-svc"
                  type="date"
                  value={inService}
                  onChange={(e) => setInService(e.target.value)}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="fa-life">Life (months)</Label>
                <Input
                  id="fa-life"
                  value={lifeMonths}
                  onChange={(e) => setLifeMonths(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Defaults: asset 1600, accum. 1690, expense 6800. Method: straight-line.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving || !name.trim()} onClick={() => void addAsset()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(scheduleFor)} onOpenChange={(o) => !o && setScheduleFor(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Schedule — {scheduleFor?.name}</DialogTitle>
          </DialogHeader>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1 font-medium">Month</th>
                <th className="py-1 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((line) => (
                <tr key={line.monthIndex} className="border-b last:border-0">
                  <td className="py-1">{line.periodLabelHint}</td>
                  <td className="py-1 tabular-nums">{formatMinor(line.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DialogContent>
      </Dialog>
    </div>
  );
}
