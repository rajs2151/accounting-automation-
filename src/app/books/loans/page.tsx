"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useBooksShell } from "@/components/books/books-shell-context";
import { BooksDateInput } from "@/components/books/date-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";
import { displayToMinor, formatMinor } from "@/lib/money";

type Loan = {
  id: string;
  name: string;
  lender: string;
  principalMinor: number;
  annualRateBps: number;
  startDate: string;
  endDate: string | null;
  active: boolean;
  monthlyInterestMinor: number;
};

export default function LoansPage() {
  const { periodId } = useBooksShell();
  const [loans, setLoans] = useState<Loan[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [lender, setLender] = useState("");
  const [principal, setPrincipal] = useState("");
  const [ratePct, setRatePct] = useState("5");
  const [startDate, setStartDate] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/books/loans");
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(apiErrorMessage(data) || data.error || "load_failed");
      setLoans(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addLoan() {
    setBusy(true);
    setError("");
    try {
      let principalMinor = 0;
      try {
        principalMinor = displayToMinor(principal);
      } catch {
        throw new Error("Enter a valid principal amount");
      }
      const annualRateBps = Math.round(Number(ratePct) * 100);
      const res = await fetch("/api/books/loans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          lender,
          principalMinor,
          annualRateBps,
          startDate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(data) || data.error || "create_failed");
      toast.success("Loan added");
      setName("");
      setLender("");
      setPrincipal("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create_failed");
    } finally {
      setBusy(false);
    }
  }

  async function runInterest() {
    if (!periodId) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/books/loans/run-interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(data) || data.error || "run_failed");
      toast.success(
        `Interest drafts: ${data.posted || 0} created — post them in Journals (dual control)`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "run_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 py-4" data-testid="loans-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Loans</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Register long-term loans and accrue monthly interest (Dr 7400 / Cr 2420). Run creates drafts —
            an approver posts them.
          </p>
        </div>
        <Button type="button" size="sm" disabled={!periodId || busy} onClick={() => void runInterest()}>
          Run interest for period
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      <section className="space-y-3 rounded-md border border-border p-4">
        <h2 className="text-lg font-medium">Add loan</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label htmlFor="loan-name">Name</Label>
            <Input id="loan-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="loan-lender">Lender</Label>
            <Input id="loan-lender" value={lender} onChange={(e) => setLender(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="loan-principal">Principal (AED)</Label>
            <Input
              id="loan-principal"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
              placeholder="100000.00"
            />
          </div>
          <div>
            <Label htmlFor="loan-rate">Annual rate %</Label>
            <Input id="loan-rate" value={ratePct} onChange={(e) => setRatePct(e.target.value)} />
          </div>
          <div>
            <Label>Start date</Label>
            <BooksDateInput value={startDate} onChange={setStartDate} />
          </div>
        </div>
        <Button type="button" size="sm" disabled={busy || !name || !principal || !startDate} onClick={() => void addLoan()}>
          Save loan
        </Button>
      </section>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Lender</th>
              <th className="px-3 py-2 font-medium text-right">Principal</th>
              <th className="px-3 py-2 font-medium text-right">Rate</th>
              <th className="px-3 py-2 font-medium text-right">Monthly interest</th>
              <th className="px-3 py-2 font-medium">Start</th>
              <th className="px-3 py-2 font-medium">Active</th>
            </tr>
          </thead>
          <tbody>
            {loans.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="px-3 py-2">{l.name}</td>
                <td className="px-3 py-2">{l.lender || "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMinor(l.principalMinor)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{(l.annualRateBps / 100).toFixed(2)}%</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMinor(l.monthlyInterestMinor)}</td>
                <td className="px-3 py-2">{l.startDate}</td>
                <td className="px-3 py-2">{l.active ? "Yes" : "No"}</td>
              </tr>
            ))}
            {loans.length === 0 ? (
              <tr className="border-t border-border">
                <td className="px-3 py-3 text-muted-foreground" colSpan={7}>
                  No loans yet
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
