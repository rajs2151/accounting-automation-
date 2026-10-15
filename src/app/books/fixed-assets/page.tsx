"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useBooksShell } from "@/components/books/books-shell-context";
import { BooksDateInput } from "@/components/books/date-input";
import { StatusBadge } from "@/components/books/status-badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
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
  costStatus?: "posted" | "draft" | "missing" | "unlinked";
  sourceEntryNo?: string | null;
  sourceReference?: string | null;
};

type Opt = { id: string; code: string; name: string };
type AccountOptions = {
  assetAccounts: Array<
    Opt & { subType: string; defaultAccumulatedAccountId: string | null; defaultExpenseAccountId: string | null }
  >;
  accumulatedAccounts: Array<Opt & { subType: string }>;
  expenseAccounts: Opt[];
  creditAccounts: Array<Opt & { kind: string }>;
};
type Bill = { id: string; documentNumber: string | null; partyName: string | null; grossMinor: number };

const COST_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  posted: { label: "Cost posted", tone: "success" },
  draft: { label: "Cost awaiting approver", tone: "warning" },
  missing: { label: "Cost entry deleted", tone: "danger" },
  unlinked: { label: "Cost not linked", tone: "danger" },
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
  const [cost, setCost] = useState("");
  const [residual, setResidual] = useState("0.00");
  const [inService, setInService] = useState("");
  const [lifeMonths, setLifeMonths] = useState("");
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<AccountOptions | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [assetAccountId, setAssetAccountId] = useState("");
  const [accumAccountId, setAccumAccountId] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [costSource, setCostSource] = useState<"draft" | "bill">("draft");
  const [creditAccountId, setCreditAccountId] = useState("");
  const [billId, setBillId] = useState("");
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

  useEffect(() => {
    if (!addOpen) return;
    setCost("");
    setLifeMonths("");
    setInService(new Date().toISOString().slice(0, 10));
    setCostSource("bill");
    void fetch("/api/books/fixed-assets/account-options")
      .then((r) => r.json())
      .then((d: AccountOptions) => {
        if (!d || !Array.isArray(d.assetAccounts)) return;
        setOptions(d);
        setCreditAccountId((cur) => cur || d.creditAccounts.find((c) => c.kind === "bank")?.id || "");
      })
      .catch(() => undefined);
    void fetch("/api/books/documents?docType=purchase_bill")
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d)) return;
        const posted = d.filter((b: { status?: string }) =>
          ["posted", "partially_paid", "paid"].includes(String(b.status)),
        );
        setBills(posted);
        if (!posted.length) setCostSource("draft");
      })
      .catch(() => undefined);
  }, [addOpen]);

  function chooseAssetAccount(id: string) {
    setAssetAccountId(id);
    const a = options?.assetAccounts.find((x) => x.id === id);
    setAccumAccountId(a?.defaultAccumulatedAccountId || "");
    setExpenseAccountId(a?.defaultExpenseAccountId || "");
  }

  const chosenAsset = options?.assetAccounts.find((a) => a.id === assetAccountId);
  const canSave =
    Boolean(name.trim()) &&
    Boolean(assetAccountId) &&
    (costSource === "draft" ? Boolean(creditAccountId) : Boolean(billId));

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
          assetAccountId,
          accumulatedAccountId: accumAccountId || undefined,
          expenseAccountId: expenseAccountId || undefined,
          acquisitionCreditAccountId: costSource === "draft" ? creditAccountId : undefined,
          sourceDocumentId: costSource === "bill" ? billId : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(apiErrorMessage(data));
        return;
      }
      toast.success(
        data.acquisitionJournalEntryId
          ? "Asset registered — acquisition journal saved as a draft for an approver to post"
          : "Asset registered against the posted purchase",
      );
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
      if (Array.isArray(data.uncostedAssets) && data.uncostedAssets.length) {
        toast.warning(
          `No cost is linked for: ${data.uncostedAssets.join(", ")}. Check the purchase was booked to the asset account.`,
        );
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
    <div className="mx-auto max-w-[1400px] space-y-4 py-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Fixed assets</h1>
          <p className="text-sm text-muted-foreground">
            Straight-line depreciation (full month from in-service month). Catch-up is included when
            the in-service date is before the open period. Run creates a draft JV for dual-control
            posting.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!periodId || running || rows.length === 0}
            title={rows.length === 0 ? "Add an asset before running depreciation" : undefined}
            onClick={() => void runDepreciation()}
            data-testid="fa-run-depreciation"
          >
            {running ? "Running…" : `Run depreciation${periodLabel ? ` — ${periodLabel}` : ""}`}
          </Button>
          <Button onClick={() => setAddOpen(true)} data-testid="fa-add">
            Add asset
          </Button>
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
                <th className="px-3 py-2 font-medium">Cost booked</th>
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
                  <td className="px-3 py-2 tabular-nums">
                    {a.inServiceDate ? formatDateUae(a.inServiceDate.slice(0, 10)) : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatMinor(a.costMinor)}</td>
                  <td className="px-3 py-2 tabular-nums">{formatMinor(a.residualMinor)}</td>
                  <td className="px-3 py-2 tabular-nums">{a.lifeMonths} mo</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {a.assetAccountCode} / {a.accumulatedAccountCode} / {a.expenseAccountCode}
                  </td>
                  <td className="px-3 py-2" data-testid={`asset-cost-${a.id}`}>
                    <StatusBadge meta={COST_STATUS[a.costStatus || "unlinked"] || COST_STATUS.unlinked} />
                    {a.sourceEntryNo || a.sourceReference ? (
                      <div className="text-xs text-muted-foreground">
                        {a.sourceEntryNo || a.sourceReference}
                      </div>
                    ) : null}
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
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Register fixed asset</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1">
              <Label htmlFor="fa-name">Name</Label>
              <Input id="fa-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-1">
                <Label htmlFor="fa-cost">Cost (AED)</Label>
                <Input
                  id="fa-cost"
                  value={cost}
                  placeholder="0.00"
                  onChange={(e) => setCost(e.target.value)}
                />
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-1">
                <Label htmlFor="fa-svc">In service</Label>
                <BooksDateInput
                  id="fa-svc"
                  value={inService}
                  onChange={(iso) => setInService(iso)}
                  data-testid="fa-in-service"
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="fa-life">Life (months)</Label>
                <Input
                  id="fa-life"
                  value={lifeMonths}
                  placeholder="e.g. 36"
                  onChange={(e) => setLifeMonths(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1">
              <Label>Asset account</Label>
              <Select value={assetAccountId || undefined} onValueChange={(v) => chooseAssetAccount(String(v ?? ""))}>
                <SelectTrigger className="w-full min-w-0 max-w-full" data-testid="fa-asset-account">
                  <SelectValue placeholder="Choose asset account" />
                </SelectTrigger>
                <SelectContent>
                  {(options?.assetAccounts || []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid min-w-0 gap-1">
                <Label>{chosenAsset?.subType === "ia" ? "Accum. amortisation" : "Accum. depreciation"}</Label>
                <Select value={accumAccountId || undefined} onValueChange={(v) => setAccumAccountId(String(v ?? ""))}>
                  <SelectTrigger className="w-full min-w-0 max-w-full" data-testid="fa-accum-account">
                    <SelectValue placeholder="Account" />
                  </SelectTrigger>
                  <SelectContent>
                    {(options?.accumulatedAccounts || [])
                      .filter((a) => !chosenAsset || a.subType === `${chosenAsset.subType}_contra`)
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid min-w-0 gap-1">
                <Label>{chosenAsset?.subType === "ia" ? "Amortisation expense" : "Depreciation expense"}</Label>
                <Select value={expenseAccountId || undefined} onValueChange={(v) => setExpenseAccountId(String(v ?? ""))}>
                  <SelectTrigger className="w-full min-w-0 max-w-full" data-testid="fa-expense-account">
                    <SelectValue placeholder="Account" />
                  </SelectTrigger>
                  <SelectContent>
                    {(options?.expenseAccounts || []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2 rounded-md border border-border p-3">
              <Label>How is the cost booked?</Label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="fa-cost-source"
                  checked={costSource === "draft"}
                  onChange={() => setCostSource("draft")}
                  data-testid="fa-cost-draft"
                />
                <span>
                  Create an acquisition journal (draft): Dr asset account / Cr the account below. An
                  approver posts it.
                </span>
              </label>
              {costSource === "draft" ? (
                <Select value={creditAccountId || undefined} onValueChange={(v) => setCreditAccountId(String(v ?? ""))}>
                  <SelectTrigger className="w-full min-w-0 max-w-full" data-testid="fa-credit-account">
                    <SelectValue placeholder="Paid from" />
                  </SelectTrigger>
                  <SelectContent>
                    {(options?.creditAccounts || []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="fa-cost-source"
                  checked={costSource === "bill"}
                  onChange={() => setCostSource("bill")}
                  data-testid="fa-cost-bill"
                />
                <span>It was bought on a posted purchase bill (booked to the asset account)</span>
              </label>
              {costSource === "bill" ? (
                <Select value={billId || undefined} onValueChange={(v) => setBillId(String(v ?? ""))}>
                  <SelectTrigger className="w-full min-w-0 max-w-full" data-testid="fa-source-bill">
                    <SelectValue placeholder="Choose the bill" />
                  </SelectTrigger>
                  <SelectContent>
                    {bills.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.documentNumber || "Bill"} · {b.partyName || "—"} · {formatMinor(b.grossMinor)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Depreciation only runs once the cost is posted. VAT-registered companies should{" "}
                <a href="/books/purchases" className="underline underline-offset-2">
                  record a purchase bill
                </a>{" "}
                (input VAT recovered there) and link it here.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving || !canSave} onClick={() => void addAsset()}>
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
