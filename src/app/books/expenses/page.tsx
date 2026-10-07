"use client";

import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import { toast } from "sonner";

import { useBooksShell } from "@/components/books/books-shell-context";
import { CellAmount, CellDate } from "@/components/books/cells";
import { BooksSideDrawer } from "@/components/books/side-drawer";
import { StatusBadge } from "@/components/books/status-badge";
import { rowOpenProps } from "@/components/books/table-peek";
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
import { displayToMinor, formatMinor, MoneyTypeError } from "@/lib/money";
import type { StatusLabel } from "@/lib/status-labels";

type Expense = {
  id: string;
  expenseNo: string;
  status: string;
  expenseDate: string;
  description: string;
  vendorName: string;
  vendorPartyId?: string | null;
  vendorTrn?: string | null;
  paidFromKind: string | null;
  paidFromAccountCode: string | null;
  paidFromAccountName?: string | null;
  bankTxnId: string | null;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  rejectionReason: string | null;
  createdBy?: string;
  submittedBy?: string | null;
  entryNo?: string | null;
  lines?: Array<{
    id: string;
    description: string;
    accountCode: string | null;
    accountName: string | null;
    vatCode: string | null;
    netMinor: number;
    vatMinor: number;
    grossMinor: number;
  }>;
};

type Supplier = { id: string; name: string; trn: string | null };

type Me = { id: string; role: string } | null;

type BankCandidate = {
  id: string;
  txnDate: string | null;
  description: string;
  debitMinor: number;
  accountCode: string | null;
  reviewStatus: string;
};

type Account = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  isPostable: boolean;
  isBank?: boolean;
};

const NO_TRN_VAT_WARNING =
  "VAT will be added to the expense because the supplier has no TRN — choose a supplier with a TRN to recover it.";

