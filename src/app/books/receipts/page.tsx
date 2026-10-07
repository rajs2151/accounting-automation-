"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { BooksDateInput } from "@/components/books/date-input";
import { useBooksShell } from "@/components/books/books-shell-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";
import { parseFxRateToScaled } from "@/lib/fx";
import { displayToMinor, formatMinor } from "@/lib/money";

type DocType = "receipt" | "payment";
type Party = { id: string; name: string };
type OpenItem = {
  id: string;
  partyId: string;
  currency: string;
  status: string;
  openOriginalMinor: number;
  documentNumber: string | null;
  dueDate: string | null;
};
type BankAccount = { id: string; code: string; name: string };
type Draft = {
  id: string;
  docType: DocType;
  issueDate: string;
  currency: string;
  originalAmountMinor: number;
  partyName: string | null;
  bankAccountCode: string | null;
  bankAccountName: string | null;
  createdBy: string;
  createdByName: string | null;
  allocationCount: number;
  allocatedMinor: number;
  remainderMinor: number;
  remainderKind: string | null;
  canPost: boolean;
};

function readUserCookie(): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(/(?:^|;\s*)daftar_user=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "";
}

/** Parse a typed amount to fils; null when empty, NaN when not a valid amount. */
function toMinor(text: string): number | null {
  try {
    return displayToMinor(text);
  } catch {
    return Number.NaN;
  }
}

