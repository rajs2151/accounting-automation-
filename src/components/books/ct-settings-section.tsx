"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";

type CtSettings = {
  sbrElected: boolean | null;
  isQfzp: boolean | null;
  requireDualControl: boolean;
};

const selectClass = "h-9 w-full rounded-lg border border-border bg-background px-2 text-sm disabled:opacity-60";

function tri(v: boolean | null): "" | "yes" | "no" {
  if (v === true) return "yes";
  if (v === false) return "no";
  return "";
}

function fromTri(v: string): boolean | null {
  if (v === "yes") return true;
  if (v === "no") return false;
  return null;
}

/** Corporate tax + dual-control company settings (admin). */
export function CtSettingsSection() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [sbr, setSbr] = useState<"" | "yes" | "no">("");
  const [qfzp, setQfzp] = useState<"" | "yes" | "no">("");
  const [dual, setDual] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, me] = await Promise.all([
      fetch("/api/books/company/ct-settings").then((r) => r.json()).catch(() => null),
      fetch("/api/session").then((r) => r.json()).catch(() => null),
    ]);
    if (s && !s.error) {
      const v = s as CtSettings;
      setSbr(tri(v.sbrElected));
      setQfzp(tri(v.isQfzp));
      setDual(v.requireDualControl !== false);
    }
    setIsAdmin(me?.me?.role === "admin");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    const res = await fetch("/api/books/company/ct-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sbrElected: fromTri(sbr),
        isQfzp: fromTri(qfzp),
        requireDualControl: dual,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Corporate tax settings saved");
    await load();
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" data-testid="ct-settings">
      <div>
        <h2 className="text-lg font-medium">Corporate tax &amp; dual control</h2>
        <p className="text-sm text-muted-foreground">
          Record Small Business Relief and QFZP before the P&amp;L treats tax as zero. Dual control
          (preparer ≠ approver) stays on unless you turn it off for lab use.
          {isAdmin ? "" : " Only an admin can change these."}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="ct-sbr">Small Business Relief elected</Label>
          <select
            id="ct-sbr"
            className={selectClass}
            value={sbr}
            disabled={!isAdmin}
            onChange={(e) => setSbr(e.target.value as "" | "yes" | "no")}
            data-testid="ct-sbr-elected"
          >
            <option value="">Not recorded</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="ct-qfzp">QFZP</Label>
          <select
            id="ct-qfzp"
            className={selectClass}
            value={qfzp}
            disabled={!isAdmin}
            onChange={(e) => setQfzp(e.target.value as "" | "yes" | "no")}
            data-testid="ct-is-qfzp"
          >
            <option value="">Not recorded</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="ct-dual">Require dual control</Label>
          <select
            id="ct-dual"
            className={selectClass}
            value={dual ? "yes" : "no"}
            disabled={!isAdmin}
            onChange={(e) => setDual(e.target.value === "yes")}
            data-testid="ct-require-dual-control"
          >
            <option value="yes">Yes (default)</option>
            <option value="no">No (lab only)</option>
          </select>
        </div>
      </div>
      {isAdmin ? (
        <Button onClick={() => void save()} disabled={busy} data-testid="ct-settings-save">
          Save CT settings
        </Button>
      ) : null}
    </section>
  );
}
