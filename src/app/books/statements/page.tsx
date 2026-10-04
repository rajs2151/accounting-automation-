"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

type Row = {
  id: string;
  bankName: string | null;
  iban: string | null;
  status: string;
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
};

export default function StatementsListPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [csvText, setCsvText] = useState(
    "id,Type,Amount,Fee,Net,Currency,Created (UTC),Description\ntxn_1,charge,100.00,3.20,96.80,aed,2026-05-05 10:00:00,Payment\n",
  );

  useEffect(() => {
    void fetch("/api/books/statements")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setRows(data);
      });
  }, []);

  async function ingestStripe() {
    await fetch("/api/books/statements/csv", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csvText, issuerKey: "stripe", openingBalanceMinor: 0 }),
    });
    const data = await fetch("/api/books/statements").then((r) => r.json());
    if (Array.isArray(data)) setRows(data);
  }

  return (
    <div className="space-y-4 py-4">
      <h1 className="text-2xl font-semibold">Statement staging</h1>
      <p className="text-sm text-muted-foreground">
        Phase 1 review only — Phase 2 bank matching consumes these rows.
      </p>
      <textarea
        className="min-h-24 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
        value={csvText}
        onChange={(e) => setCsvText(e.target.value)}
      />
      <Button onClick={() => void ingestStripe()}>Ingest Stripe CSV preset</Button>
      <ul className="space-y-2 text-sm">
        {rows.map((r) => (
          <li key={r.id}>
            <Link className="text-primary underline" href={`/books/statements/${r.id}`}>
              {r.bankName || "Statement"} · {r.status}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
