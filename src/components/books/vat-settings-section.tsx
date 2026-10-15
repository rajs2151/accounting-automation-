"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";

const EMIRATES = [
  "Abu Dhabi",
  "Dubai",
  "Sharjah",
  "Ajman",
  "Umm Al Quwain",
  "Ras Al Khaimah",
  "Fujairah",
] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type VatSettings = {
  establishmentEmirate: string | null;
  vatReturnFrequency: "monthly" | "quarterly" | null;
  vatPeriodEndMonth: number | null;
  vatRegistrationStatus: "registered" | "not_registered" | "voluntary" | null;
  designatedZone: boolean;
  trn: string | null;
};

const selectClass = "h-9 w-full rounded-lg border border-border bg-background px-2 text-sm disabled:opacity-60";

/** P2B-8: company VAT settings (admin only): establishment emirate + VAT return period. */
export function VatSettingsSection() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [emirate, setEmirate] = useState("");
  const [frequency, setFrequency] = useState<"" | "monthly" | "quarterly">("");
  const [endMonth, setEndMonth] = useState(3);
  const [regStatus, setRegStatus] = useState<"" | "registered" | "not_registered" | "voluntary">("");
  const [designatedZone, setDesignatedZone] = useState(false);
  const [trn, setTrn] = useState<string | null>(null);
  const [gapCount, setGapCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, me, gaps] = await Promise.all([
      fetch("/api/books/company/vat-settings").then((r) => r.json()).catch(() => null),
      fetch("/api/session").then((r) => r.json()).catch(() => null),
      fetch("/api/books/place-of-supply/gaps").then((r) => r.json()).catch(() => null),
    ]);
    if (s && !s.error) {
      const v = s as VatSettings;
      setEmirate(v.establishmentEmirate || "");
      setFrequency(v.vatReturnFrequency || "");
      setEndMonth(v.vatPeriodEndMonth || 3);
      setRegStatus(v.vatRegistrationStatus || "");
      setDesignatedZone(Boolean(v.designatedZone));
      setTrn(v.trn);
    }
    setIsAdmin(me?.me?.role === "admin");
    setGapCount(Array.isArray(gaps) ? gaps.length : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    const res = await fetch("/api/books/company/vat-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        establishmentEmirate: emirate || null,
        vatReturnFrequency: frequency || null,
        vatPeriodEndMonth: frequency === "quarterly" ? endMonth : null,
        vatRegistrationStatus: regStatus || null,
        designatedZone,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("VAT settings saved");
    await load();
  }

  async function reapply() {
    setBusy(true);
    const res = await fetch("/api/books/place-of-supply/reapply", { method: "POST", body: "{}" });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success(`Place of supply re-applied: ${data.changed} of ${data.checked} documents changed`);
    await load();
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" data-testid="vat-settings">
      <div>
        <h2 className="text-lg font-medium">VAT</h2>
        <p className="text-sm text-muted-foreground">
          Establishment emirate and VAT return period must both be set before due dates appear and before a VAT
          return draft can be generated. TRN is edited on the company profile
          {trn ? ` (current ${trn})` : " (not set)"}.
          {isAdmin ? "" : " Only an admin can change these."}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="vat-reg-status">VAT registration</Label>
          <select
            id="vat-reg-status"
            className={selectClass}
            value={regStatus}
            disabled={!isAdmin}
            onChange={(e) =>
              setRegStatus(e.target.value as "" | "registered" | "not_registered" | "voluntary")
            }
            data-testid="vat-registration-status"
          >
            <option value="">Not set</option>
            <option value="registered">Registered</option>
            <option value="voluntary">Voluntary</option>
            <option value="not_registered">Not registered</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="vat-designated-zone">Designated zone</Label>
          <select
            id="vat-designated-zone"
            className={selectClass}
            value={designatedZone ? "yes" : "no"}
            disabled={!isAdmin}
            onChange={(e) => setDesignatedZone(e.target.value === "yes")}
            data-testid="vat-designated-zone"
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="vat-emirate">Establishment emirate</Label>
          <select
            id="vat-emirate"
            className={selectClass}
            value={emirate}
            disabled={!isAdmin}
            onChange={(e) => setEmirate(e.target.value)}
            data-testid="vat-establishment-emirate"
          >
            <option value="">Not set</option>
            {EMIRATES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="vat-frequency">VAT return period</Label>
          <select
            id="vat-frequency"
            className={selectClass}
            value={frequency}
            disabled={!isAdmin}
            onChange={(e) => setFrequency(e.target.value as "" | "monthly" | "quarterly")}
            data-testid="vat-frequency"
          >
            <option value="">Not set</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
        </div>
        {frequency === "quarterly" ? (
          <div className="space-y-1">
            <Label htmlFor="vat-end-month">A quarter ends in</Label>
            <select
              id="vat-end-month"
              className={selectClass}
              value={endMonth}
              disabled={!isAdmin}
              onChange={(e) => setEndMonth(Number(e.target.value))}
              data-testid="vat-period-end-month"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">Any month in which one of the FTA tax periods ends.</p>
          </div>
        ) : null}
      </div>
      {gapCount ? (
        <p className="text-sm text-amber-700" data-testid="vat-pos-gaps">
          {gapCount} posted {gapCount === 1 ? "document has" : "documents have"} no place of supply. The VAT
          return stays blocked until these are fixed.
        </p>
      ) : null}
      {isAdmin ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save()} disabled={busy} data-testid="vat-settings-save">
            Save VAT settings
          </Button>
          <Button
            variant="outline"
            onClick={() => void reapply()}
            disabled={busy}
            data-testid="vat-pos-reapply"
          >
            Re-apply place-of-supply rule
          </Button>
        </div>
      ) : null}
    </section>
  );
}
