"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

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
import { apiErrorMessage } from "@/lib/api-error";
import { BANK_TXN_TYPE_LABEL, BANK_TXN_TYPES } from "@/lib/bank-txn-types";

type Rule = {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  counterpartyContains: string | null;
  narrationRegex: string | null;
  direction: "in" | "out" | null;
  setTxnType: string | null;
  setCategoryAccountId: string | null;
};

type Preview = {
  ruleId: string;
  name: string;
  matchCount: number;
  sample: Array<{ id: string; description: string; amountMinor: number }>;
};

export default function BankRulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [contains, setContains] = useState("");
  const [direction, setDirection] = useState<"in" | "out" | "">("");
  const [setTxnType, setSetTxnType] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/books/bank-rules");
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      setLoading(false);
      return;
    }
    setRules(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function createRule() {
    const res = await fetch("/api/books/bank-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        counterpartyContains: contains || null,
        direction: direction || null,
        setTxnType: setTxnType || null,
        priority: 100,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Rule created");
    setName("");
    setContains("");
    setDirection("");
    setSetTxnType("");
    void reload();
  }

  async function toggleActive(r: Rule) {
    const res = await fetch(`/api/books/bank-rules/${r.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !r.active }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    void reload();
  }

  async function runPreview(id: string) {
    const res = await fetch(`/api/books/bank-rules/${id}/preview`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    setPreview(data as Preview);
  }

  return (
    <div className="space-y-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bank rules</h1>
          <p className="text-sm text-muted-foreground">
            Conditions → type / account suggestions on Needs Review lines
          </p>
        </div>
        <Link
          href="/books/transactions"
          className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted"
        >
          Transactions
        </Link>
      </div>

      <div className="grid max-w-2xl gap-3 rounded-lg border border-border p-3" data-testid="rules-create">
        <p className="text-sm font-medium">New rule</p>
        <div>
          <Label>Name</Label>
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} data-testid="rules-name" />
        </div>
        <div>
          <Label>Description contains</Label>
          <Input
            className="mt-1"
            value={contains}
            onChange={(e) => setContains(e.target.value)}
            data-testid="rules-contains"
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <div>
            <Label>Direction</Label>
            <Select
              value={direction || undefined}
              onValueChange={(v) => setDirection((v as "in" | "out") || "")}
            >
              <SelectTrigger className="mt-1 w-[140px]" data-testid="rules-direction">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="in">Money in</SelectItem>
                <SelectItem value="out">Money out</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Set type</Label>
            <Select value={setTxnType || undefined} onValueChange={(v) => setSetTxnType(v || "")}>
              <SelectTrigger className="mt-1 w-[180px]" data-testid="rules-set-type">
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
          </div>
        </div>
        <Button data-testid="rules-create-btn" onClick={() => void createRule()} disabled={!name.trim()}>
          Create rule
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm" data-testid="rules-table">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Set</th>
              <th className="px-3 py-2">Active</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rules.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  No rules yet — create one or use “Create rule from this” in Transactions.
                </td>
              </tr>
            ) : (
              rules.map((r) => (
                <tr key={r.id} className="border-t border-border" data-testid={`rules-row-${r.id}`}>
                  <td className="px-3 py-2 tabular-nums">{r.priority}</td>
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {[r.counterpartyContains && `contains “${r.counterpartyContains}”`, r.direction]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-2">
                    {r.setTxnType ? BANK_TXN_TYPE_LABEL[r.setTxnType as keyof typeof BANK_TXN_TYPE_LABEL] || r.setTxnType : "—"}
                  </td>
                  <td className="px-3 py-2">{r.active ? "Yes" : "No"}</td>
                  <td className="space-x-1 px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => void runPreview(r.id)} data-testid={`rules-preview-${r.id}`}>
                      Test
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void toggleActive(r)}>
                      {r.active ? "Disable" : "Enable"}
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {preview ? (
        <div className="rounded-lg border border-border p-3" data-testid="rules-preview-panel">
          <p className="text-sm font-medium">
            {preview.name}: {preview.matchCount} historical match{preview.matchCount === 1 ? "" : "es"}
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {preview.sample.map((s) => (
              <li key={s.id}>
                {s.description} · {s.amountMinor} fils
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
