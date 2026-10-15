"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";
import { fxRateScaledToNumber } from "@/lib/fx";

type FxRate = {
  id: string;
  currency: string;
  rateDate: string;
  rateScaled: number;
  source: string;
};

export function FxRatesSection() {
  const [rows, setRows] = useState<FxRate[]>([]);
  const [currency, setCurrency] = useState("USD");
  const [rateDate, setRateDate] = useState("2026-05-31");
  const [rate, setRate] = useState("3.6730");
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    const res = await fetch("/api/books/fx-rates");
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    setRows(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/books/fx-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency, rateDate, rate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(apiErrorMessage(data));
        return;
      }
      toast.success("FX rate saved");
      await reload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      id="fx-rates"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="fx-rates-section"
    >
      <h2 className="text-lg font-medium">FX rates</h2>
      <p className="text-sm text-muted-foreground">
        Manual rates to AED (scale 1e8). Month-end revaluation never invents a rate — add the
        period-end date before running Revalue FX on Close.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="grid gap-1">
          <Label htmlFor="fx-ccy">Currency</Label>
          <Input id="fx-ccy" value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="fx-date">Rate date</Label>
          <Input
            id="fx-date"
            type="date"
            value={rateDate}
            onChange={(e) => setRateDate(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="fx-rate">Rate (to AED)</Label>
          <Input id="fx-rate" value={rate} onChange={(e) => setRate(e.target.value)} />
        </div>
        <div className="flex items-end">
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Add rate"}
          </Button>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rates yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 font-medium">Currency</th>
              <th className="py-1 font-medium">Date</th>
              <th className="py-1 font-medium">Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="py-1.5">{r.currency}</td>
                <td className="py-1.5 tabular-nums">{r.rateDate}</td>
                <td className="py-1.5 tabular-nums">{fxRateScaledToNumber(r.rateScaled).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
