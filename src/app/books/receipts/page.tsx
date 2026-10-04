"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { BooksDateInput } from "@/components/books/date-input";
import { useBooksShell } from "@/components/books/books-shell-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { displayToMinor, formatMinor, MoneyTypeError } from "@/lib/money";

export default function ReceiptsPage() {
  const { periodId } = useBooksShell();
  const [parties, setParties] = useState<Array<{ id: string; name: string }>>([]);
  const [openItems, setOpenItems] = useState<
    Array<{ id: string; openOriginalMinor: number; documentNumber: string | null; partyId: string }>
  >([]);
  const [accounts, setAccounts] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [form, setForm] = useState({
    partyId: "",
    bankAccountId: "",
    issueDate: "2026-05-20",
    amountAed: "105.00",
    currency: "AED",
    fxRateScaled: "100000000",
    openItemId: "",
    allocAed: "105.00",
  });

  useEffect(() => {
    void (async () => {
      const [p, oi, a] = await Promise.all([
        fetch("/api/books/parties?partyType=customer").then((r) => r.json()),
        fetch("/api/books/open-items?side=AR&status=open").then((r) => r.json()),
        fetch("/api/books/accounts?postableOnly=1").then((r) => r.json()),
      ]);
      if (Array.isArray(p)) {
        setParties(p);
        if (p[0]) setForm((f) => ({ ...f, partyId: p[0].id }));
      }
      if (Array.isArray(oi)) setOpenItems(oi);
      if (Array.isArray(a)) {
        const banks = a.filter((x: { code: string }) => x.code.startsWith("112"));
        setAccounts(banks);
        if (banks[0]) setForm((f) => ({ ...f, bankAccountId: banks[0].id }));
      }
    })();
  }, []);

  async function submit(docType: "receipt" | "payment") {
    let originalAmountMinor: number;
    let allocMinor = 0;
    try {
      originalAmountMinor = displayToMinor(form.amountAed) ?? 0;
      if (form.openItemId) allocMinor = displayToMinor(form.allocAed) ?? 0;
    } catch (e) {
      toast.error(e instanceof MoneyTypeError ? "Invalid amount" : "Invalid amount");
      return;
    }
    const allocations = form.openItemId
      ? [{ openItemId: form.openItemId, allocatedOriginalMinor: allocMinor }]
      : [];
    // Session user is the approver; dual-control preparer defaults on the server to
    // a distinct accountant when body.preparerId is omitted — see API route.
    const res = await fetch("/api/books/settlements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docType,
        partyId: form.partyId,
        issueDate: form.issueDate,
        periodId,
        bankAccountId: form.bankAccountId,
        currency: form.currency,
        fxRateScaled: Number(form.fxRateScaled),
        originalAmountMinor,
        allocations,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "failed");
      return;
    }
    toast.success(`${docType} ${data.entryNo}`);
  }

  return (
    <div className="space-y-4 py-4">
      <h1 className="text-2xl font-semibold">Receipts & payments</h1>
      <p className="text-sm text-muted-foreground">
        Unallocated receipt remainder → customer advance (2320). Post as the signed-in user
        (switch role in the sidebar for dual control).
      </p>
      <div className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3">
        <div>
          <Label>Party</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={form.partyId}
            onChange={(e) => setForm({ ...form, partyId: e.target.value })}
          >
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Bank</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={form.bankAccountId}
            onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Amount (AED)</Label>
          <Input
            value={form.amountAed}
            onChange={(e) => setForm({ ...form, amountAed: e.target.value })}
            inputMode="decimal"
            placeholder="0.00"
          />
        </div>
        <div>
          <Label>Issue date</Label>
          <BooksDateInput
            value={form.issueDate}
            onChange={(iso) => setForm({ ...form, issueDate: iso })}
            data-testid="receipt-issue-date"
          />
        </div>
        <div>
          <Label>Allocate open item</Label>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={form.openItemId}
            onChange={(e) => setForm({ ...form, openItemId: e.target.value })}
          >
            <option value="">— none (full advance) —</option>
            {openItems
              .filter((o) => o.partyId === form.partyId)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.documentNumber || o.id.slice(0, 8)} open {formatMinor(o.openOriginalMinor)}
                </option>
              ))}
          </select>
        </div>
        <div className="flex items-end gap-2 md:col-span-2">
          <Button onClick={() => void submit("receipt")}>Post receipt</Button>
          <Button variant="outline" onClick={() => void submit("payment")}>
            Post payment
          </Button>
        </div>
      </div>
    </div>
  );
}