const STATUS_META: Record<string, StatusLabel> = {
  draft: { label: "Draft", tone: "neutral" },
  pending: { label: "Pending approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
};

const PAID_FROM_OPTIONS = [
  { value: "bank", label: "Bank" },
  { value: "card", label: "Company card" },
  { value: "petty_cash", label: "Petty cash" },
  { value: "employee_reimbursable", label: "Employee (reimbursable)" },
] as const;

function paidFromLabel(kind: string | null | undefined): string {
  return PAID_FROM_OPTIONS.find((o) => o.value === kind)?.label || "—";
}

function accountLabel(a: Pick<Account, "code" | "name"> | undefined | null): string {
  return a ? `${a.code} · ${a.name}` : "";
}

/** Same defaults as the server (expenses.ts PAID_FROM_DEFAULT_CODES). */
function defaultPaidFromAccount(accounts: Account[], kind: string): Account | undefined {
  if (kind === "petty_cash") return accounts.find((a) => a.code === "1110");
  if (kind === "employee_reimbursable") return accounts.find((a) => a.code === "2130");
  if (kind === "card") return accounts.find((a) => a.code === "2150");
  if (kind === "bank") {
    return accounts.find((a) => a.accountType === "asset" && a.isBank && a.code !== "1110");
  }
  return undefined;
}

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
  // An expense must be dated inside its period: keep the date in the selected period (today if it
  // falls there, otherwise the period's last day).
  useEffect(() => {
    if (!periodId) return;
    let cancelled = false;
    fetch("/api/books/periods")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Array<{ id: string; periodStart?: string; periodEnd?: string }>) => {
        const p = Array.isArray(list) ? list.find((x) => x.id === periodId) : undefined;
        if (cancelled || !p?.periodStart || !p.periodEnd) return;
        const start = String(p.periodStart).slice(0, 10);
        const end = String(p.periodEnd).slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        const inPeriod = (d: string) => d >= start && d <= end;
        setExpenseDate((cur) => (inPeriod(cur) ? cur : inPeriod(today) ? today : end));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [periodId]);
  const [description, setDescription] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorPartyId, setVendorPartyId] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [me, setMe] = useState<Me>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openDetail, setOpenDetail] = useState<Expense | null>(null);
  const [paidFromKind, setPaidFromKind] = useState<string>("");
  const [paidFromAccountId, setPaidFromAccountId] = useState("");
  const [lineAccountId, setLineAccountId] = useState("");
  const [lineNet, setLineNet] = useState("100.00");
  const [lineVat, setLineVat] = useState("5.00");
  const [lineVatCode, setLineVatCode] = useState("SR");
  const [saving, setSaving] = useState(false);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);
  const [matchFor, setMatchFor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<BankCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);

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
        if (opex && !lineAccountId) setLineAccountId(String(opex.id));
        // The paid-from account is set when the user picks "Paid from" (no silent 2130 default).
      })
      .catch(() => undefined);
    void fetch("/api/books/parties?partyType=supplier")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setSuppliers(data);
      })
      .catch(() => undefined);
    void fetch("/api/session")
      .then((r) => r.json())
      .then((data) => {
        if (data?.me?.id) setMe({ id: String(data.me.id), role: String(data.me.role || "") });
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed defaults once
  }, []);

  useEffect(() => {
    if (!openId) {
      setOpenDetail(null);
      return;
    }
    let cancelled = false;
    void fetch(`/api/books/expenses/${openId}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return;
        if (!ok) {
          toast.error(apiErrorMessage(d));
          return;
        }
        setOpenDetail(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [openId]);

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
      return accounts.filter(
        (a) => a.accountType === "asset" && (a.isBank ?? a.code.startsWith("11")) && a.code !== "1110",
      );
    }
    return accounts;
  }, [accounts, paidFromKind]);

  const selectedSupplier = suppliers.find((s) => s.id === vendorPartyId);
  const formVatNotRecoverable = (() => {
    try {
      return (displayToMinor(lineVat) ?? 0) > 0 && !selectedSupplier?.trn;
    } catch {
      return false;
    }
  })();

  /** Why the current user can't approve/reject this expense (null = they can). */
  function approveBlockedReason(r: Expense): string | null {
    if (!me) return null;
    if (me.role !== "admin" && me.role !== "approver") return "Only an approver or admin can approve";
    if (r.createdBy === me.id || r.submittedBy === me.id) {
      return "You prepared this expense, so someone else must approve it";
    }
    return null;
  }

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
    if (!paidFromKind || !paidFromAccountId) {
      toast.error("Choose what the expense was paid from");
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
        vendorName: selectedSupplier ? selectedSupplier.name : vendorName,
        vendorPartyId: vendorPartyId || null,
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
    setVendorPartyId("");
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

  async function act(id: string, action: "submit" | "approve" | "reject" | "resubmit") {
    setActing(`${action}:${id}`);
    const body =
      action === "reject" ? { reason: rejectReason[id] || "" } : undefined;
    const res = await fetch(`/api/books/expenses/${id}/${action}`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    setActing(null);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success(
      action === "submit"
        ? "Submitted for approval"
        : action === "approve"
          ? `Approved${data.entryNo ? ` · ${data.entryNo}` : ""}`
          : action === "reject"
            ? "Rejected"
            : "Resubmitted",
    );
    void reload();
  }

  async function openMatch(id: string) {
    if (matchFor === id) {
      setMatchFor(null);
      setCandidates([]);
      return;
    }
    setMatchFor(id);
    setCandidatesLoading(true);
    const res = await fetch(`/api/books/expenses/${id}/bank-candidates`);
    const data = await res.json().catch(() => []);
    setCandidatesLoading(false);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    setCandidates(Array.isArray(data) ? data : []);
  }

  async function linkBank(expenseId: string, bankTxnId: string | null, approved: boolean) {
    setActing(`link:${expenseId}`);
    const path = approved
      ? `/api/books/expenses/${expenseId}/match-bank`
      : `/api/books/expenses/${expenseId}/link-bank`;
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bankTxnId }),
    });
    const data = await res.json().catch(() => ({}));
    setActing(null);
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success(bankTxnId ? "Bank line linked" : "Bank link cleared");
    setMatchFor(null);
    setCandidates([]);
    void reload();
  }

  function canMatchBank(r: Expense) {
    return (
      (r.paidFromKind === "bank" || r.paidFromKind === "card") &&
      (["draft", "pending", "rejected"].includes(r.status) ||
        (r.status === "approved" && !r.bankTxnId))
    );
  }

  return (
    <div className="space-y-4 py-4" data-testid="expenses-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Expenses</h1>
          <p className="text-sm text-muted-foreground">
            Staff claims — link bank/card outflows so approve does not double-post the payment
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
            <div className="min-w-0">
              <Label>Date</Label>
              <Input
                className="mt-1"
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
                data-testid="expenses-date"
              />
            </div>
            <div className="min-w-0">
              <Label>Supplier</Label>
              <Select
                value={vendorPartyId || "__free__"}
                onValueChange={(v) => setVendorPartyId(!v || v === "__free__" ? "" : String(v))}
              >
                <SelectTrigger className="mt-1 w-full" data-testid="expenses-supplier">
                  <SelectValue>
                    {(v: string | null) =>
                      !v || v === "__free__"
                        ? "Other (type a name)"
                        : suppliers.find((s) => s.id === v)?.name || "Supplier"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__free__">Other (type a name)</SelectItem>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                      {s.trn ? ` · TRN ${s.trn}` : " · no TRN"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!vendorPartyId ? (
                <Input
                  className="mt-2"
                  placeholder="Vendor name"
                  value={vendorName}
                  onChange={(e) => setVendorName(e.target.value)}
                  data-testid="expenses-vendor"
                />
              ) : null}
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
            <div className="min-w-0">
              <Label>Debit account</Label>
              <Select value={lineAccountId || undefined} onValueChange={(v) => setLineAccountId(v ?? "")}>
                <SelectTrigger className="mt-1 w-full" data-testid="expenses-debit-account">
                  <SelectValue placeholder="Account">
                    {(v: string | null) =>
                      accountLabel(accounts.find((a) => a.id === v)) || "Account"
                    }
                  </SelectValue>
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
            <div className="min-w-0">
              <Label>Paid from</Label>
              <Select
                value={paidFromKind || undefined}
                onValueChange={(v) => {
                  const next = v ?? "";
                  setPaidFromKind(next);
                  // Each source has its own default account (petty cash → 1110, employee → 2130,
                  // card → 2150, bank → the first bank account).
                  setPaidFromAccountId(defaultPaidFromAccount(accounts, next)?.id || "");
                }}
              >
                <SelectTrigger className="mt-1 w-full" data-testid="expenses-paid-from-kind">
                  <SelectValue placeholder="Choose source">
                    {(v: string | null) => (v ? paidFromLabel(v) : "Choose source")}
                  </SelectValue>
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
            <div className="min-w-0">
              <Label>Paid-from account</Label>
              <Select
                value={paidFromAccountId || undefined}
                onValueChange={(v) => setPaidFromAccountId(v ?? "")}
              >
                <SelectTrigger className="mt-1 w-full" data-testid="expenses-paid-from-account">
                  <SelectValue placeholder="Account">
                    {(v: string | null) =>
                      accountLabel(accounts.find((a) => a.id === v)) || "Account"
                    }
                  </SelectValue>
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
          {formVatNotRecoverable ? (
            <p
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              data-testid="expenses-vat-no-trn"
            >
              {NO_TRN_VAT_WARNING}
            </p>
          ) : null}
          <Button
            data-testid="expenses-save"
            disabled={saving || !paidFromKind || !paidFromAccountId}
            title={!paidFromKind ? "Choose what the expense was paid from" : undefined}
            onClick={() => void createDraft()}
          >
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
                <Fragment key={r.id}>
                <tr
                  className={
                    r.status === "rejected"
                      ? "border-b bg-red-50/60 dark:bg-red-950/20"
                      : "border-b last:border-0"
                  }
                  data-testid={`expense-row-${r.expenseNo}`}
                  {...rowOpenProps(() => setOpenId(r.id))}
                >
                  <td className="px-3 py-2 font-mono text-xs">{r.expenseNo}</td>
                  <td className="px-3 py-2">
                    <CellDate value={r.expenseDate} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.description || "—"}</div>
                    <div className="text-xs text-muted-foreground">{r.vendorName || "—"}</div>
                    {r.vatMinor > 0 && !r.vendorTrn ? (
                      <div className="text-[11px] text-amber-700" title={NO_TRN_VAT_WARNING}>
                        VAT not recoverable (no supplier TRN)
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <CellAmount minor={r.grossMinor} />
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    <div>{paidFromLabel(r.paidFromKind)}</div>
                    {r.paidFromAccountCode ? (
                      <div className="text-[11px]">
                        {r.paidFromAccountCode}
                        {r.paidFromAccountName ? ` · ${r.paidFromAccountName}` : ""}
                      </div>
                    ) : null}
                    {r.bankTxnId ? (
                      <div className="text-[11px] text-emerald-700" data-testid={`expense-matched-${r.id}`}>
                        Matched to bank
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge meta={STATUS_META[r.status] || STATUS_META.draft} />
                    {r.rejectionReason ? (
                      <div className="mt-0.5 text-xs text-red-700">{r.rejectionReason}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {canMatchBank(r) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid={`expense-match-${r.id}`}
                          onClick={() => void openMatch(r.id)}
                        >
                          {matchFor === r.id ? "Hide" : r.bankTxnId ? "Change bank" : "Match bank"}
                        </Button>
                      ) : null}
                      {r.status === "draft" ? (
                        <>
                          <Button
                            size="sm"
                            data-testid={`expense-submit-${r.id}`}
                            disabled={acting === `submit:${r.id}`}
                            onClick={() => void act(r.id, "submit")}
                          >
                            Submit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid={`expense-delete-${r.id}`}
                            onClick={() => void deleteDraft(r.id)}
                          >
                            Delete
                          </Button>
                        </>
                      ) : null}
                      {r.status === "pending" && approveBlockedReason(r) ? (
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid={`expense-approve-blocked-${r.id}`}
                        >
                          {approveBlockedReason(r)}
                        </span>
                      ) : null}
                      {r.status === "pending" && !approveBlockedReason(r) ? (
                        <>
                          <Button
                            size="sm"
                            data-testid={`expense-approve-${r.id}`}
                            disabled={acting === `approve:${r.id}`}
                            onClick={() => void act(r.id, "approve")}
                          >
                            Approve
                          </Button>
                          <Input
                            className="h-8 w-36"
                            placeholder="Reject reason"
                            value={rejectReason[r.id] || ""}
                            onChange={(e) =>
                              setRejectReason((m) => ({ ...m, [r.id]: e.target.value }))
                            }
                            data-testid={`expense-reject-reason-${r.id}`}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid={`expense-reject-${r.id}`}
                            disabled={acting === `reject:${r.id}`}
                            onClick={() => void act(r.id, "reject")}
                          >
                            Reject
                          </Button>
                        </>
                      ) : null}
                      {r.status === "rejected" ? (
                        <Button
                          size="sm"
                          data-testid={`expense-resubmit-${r.id}`}
                          disabled={acting === `resubmit:${r.id}`}
                          onClick={() => void act(r.id, "resubmit")}
                        >
                          Resubmit
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
                {matchFor === r.id ? (
                  <tr className="border-b bg-muted/30" data-testid={`expense-candidates-${r.id}`}>
                    <td colSpan={7} className="px-3 py-3">
                      {candidatesLoading ? (
                        <p className="text-sm text-muted-foreground">Loading candidates…</p>
                      ) : candidates.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No matching bank outflows (same account, amount, ±14 days).
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {candidates.map((c) => (
                            <li
                              key={c.id}
                              className="flex flex-wrap items-center justify-between gap-2 text-sm"
                            >
                              <span>
                                {c.txnDate || "—"} · {c.accountCode} · {c.description || "(no desc)"} ·{" "}
                                {formatMinor(c.debitMinor)} AED
                              </span>
                              <Button
                                size="sm"
                                data-testid={`expense-pick-bank-${c.id}`}
                                disabled={acting === `link:${r.id}`}
                                onClick={() =>
                                  void linkBank(r.id, c.id, r.status === "approved")
                                }
                              >
                                Use this line
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {r.bankTxnId && r.status !== "approved" ? (
                        <Button
                          className="mt-2"
                          variant="ghost"
                          size="sm"
                          onClick={() => void linkBank(r.id, null, false)}
                        >
                          Clear link
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      <BooksSideDrawer
        open={Boolean(openId)}
        onOpenChange={(o) => {
          if (!o) setOpenId(null);
        }}
        title="Expense"
        entryNo={openDetail?.expenseNo || rows.find((x) => x.id === openId)?.expenseNo}
        status={openDetail?.status}
      >
        {openDetail ? (
          <div className="space-y-4 p-4 text-sm" data-testid="expense-detail">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
              <dt className="text-muted-foreground">Date</dt>
              <dd>
                <CellDate value={openDetail.expenseDate} />
              </dd>
              <dt className="text-muted-foreground">Description</dt>
              <dd>{openDetail.description || "—"}</dd>
              <dt className="text-muted-foreground">Supplier</dt>
              <dd>
                {openDetail.vendorName || "—"}
                {openDetail.vendorTrn ? (
                  <span className="text-xs text-muted-foreground"> · TRN {openDetail.vendorTrn}</span>
                ) : null}
              </dd>
              <dt className="text-muted-foreground">Paid from</dt>
              <dd>
                {paidFromLabel(openDetail.paidFromKind)}
                {openDetail.paidFromAccountCode
                  ? ` · ${openDetail.paidFromAccountCode}${openDetail.paidFromAccountName ? ` ${openDetail.paidFromAccountName}` : ""}`
                  : ""}
              </dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <StatusBadge meta={STATUS_META[openDetail.status] || STATUS_META.draft} />
              </dd>
              {openDetail.rejectionReason ? (
                <>
                  <dt className="text-muted-foreground">Rejected because</dt>
                  <dd className="text-red-700">{openDetail.rejectionReason}</dd>
                </>
              ) : null}
            </dl>
            {openDetail.vatMinor > 0 && !openDetail.vendorTrn ? (
              <p
                className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
                data-testid="expense-detail-vat-no-trn"
              >
                {NO_TRN_VAT_WARNING}
              </p>
            ) : null}
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Account</th>
                  <th className="py-1 font-medium">VAT</th>
                  <th className="py-1 text-right font-medium">Net</th>
                  <th className="py-1 text-right font-medium">VAT amt</th>
                  <th className="py-1 text-right font-medium">Gross</th>
                </tr>
              </thead>
              <tbody>
                {(openDetail.lines || []).map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="py-1">
                      {l.accountCode} · {l.accountName}
                      {l.description ? (
                        <div className="text-xs text-muted-foreground">{l.description}</div>
                      ) : null}
                    </td>
                    <td className="py-1">{l.vatCode || "—"}</td>
                    <td className="py-1 text-right">
                      <CellAmount minor={l.netMinor} />
                    </td>
                    <td className="py-1 text-right">
                      <CellAmount minor={l.vatMinor} />
                    </td>
                    <td className="py-1 text-right">
                      <CellAmount minor={l.grossMinor} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {openDetail.status === "pending" && approveBlockedReason(openDetail) ? (
              <p className="text-xs text-muted-foreground">{approveBlockedReason(openDetail)}</p>
            ) : null}
          </div>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        )}
      </BooksSideDrawer>
    </div>
  );
}