function sumTyped(values: string[]): number {
  return values.reduce((sum, t) => {
    const v = toMinor(t);
    return sum + (v && Number.isFinite(v) ? v : 0);
  }, 0);
}

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export default function ReceiptsPage() {
  const { periodId } = useBooksShell();
  const [docType, setDocType] = useState<DocType>("receipt");
  const [parties, setParties] = useState<Party[]>([]);
  const [openItems, setOpenItems] = useState<OpenItem[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [partyId, setPartyId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amountText, setAmountText] = useState("");
  const [currency, setCurrency] = useState("AED");
  const [rateText, setRateText] = useState("1");
  const [memo, setMemo] = useState("");
  const [remainderKind, setRemainderKind] = useState<"advance" | "on_account">("advance");
  /** openItemId → typed allocation amount (only ticked items are present). */
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // A ref, not just state: a double click fires twice before React re-renders the disabled button.
  const savingRef = useRef(false);
  const requestIdRef = useRef(newRequestId());
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);
  const busyDraftsRef = useRef<Set<string>>(new Set());
  const me = useMemo(() => readUserCookie(), []);

  const side = docType === "receipt" ? "AR" : "AP";
  const partyType = docType === "receipt" ? "customer" : "supplier";

  const loadDrafts = useCallback(async () => {
    try {
      const res = await fetch("/api/books/settlements/drafts");
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setDrafts(data);
    } catch {
      /* keep the current list */
    }
  }, []);

  const loadOpenItems = useCallback(async () => {
    try {
      const res = await fetch(`/api/books/open-items?side=${side}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) {
        // Open and part-paid items both still have something to settle.
        setOpenItems(
          data.filter((o: OpenItem) => o.status !== "closed" && Number(o.openOriginalMinor) > 0),
        );
      }
    } catch {
      setOpenItems([]);
    }
  }, [side]);

  // Parties and open items follow the receipt / payment choice.
  useEffect(() => {
    let cancelled = false;
    setAlloc({});
    void (async () => {
      try {
        const res = await fetch(`/api/books/parties?partyType=${partyType}`);
        const data = await res.json();
        if (cancelled) return;
        const list: Party[] = res.ok && Array.isArray(data) ? data : [];
        setParties(list);
        setPartyId((cur) => (list.some((p) => p.id === cur) ? cur : list[0]?.id || ""));
      } catch {
        if (!cancelled) setParties([]);
      }
    })();
    void loadOpenItems();
    return () => {
      cancelled = true;
    };
  }, [partyType, loadOpenItems]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/books/accounts?postableOnly=1");
        const data = await res.json();
        if (res.ok && Array.isArray(data)) {
          const banks = data.filter((x: BankAccount) => x.code.startsWith("112"));
          setAccounts(banks);
          setBankAccountId((cur) => cur || banks[0]?.id || "");
        }
      } catch {
        setAccounts([]);
      }
    })();
    void loadDrafts();
  }, [loadDrafts]);

  // Keep the date inside the selected period: today if it falls there, otherwise the period end.
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
        setIssueDate((cur) => (inPeriod(cur) ? cur : inPeriod(today) ? today : end));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [periodId]);

  const partyItems = useMemo(
    () =>
      openItems.filter(
        (o) => o.partyId === partyId && String(o.currency).toUpperCase() === currency,
      ),
    [openItems, partyId, currency],
  );

  const amountMinor = toMinor(amountText);
  const amountValid =
    amountMinor != null && Number.isFinite(amountMinor) && (amountMinor as number) > 0;
  const allocatedMinor = sumTyped(Object.values(alloc));
  const remainderMinor = amountValid ? (amountMinor as number) - allocatedMinor : 0;

  const allocError = (() => {
    for (const [id, text] of Object.entries(alloc)) {
      const v = toMinor(text);
      const item = partyItems.find((o) => o.id === id);
      if (v == null || !Number.isFinite(v) || v <= 0) return "Enter an amount for each ticked item.";
      if (item && v > Number(item.openOriginalMinor)) {
        return "An allocation is more than that item's open amount.";
      }
    }
    if (amountValid && remainderMinor < 0) return "The allocations add up to more than the amount.";
    return null;
  })();

  function toggleItem(item: OpenItem) {
    setAlloc((cur) => {
      if (cur[item.id] !== undefined) {
        const next = { ...cur };
        delete next[item.id];
        return next;
      }
      const open = Number(item.openOriginalMinor);
      const left = amountValid ? Math.max(0, (amountMinor as number) - sumTyped(Object.values(cur))) : open;
      const suggested = Math.min(open, left);
      return { ...cur, [item.id]: suggested > 0 ? formatMinor(suggested) : "" };
    });
  }

  function resetForm() {
    setAmountText("");
    setMemo("");
    setAlloc({});
    setRemainderKind("advance");
    requestIdRef.current = newRequestId();
  }

  async function record() {
    if (savingRef.current) return;
    if (!partyId) {
      toast.error(docType === "receipt" ? "Choose a customer." : "Choose a supplier.");
      return;
    }
    if (!bankAccountId) {
      toast.error("Choose a bank account.");
      return;
    }
    if (!amountValid) {
      toast.error("Enter an amount greater than zero.");
      return;
    }
    if (allocError) {
      toast.error(allocError);
      return;
    }
    let fxRateScaled = 100000000;
    if (currency !== "AED") {
      try {
        fxRateScaled = Number(parseFxRateToScaled(rateText));
      } catch {
        toast.error("Enter a valid exchange rate.");
        return;
      }
    }
    const allocations = Object.entries(alloc).map(([openItemId, text]) => ({
      openItemId,
      allocatedOriginalMinor: toMinor(text) as number,
    }));

    savingRef.current = true;
    setSaving(true);
    try {
      const res = await fetch("/api/books/settlements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: requestIdRef.current || undefined,
          docType,
          partyId,
          issueDate,
          periodId,
          bankAccountId,
          currency,
          fxRateScaled,
          originalAmountMinor: amountMinor,
          memo: memo.trim() || undefined,
          allocations,
          remainderKind: remainderMinor > 0 ? remainderKind : undefined,
          remainderOriginalMinor: remainderMinor > 0 ? remainderMinor : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(apiErrorMessage(data));
        return;
      }
      toast.success(
        `${docType === "receipt" ? "Receipt" : "Payment"} recorded. Another approver can now post it.`,
      );
      resetForm();
      await loadDrafts();
    } catch {
      toast.error(apiErrorMessage(null));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function draftAction(id: string, action: "post" | "discard") {
    if (busyDraftsRef.current.has(id)) return;
    busyDraftsRef.current.add(id);
    setBusyDraftId(id);
    try {
      const res =
        action === "post"
          ? await fetch(`/api/books/settlements/${id}/post`, { method: "POST" })
          : await fetch(`/api/books/settlements/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(apiErrorMessage(data));
      else toast.success(action === "post" ? `Posted ${data.entryNo}` : "Draft discarded");
      await Promise.all([loadDrafts(), loadOpenItems()]);
    } catch {
      toast.error(apiErrorMessage(null));
    } finally {
      busyDraftsRef.current.delete(id);
      setBusyDraftId(null);
    }
  }

  const noun = docType === "receipt" ? "receipt" : "payment";

  return (
    <div className="space-y-4 py-4" data-testid="receipts-page">
      <h1 className="text-2xl font-semibold">Receipts & payments</h1>
      <p className="text-sm text-muted-foreground">
        Record money received from a customer or paid to a supplier and match it to open invoices or
        bills. Anything left over is kept as an advance. Someone else with approval rights then posts it.
      </p>

      <div className="flex gap-2">
        <Button
          variant={docType === "receipt" ? "default" : "outline"}
          onClick={() => setDocType("receipt")}
          data-testid="mode-receipt"
        >
          Receipt from customer
        </Button>
        <Button
          variant={docType === "payment" ? "default" : "outline"}
          onClick={() => setDocType("payment")}
          data-testid="mode-payment"
        >
          Payment to supplier
        </Button>
      </div>

      <div className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3">
        <div>
          <Label>{docType === "receipt" ? "Customer" : "Supplier"}</Label>
          <select
            className={selectClass}
            value={partyId}
            onChange={(e) => {
              setPartyId(e.target.value);
              setAlloc({});
            }}
            data-testid="receipt-party"
          >
            {parties.length === 0 ? (
              <option value="">{docType === "receipt" ? "No customers yet" : "No suppliers yet"}</option>
            ) : null}
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Bank account</Label>
          <select
            className={selectClass}
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Date</Label>
          <BooksDateInput
            value={issueDate}
            onChange={(iso) => setIssueDate(iso)}
            data-testid="receipt-issue-date"
          />
        </div>
        <div>
          <Label>Amount ({currency})</Label>
          <Input
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            data-testid="receipt-amount"
          />
        </div>
        <div>
          <Label>Currency</Label>
          <Input
            value={currency}
            maxLength={3}
            onChange={(e) => {
              setCurrency(e.target.value.toUpperCase());
              setAlloc({});
            }}
          />
        </div>
        {currency !== "AED" ? (
          <div>
            <Label>Rate (AED per 1 {currency})</Label>
            <Input value={rateText} onChange={(e) => setRateText(e.target.value)} inputMode="decimal" />
          </div>
        ) : (
          <div />
        )}
        <div className="md:col-span-3">
          <Label>Memo (optional)</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>

        <div className="md:col-span-3">
          <Label>Match to open {docType === "receipt" ? "invoices" : "bills"}</Label>
          {partyItems.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Nothing open for this {docType === "receipt" ? "customer" : "supplier"} in {currency}. The
              full amount will be kept as an advance.
            </p>
          ) : (
            <table className="mt-1 w-full text-sm" data-testid="receipt-open-items">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="w-8" />
                  <th>Document</th>
                  <th>Due</th>
                  <th className="text-right">Open</th>
                  <th className="w-40 text-right">Allocate</th>
                </tr>
              </thead>
              <tbody>
                {partyItems.map((o) => {
                  const ticked = alloc[o.id] !== undefined;
                  const label = o.documentNumber || o.id.slice(0, 8);
                  return (
                    <tr key={o.id} className="border-t border-border">
                      <td>
                        <input
                          type="checkbox"
                          checked={ticked}
                          onChange={() => toggleItem(o)}
                          aria-label={`Allocate to ${label}`}
                        />
                      </td>
                      <td>
                        {label}
                        {o.status === "partial" ? (
                          <span className="ml-2 text-xs text-muted-foreground">part-paid</span>
                        ) : null}
                      </td>
                      <td>{o.dueDate ? String(o.dueDate).slice(0, 10) : ""}</td>
                      <td className="text-right tabular-nums">
                        {formatMinor(Number(o.openOriginalMinor))}
                      </td>
                      <td className="text-right">
                        {ticked ? (
                          <Input
                            className="h-8 text-right"
                            value={alloc[o.id]}
                            inputMode="decimal"
                            aria-label={`Amount for ${label}`}
                            onChange={(e) => setAlloc((cur) => ({ ...cur, [o.id]: e.target.value }))}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="space-y-1 text-sm md:col-span-3">
          <div>
            Matched: <span className="tabular-nums">{formatMinor(allocatedMinor)}</span>
            {amountValid ? (
              <>
                {" · Left over: "}
                <span className="tabular-nums" data-testid="receipt-remainder">
                  {formatMinor(Math.max(0, remainderMinor))}
                </span>
              </>
            ) : null}
          </div>
          {amountValid && remainderMinor > 0 ? (
            <div className="flex items-center gap-2">
              <span>Keep the amount left over as</span>
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                value={remainderKind}
                onChange={(e) => setRemainderKind(e.target.value as "advance" | "on_account")}
              >
                <option value="advance">
                  {docType === "receipt" ? "Customer advance" : "Supplier advance (prepaid)"}
                </option>
                <option value="on_account">On account</option>
              </select>
            </div>
          ) : null}
          {allocError ? <p className="text-destructive">{allocError}</p> : null}
        </div>

        <div className="flex items-end gap-2 md:col-span-3">
          <Button
            onClick={() => void record()}
            disabled={saving || Boolean(allocError)}
            data-testid="receipt-record"
          >
            {saving ? "Saving…" : `Record ${noun}`}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Waiting for approval</h2>
        {drafts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No receipts or payments are waiting.</p>
        ) : (
          <table className="w-full text-sm" data-testid="settlement-drafts">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th>Type</th>
                <th>Date</th>
                <th>Party</th>
                <th>Bank</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Matched</th>
                <th>Recorded by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => (
                <tr key={d.id} className="border-t border-border">
                  <td>{d.docType === "receipt" ? "Receipt" : "Payment"}</td>
                  <td>{d.issueDate}</td>
                  <td>{d.partyName || ""}</td>
                  <td>{d.bankAccountCode ? `${d.bankAccountCode} ${d.bankAccountName || ""}` : ""}</td>
                  <td className="text-right tabular-nums">
                    {d.currency} {formatMinor(d.originalAmountMinor)}
                  </td>
                  <td className="text-right tabular-nums">
                    {formatMinor(d.allocatedMinor)}
                    {d.remainderMinor > 0 ? ` (+${formatMinor(d.remainderMinor)} advance)` : ""}
                  </td>
                  <td>{d.createdByName || ""}</td>
                  <td className="space-x-2 text-right">
                    {d.canPost ? (
                      <Button
                        size="sm"
                        onClick={() => void draftAction(d.id, "post")}
                        disabled={busyDraftId === d.id}
                      >
                        {busyDraftId === d.id ? "Posting…" : "Post"}
                      </Button>
                    ) : d.createdBy === me ? (
                      <span className="text-xs text-muted-foreground">Waiting for an approver</span>
                    ) : null}
                    {d.canPost || d.createdBy === me ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void draftAction(d.id, "discard")}
                        disabled={busyDraftId === d.id}
                      >
                        Discard
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
