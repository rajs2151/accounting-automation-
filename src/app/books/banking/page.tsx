"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CellAmount } from "@/components/books/cells";
import { StatusBadge } from "@/components/books/status-badge";
import { showUploadFeedback } from "@/components/books/upload-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
import { maskIbanDisplay } from "@/lib/iban-display";

type BankRow = {
  id: string;
  code: string;
  name: string;
  instrumentType: "bank" | "card" | "gateway" | "cash";
  bankName: string | null;
  iban: string | null;
  ibanLast4: string | null;
  currency: string;
  setupOk: boolean;
  coverageFrom: string | null;
  coverageTo: string | null;
  gaps: Array<{ from: string; to: string }>;
  lastClosingMinor: number | null;
  ledgerBalanceMinor: number;
  differenceMinor: number | null;
  unreviewedLineCount: number;
  statementCount: number;
};

const TYPE_LABEL: Record<BankRow["instrumentType"], string> = {
  bank: "Bank",
  card: "Credit card",
  gateway: "Gateway",
  cash: "Cash",
};

function coverageLabel(r: BankRow): string {
  if (!r.coverageFrom && !r.coverageTo) return "—";
  const a = r.coverageFrom ? formatDateUae(r.coverageFrom) : "—";
  const b = r.coverageTo ? formatDateUae(r.coverageTo) : "—";
  return `${a} – ${b}`;
}

function ibanDisplay(r: BankRow): string {
  if (r.iban) return maskIbanDisplay(r.iban);
  if (r.ibanLast4) return `**** ${r.ibanLast4}`;
  return "—";
}

export default function BankingPage() {
  const [rows, setRows] = useState<BankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [bankName, setBankName] = useState("");
  const [iban, setIban] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const rowFileRef = useRef<HTMLInputElement>(null);
  const [uploadForId, setUploadForId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/books/bank-accounts");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      setLoading(false);
      return;
    }
    if (Array.isArray(data)) setRows(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onUpload(files: FileList | null, accountId: string | null) {
    if (!files?.length) return;
    if (accountId) {
      const row = rows.find((r) => r.id === accountId);
      if (row && !row.setupOk) {
        toast.error("Set up bank name / IBAN before uploading to this account");
        return;
      }
    }
    const body = new FormData();
    for (const f of Array.from(files)) body.append("files", f);
    body.append("userDocType", "bank_statement");
    if (accountId) body.append("accountId", accountId);
    const res = await fetch("/api/books/inbox/upload", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    showUploadFeedback(res.ok, data);
    if (res.ok) void reload();
  }

  async function saveSetup() {
    if (!setupId) return;
    const res = await fetch(`/api/books/bank-accounts/${setupId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bankName: bankName.trim() || null, iban: iban.trim() || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    toast.success("Account setup saved");
    setSetupId(null);
    void reload();
  }

  function openSetup(r: BankRow) {
    setSetupId(r.id);
    setBankName(r.bankName || "");
    setIban(r.iban || "");
  }

  return (
    <div className="space-y-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Banking</h1>
          <p className="text-sm text-muted-foreground">
            Bank, card, gateway and cash accounts · statement coverage (matching in Phase 2)
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
            Upload statement
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.csv,.xlsx,image/*"
              className="hidden"
              data-testid="banking-upload"
              onChange={(e) => {
                void onUpload(e.target.files, null);
                e.target.value = "";
              }}
            />
          </label>
          <Link
            href="/books/statements"
            className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted"
            data-testid="banking-statements-link"
          >
            All statements
          </Link>
        </div>
      </div>

      {setupId ? (
        <div
          className="grid max-w-xl gap-3 rounded-lg border border-border p-4 md:grid-cols-2"
          data-testid="banking-setup-form"
        >
          <p className="md:col-span-2 text-sm text-muted-foreground">
            Complete setup so statements can be attributed to this account.
          </p>
          <div>
            <Label>Bank / gateway name</Label>
            <Input
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              data-testid="banking-setup-bank-name"
            />
          </div>
          <div>
            <Label>IBAN</Label>
            <Input
              value={iban}
              onChange={(e) => setIban(e.target.value)}
              data-testid="banking-setup-iban"
              placeholder="AE07…"
            />
          </div>
          <div className="md:col-span-2 flex gap-2">
            <Button data-testid="banking-setup-save" onClick={() => void saveSetup()}>
              Save
            </Button>
            <Button variant="outline" onClick={() => setSetupId(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm" data-testid="banking-accounts-table">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Account</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Bank</th>
              <th className="px-3 py-2">IBAN</th>
              <th className="px-3 py-2">Coverage</th>
              <th className="px-3 py-2">Last closing</th>
              <th className="px-3 py-2">Ledger</th>
              <th className="px-3 py-2">Diff</th>
              <th className="px-3 py-2">Unreviewed</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border" data-testid={`banking-row-${r.code}`}>
                <td className="px-3 py-2">
                  <div className="font-medium">
                    {r.code} · {r.name}
                  </div>
                  {!r.setupOk ? (
                    <StatusBadge
                      meta={{ label: "Not set up", tone: "danger" }}
                      data-testid={`banking-not-setup-${r.code}`}
                    />
                  ) : null}
                </td>
                <td className="px-3 py-2">{TYPE_LABEL[r.instrumentType]}</td>
                <td className="px-3 py-2">{r.bankName || "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{ibanDisplay(r)}</td>
                <td className="px-3 py-2">
                  <div>{coverageLabel(r)}</div>
                  {r.gaps.length ? (
                    <p className="text-xs text-red-600" data-testid={`banking-gaps-${r.code}`}>
                      Gap{" "}
                      {r.gaps
                        .slice(0, 2)
                        .map((g) => `${formatDateUae(g.from)}–${formatDateUae(g.to)}`)
                        .join("; ")}
                      {r.gaps.length > 2 ? ` +${r.gaps.length - 2}` : ""}
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {r.lastClosingMinor == null ? "—" : <CellAmount minor={r.lastClosingMinor} />}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  <CellAmount minor={r.ledgerBalanceMinor} />
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {r.differenceMinor == null ? (
                    "—"
                  ) : (
                    <span className={r.differenceMinor !== 0 ? "text-amber-700" : undefined}>
                      <CellAmount minor={r.differenceMinor} />
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums">{r.unreviewedLineCount}</td>
                <td className="space-x-2 px-3 py-2 text-right">
                  {!r.setupOk ? (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`banking-setup-${r.code}`}
                      onClick={() => openSetup(r)}
                    >
                      Set up
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`banking-upload-${r.code}`}
                      onClick={() => {
                        setUploadForId(r.id);
                        rowFileRef.current?.click();
                      }}
                    >
                      Upload
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && !rows.length ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-muted-foreground">
                  No bank / card / gateway / cash accounts on the COA.
                </td>
              </tr>
            ) : null}
            {loading ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <input
        ref={rowFileRef}
        type="file"
        multiple
        accept=".pdf,.csv,.xlsx,image/*"
        className="hidden"
        data-testid="banking-row-upload-input"
        onChange={(e) => {
          void onUpload(e.target.files, uploadForId);
          e.target.value = "";
          setUploadForId(null);
        }}
      />
    </div>
  );
}
