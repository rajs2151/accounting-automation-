"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useBooksShell } from "@/components/books/books-shell-context";
import { CellAmount, CellDate } from "@/components/books/cells";
import { StatusBadge } from "@/components/books/status-badge";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiErrorMessage } from "@/lib/api-error";
import { displayToMinor, MoneyTypeError } from "@/lib/money";
import type { StatusLabel } from "@/lib/status-labels";

type Expense = {
  id: string;
  expenseNo: string;
  status: string;
  expenseDate: string;
  description: string;
  vendorName: string;
  paidFromKind: string | null;
  paidFromAccountCode: string | null;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  rejectionReason: string | null;
};

type Account = { id: string; code: string; name: string; accountType: string; isPostable: boolean };

const STATUS_META: Record<string, StatusLabel> = {
  draft: { label: "Draft", tone: "neutral" },
  pending: { label: "Pending approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
};

const PAID_FROM_OPTIONS = [
  { value: "bank", label: "Bank" },
  { value: "card", label: "Card" },
  { value: "petty_cash", label: "Petty cash" },
  { value: "employee_reimbursable", label: "Employee reimbursable" },
] as const;

type StatusTab = "all" | "draft" | "pending" | "approved" | "rejected";

export default function BooksExpensesPage() {
  const { periodId } = useBooksShell();
  const [rows, setRows] = useState<Expense[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<StatusTab>("all");
  const [q, setQ] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [expenseDate, setExpenseDate] = useState("2026-05-15");
  const [description, setDescription] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [paidFromKind, setPaidFromKind] = useState<string>("");
  const [paidFromAccountId, setPaidFromAccountId] = useState("");
  const [lineAccountId, setLineAccountId] = useState("");
  const [lineNet, setLineNet] = useState("100.00");
  const [lineVat, setLineVat] = useState("5.00");
  const [lineVatCode, setLineVatCode] = useState("SR");
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    const res = await fetch(`/api/books/expenses?${params}`);
    const data = await res.json().catch(() => []);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      setLoading(false);
      return;
    }
    setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [q]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void fetch("/api/books/accounts?postableOnly=1")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) return;
        setAccounts(data);
        const opex =
          data.find((a: Account) => a.code === "6600") ||
          data.find((a: Account) => a.accountType === "expense");
        const reimb = data.find((a: Account) => a.code === "2130");
        if (opex && !lineAccountId) setLineAccountId(String(opex.id));
        if (reimb && !paidFromAccountId) setPaidFromAccountId(String(reimb.id));
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed defaults once
  }, []);

  const counts = useMemo(() => {
    const by = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      all: rows.length,
      draft: by("draft"),
      pending: by("pending"),
      approved: by("approved"),
      rejected: by("rejected"),
    };
  }, [rows]);

  const visible = useMemo(
    () => (tab === "all" ? rows : rows.filter((r) => r.status === tab)),
    [rows, tab],
  );

  const expenseAccounts = useMemo(
    () =>
      accounts.filter(
        (a) => a.accountType === "expense" || a.code.startsWith("5") || a.code.startsWith("6"),
      ),
    [accounts],
  );

  const paidFromAccounts = useMemo(() => {
    if (paidFromKind === "employee_reimbursable") {
      return accounts.filter((a) => a.code === "2130");
    }
    if (paidFromKind === "petty_cash") {
      return accounts.filter((a) => a.code === "1110" || /petty/i.test(a.name));
    }
    if (paidFromKind === "card") {
      return accounts.filter((a) => a.code === "2150" || /card/i.test(a.name));
    }
    if (paidFromKind === "bank") {
      return accounts.filter((a) => a.code.startsWith("11") && a.code !== "1110");
    }
    return accounts;
  }, [accounts, paidFromKind]);

  async function createDraft() {
    if (!periodId) {
      toast.error("Select an open period in the top bar");
      return;
    }
    let netMinor: number;
    let vatMinor: number;
    try {
      netMinor = displayToMinor(lineNet) ?? 0;
      vatMinor = displayToMinor(lineVat) ?? 0;
    } catch (e) {
      toast.error(e instanceof MoneyTypeError ? "Invalid amount" : "Invalid amount");
      return;
    }
    if (!lineAccountId) {
      toast.error("Pick a debit account");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/books/expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expenseDate,
        periodId,
        description,
        vendorName,
        paidFromKind: paidFromKind || null,
        paidFromAccountId: paidFromAccountId || null,
        lines: [
          {
            description,
            accountId: lineAccountId,
            vatCode: vatMinor > 0 ? lineVatCode || "SR" : null,
            netMinor,
            vatMinor,
          },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success(`Draft ${data.expenseNo || "expense"} saved`);
    setFormOpen(false);
    setDescription("");
    setVendorName("");
    setLineNet("100.00");
    setLineVat("5.00");
    void reload();
  }

  async function deleteDraft(id: string) {
    const res = await fetch(`/api/books/expenses/${id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Draft deleted");
    void reload();
  }

  return (
    <div className="space-y-4 py-4" data-testid="expenses-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Expenses</h1>
          <p className="text-sm text-muted-foreground">
            Staff claims — draft now; approve &amp; post in the next slice
          </p>
        </div>
        <Button data-testid="expenses-new" onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? "Cancel" : "New expense"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-xs"
          placeholder="Search description, vendor, EXP #"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="expenses-search"
        />
        <Tabs value={tab} onValueChange={(v) => setTab(v as StatusTab)}>
          <TabsList data-testid="expenses-tabs">
            <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
            <TabsTrigger value="draft">Draft ({counts.draft})</TabsTrigger>
            <TabsTrigger value="pending">Pending ({counts.pending})</TabsTrigger>
            <TabsTrigger value="approved">Approved ({counts.approved})</TabsTrigger>
            <TabsTrigger value="rejected">Rejected ({counts.rejected})</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {formOpen ? (
        <div className="grid max-w-2xl gap-3 rounded-lg border border-border p-4" data-testid="expenses-create">
          <p className="text-sm font-medium">New expense draft</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Date</Label>
              <Input
                className="mt-1"
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
                data-testid="expenses-date"
              />
            </div>
            <div>
              <Label>Vendor</Label>
              <Input
                className="mt-1"
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                data-testid="expenses-vendor"
              />
            </div>
          </div>
          <div>
            <Label>Description</Label>
            <Input
              className="mt-1"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="expenses-description"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Debit account</Label>
              <Select value={lineAccountId || undefined} onValueChange={(v) => setLineAccountId(v ?? "")}>
                <SelectTrigger className="mt-1" data-testid="expenses-debit-account">
                  <SelectValue placeholder="Account" />
                </SelectTrigger>
                <SelectContent>
                  {expenseAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Paid from</Label>
              <Select
                value={paidFromKind || undefined}
                onValueChange={(v) => {
                  const next = v ?? "";
                  setPaidFromKind(next);
                  if (next === "employee_reimbursable") {
                    const reimb = accounts.find((a) => a.code === "2130");
                    if (reimb) setPaidFromAccountId(reimb.id);
                  }
                }}
              >
                <SelectTrigger className="mt-1" data-testid="expenses-paid-from-kind">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  {PAID_FROM_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {paidFromKind ? (
            <div>
              <Label>Paid-from account</Label>
              <Select
                value={paidFromAccountId || undefined}
                onValueChange={(v) => setPaidFromAccountId(v ?? "")}
              >
                <SelectTrigger className="mt-1" data-testid="expenses-paid-from-account">
                  <SelectValue placeholder="Account" />
                </SelectTrigger>
                <SelectContent>
                  {paidFromAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Net (AED)</Label>
              <Input
                className="mt-1"
                value={lineNet}
                onChange={(e) => setLineNet(e.target.value)}
                data-testid="expenses-net"
              />
            </div>
            <div>
              <Label>VAT (AED)</Label>
              <Input
                className="mt-1"
                value={lineVat}
                onChange={(e) => setLineVat(e.target.value)}
                data-testid="expenses-vat"
              />
            </div>
            <div>
              <Label>VAT code</Label>
              <Input
                className="mt-1"
                value={lineVatCode}
                onChange={(e) => setLineVatCode(e.target.value)}
                data-testid="expenses-vat-code"
              />
            </div>
          </div>
          <Button data-testid="expenses-save" disabled={saving} onClick={() => void createDraft()}>
            {saving ? "Saving…" : "Save draft"}
          </Button>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm" data-testid="expenses-table">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Expense #</th>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Description · Vendor</th>
              <th className="px-3 py-2 font-medium text-right">Amount</th>
              <th className="px-3 py-2 font-medium">Paid from</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-muted-foreground">
                  No expenses yet. Create a draft to get an EXP-YYYY-#### number.
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr
                  key={r.id}
                  className={
                    r.status === "rejected"
                      ? "border-b bg-red-50/60 dark:bg-red-950/20"
                      : "border-b last:border-0"
                  }
                  data-testid={`expense-row-${r.expenseNo}`}
                >
                  <td className="px-3 py-2 font-mono text-xs">{r.expenseNo}</td>
                  <td className="px-3 py-2">
                    <CellDate value={r.expenseDate} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.description || "—"}</div>
                    <div className="text-xs text-muted-foreground">{r.vendorName || "—"}</div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <CellAmount minor={r.grossMinor} />
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.paidFromAccountCode || r.paidFromKind || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge meta={STATUS_META[r.status] || STATUS_META.draft} />
                    {r.rejectionReason ? (
                      <div className="mt-0.5 text-xs text-red-700">{r.rejectionReason}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.status === "draft" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`expense-delete-${r.id}`}
                        onClick={() => void deleteDraft(r.id)}
                      >
                        Delete
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
