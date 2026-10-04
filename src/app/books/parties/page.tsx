"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
};

export default function PartiesPage() {
  const [rows, setRows] = useState<Party[]>([]);
  const [partyType, setPartyType] = useState<"customer" | "supplier">("customer");
  const [form, setForm] = useState({
    name: "",
    trn: "",
    emirate: "Dubai",
    zone: "mainland",
    defaultVatCode: "SR",
    paymentTermsDays: "30",
    force: false,
  });
  const [suggestions, setSuggestions] = useState<Array<{ id: string; name: string; score: number }>>(
    [],
  );

  const reload = useCallback(async () => {
    const data = await fetch(`/api/books/parties?partyType=${partyType}`).then((r) => r.json());
    if (Array.isArray(data)) setRows(data);
  }, [partyType]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function createParty() {
    const res = await fetch("/api/books/parties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        partyType,
        name: form.name,
        trn: form.trn || null,
        emirate: form.emirate,
        zone: form.zone,
        defaultVatCode: form.defaultVatCode,
        paymentTermsDays: Number(form.paymentTermsDays),
        force: form.force,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "create_failed");
      return;
    }
    if (data.possibleDuplicate) {
      setSuggestions(data.suggestions || []);
      toast.message("Possible duplicate — confirm to force create");
      return;
    }
    setSuggestions([]);
    setForm((f) => ({ ...f, name: "", trn: "", force: false }));
    toast.success("Party created");
    void reload();
  }

  return (
    <div className="space-y-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Parties</h1>
        <div className="flex gap-2">
          <Button
            variant={partyType === "customer" ? "default" : "outline"}
            onClick={() => setPartyType("customer")}
          >
            Customers
          </Button>
          <Button
            variant={partyType === "supplier" ? "default" : "outline"}
            onClick={() => setPartyType("supplier")}
          >
            Suppliers
          </Button>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3">
        <div>
          <Label>Name</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <Label>TRN</Label>
          <Input value={form.trn} onChange={(e) => setForm({ ...form, trn: e.target.value })} />
        </div>
        <div>
          <Label>Emirate</Label>
          <Input
            value={form.emirate}
            onChange={(e) => setForm({ ...form, emirate: e.target.value })}
          />
        </div>
        <div className="md:col-span-3 flex flex-wrap items-end gap-2">
          <Button onClick={() => void createParty()}>Create</Button>
          {suggestions.length > 0 && (
            <Button
              variant="outline"
              onClick={() => {
                setForm((f) => ({ ...f, force: true }));
                void createParty();
              }}
            >
              Create anyway
            </Button>
          )}
        </div>
        {suggestions.length > 0 && (
          <p className="md:col-span-3 text-sm text-amber-700">
            Did you mean: {suggestions.map((s) => s.name).join(", ")}?
          </p>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">TRN</th>
              <th className="px-3 py-2">Zone</th>
              <th className="px-3 py-2">VAT</th>
              <th className="px-3 py-2">Terms</th>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
