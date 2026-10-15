"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { CellAmount } from "@/components/books/cells";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";

type Party = {
  id: string;
  partyType: string;
  name: string;
  trn: string | null;
  country: string;
  emirate: string | null;
  zone: string | null;
  defaultVatCode: string | null;
  paymentTermsDays: number;
  defaultAccountCode: string | null;
  balanceMinor?: number;
};

type FormState = {
  name: string;
  trn: string;
  emirate: string;
  zone: string;
  defaultVatCode: string;
  paymentTermsDays: string;
  force: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  trn: "",
  emirate: "Dubai",
  zone: "mainland",
  defaultVatCode: "SR",
  paymentTermsDays: "30",
  force: false,
};

export default function PartiesPage() {
  const [rows, setRows] = useState<Party[]>([]);
  const [partyType, setPartyType] = useState<"customer" | "supplier">("customer");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; name: string; score: number }>>(
    [],
  );

  const reload = useCallback(async () => {
    const qs = new URLSearchParams({ partyType });
    if (search.trim()) qs.set("q", search.trim());
    const data = await fetch(`/api/books/parties?${qs}`).then((r) => r.json());
    if (Array.isArray(data)) setRows(data);
  }, [partyType, search]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function startEdit(p: Party) {
    setEditingId(p.id);
    setForm({
      name: p.name,
      trn: p.trn || "",
      emirate: p.emirate || "Dubai",
      zone: p.zone || "mainland",
      defaultVatCode: p.defaultVatCode || "SR",
      paymentTermsDays: String(p.paymentTermsDays ?? 30),
      force: false,
    });
    setSuggestions([]);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setSuggestions([]);
  }

  async function saveParty(opts?: { force?: boolean }) {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (form.trn.trim() && !/^100\d{12}$/.test(form.trn.replace(/\s/g, ""))) {
      toast.error("TRN must be 15 digits starting with 100, or left empty");
      return;
    }
    const payload = {
      partyType,
      name: form.name,
      trn: form.trn || null,
      emirate: form.emirate,
      zone: form.zone,
      defaultVatCode: form.defaultVatCode,
      paymentTermsDays: Number(form.paymentTermsDays),
      force: Boolean(opts?.force ?? form.force),
    };

    if (editingId) {
      const res = await fetch(`/api/books/parties/${editingId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(apiErrorMessage(data));
        return;
      }
      toast.success("Party updated");
      cancelEdit();
      void reload();
      return;
    }

    const res = await fetch("/api/books/parties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    if (data.possibleDuplicate) {
      setSuggestions(data.suggestions || []);
      toast.message("Possible duplicate — confirm to force create");
      return;
    }
    setSuggestions([]);
    setForm(EMPTY_FORM);
    toast.success("Party created");
    void reload();
  }

  return (
    <div className="space-y-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Customers &amp; suppliers</h1>
        <div className="flex gap-2">
          <Button
            variant={partyType === "customer" ? "default" : "outline"}
            onClick={() => {
              setPartyType("customer");
              cancelEdit();
            }}
          >
            Customers
          </Button>
          <Button
            variant={partyType === "supplier" ? "default" : "outline"}
            onClick={() => {
              setPartyType("supplier");
              cancelEdit();
            }}
          >
            Suppliers
          </Button>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3" data-testid="party-form">
        <div>
          <Label>
            Name <span className="text-destructive">*</span>
          </Label>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            data-testid="party-name"
          />
        </div>
        <div>
          <Label>TRN (15 digits)</Label>
          <Input
            value={form.trn}
            onChange={(e) => setForm({ ...form, trn: e.target.value })}
            placeholder="100……………"
            inputMode="numeric"
            data-testid="party-trn"
          />
        </div>
        <div>
          <Label>Emirate</Label>
          <Input
            value={form.emirate}
            onChange={(e) => setForm({ ...form, emirate: e.target.value })}
          />
        </div>
        <div>
          <Label>
            Zone <span className="text-destructive">*</span>
          </Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={form.zone}
            onChange={(e) => setForm({ ...form, zone: e.target.value })}
            data-testid="party-zone"
          >
            <option value="mainland">Mainland</option>
            <option value="free_zone">Free zone</option>
            <option value="designated_zone">Designated zone</option>
          </select>
        </div>
        <div>
          <Label>
            Default VAT <span className="text-destructive">*</span>
          </Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={form.defaultVatCode}
            onChange={(e) => setForm({ ...form, defaultVatCode: e.target.value })}
            data-testid="party-vat"
          >
            <option value="SR">SR — Standard 5%</option>
            <option value="ZR">ZR — Zero-rated</option>
            <option value="EX">EX — Exempt</option>
            <option value="OS">OS — Out of scope</option>
            <option value="RC">RC — Reverse charge</option>
          </select>
        </div>
        <div>
          <Label>
            Payment terms (days) <span className="text-destructive">*</span>
          </Label>
          <Input
            type="number"
            min={0}
            value={form.paymentTermsDays}
            onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })}
            data-testid="party-terms"
          />
        </div>
        <div className="md:col-span-3 flex flex-wrap items-end gap-2">
          <Button onClick={() => void saveParty()} data-testid="party-save">
            {editingId ? "Save changes" : "Create"}
          </Button>
          {editingId ? (
            <Button variant="outline" onClick={cancelEdit}>
              Cancel
            </Button>
          ) : null}
          {suggestions.length > 0 && !editingId ? (
            <Button variant="outline" onClick={() => void saveParty({ force: true })}>
              Create anyway
            </Button>
          ) : null}
        </div>
        {suggestions.length > 0 && (
          <p className="md:col-span-3 text-sm text-amber-700">
            Did you mean: {suggestions.map((s) => s.name).join(", ")}?
          </p>
        )}
      </div>

      <Input
        className="max-w-sm"
        placeholder="Search name or TRN"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-testid="party-search"
      />

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm" data-testid="parties-table">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">TRN</th>
              <th className="px-3 py-2">Zone</th>
              <th className="px-3 py-2">VAT</th>
              <th className="px-3 py-2">Terms</th>
              <th className="px-3 py-2 text-end">Balance</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2">{r.trn || "—"}</td>
                <td className="px-3 py-2">{r.zone || "—"}</td>
                <td className="px-3 py-2">{r.defaultVatCode || "—"}</td>
                <td className="px-3 py-2">{r.paymentTermsDays}d</td>
                <td className="px-3 py-2 text-end tabular-nums">
                  <CellAmount minor={Number(r.balanceMinor || 0)} />
                </td>
                <td className="px-3 py-2 text-end">
                  <Button size="sm" variant="outline" onClick={() => startEdit(r)}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-muted-foreground">
                  No {partyType === "customer" ? "customers" : "suppliers"} yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
