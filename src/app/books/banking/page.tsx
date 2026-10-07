"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { CellAmount } from "@/components/books/cells";
import { StatusBadge } from "@/components/books/status-badge";
import { UploadDialog } from "@/components/books/upload-dialog";
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

type Period = { id: string; label: string; periodStart: string; periodEnd: string; status: string };

type ReconRow = {
  accountId: string;
  asOf: string;
  status: "reconciled" | "difference" | "no_statement";
  ledgerBalanceMinor: number;
  statementBalanceMinor: number | null;
  differenceMinor: number | null;
  statementOnlyCount: number;
  ledgerOnlyCount: number;
  unexplainedMinor: number | null;
};

type ReconItem = {
  kind: "statement_only" | "ledger_only";
  state: string;
  date: string | null;
  description: string;
  amountMinor: number;
  entryNo: string | null;
};

type ReconDetail = ReconRow & { code: string; name: string; periodLabel: string; items: ReconItem[] };

const RECON_META: Record<ReconRow["status"], { label: string; tone: "success" | "warning" | "neutral" }> = {
  reconciled: { label: "Reconciled", tone: "success" },
  difference: { label: "Difference", tone: "warning" },
  no_statement: { label: "No statement", tone: "neutral" },
};

const ITEM_STATE_LABEL: Record<string, string> = {
  not_materialized: "On statement, not in Transactions",
  needs_review: "On statement, needs review",
  ready: "On statement, ready to post",
  excluded: "On statement, excluded",
  journal: "In ledger, not on statement",
};

/** Latest period that has ended (else the first one). */
function defaultPeriodId(periods: Period[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const ended = periods
    .filter((p) => String(p.periodEnd).slice(0, 10) <= today)
    .sort((a, b) => String(b.periodEnd).localeCompare(String(a.periodEnd)));
  return ended[0]?.id || periods[0]?.id || "";
}

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
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadForId, setUploadForId] = useState<string | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState("");
  const [recon, setRecon] = useState<Record<string, ReconRow>>({});
  const [detail, setDetail] = useState<ReconDetail | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/books/periods");
      const data = await res.json().catch(() => []);
      if (res.ok && Array.isArray(data)) {
        setPeriods(data);
        setPeriodId((cur) => cur || defaultPeriodId(data));
      }
    })();
  }, []);

  const reloadRecon = useCallback(async () => {
    if (!periodId) return;
    const res = await fetch(`/api/books/bank-recon?periodId=${encodeURIComponent(periodId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    if (Array.isArray(data)) {
      setRecon(Object.fromEntries((data as ReconRow[]).map((r) => [r.accountId, r])));
    }
  }, [periodId]);

  useEffect(() => {
    setDetail(null);
    void reloadRecon();
  }, [reloadRecon]);

  async function openRecon(accountId: string) {
    const res = await fetch(
      `/api/books/bank-recon/${encodeURIComponent(accountId)}?periodId=${encodeURIComponent(periodId)}`,
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(apiErrorMessage(data));
      return;
    }
    setDetail(data as ReconDetail);
  }

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
    void reloadRecon();
  }, [reloadRecon]);

  useEffect(() => {
    void reload();
  }, [reload]);

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
          <h1 className="text-2xl font-semibold">Bank accounts</h1>
          <p className="text-sm text-muted-foreground">
            Bank, card, payment-gateway and cash accounts, and whether each month’s statement is in
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Reconcile to</span>
            <select
              className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
              value={periodId}
              onChange={(e) => setPeriodId(e.target.value)}
              data-testid="banking-recon-period"
            >
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <a
            href="/samples/bank-statement-sample.csv"
            download="bank-statement-sample.csv"
            className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted"
            data-testid="banking-sample-csv"
          >
            Download sample sheet
          </a>
          <Button
            data-testid="banking-upload"
            onClick={() => {
              setUploadForId(null);
              setUploadOpen(true);
            }}
          >
            Upload statement
          </Button>
          <Link
            href="/books/statements"
            className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted"
            data-testid="banking-statements-link"
          >
            Bank statements
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
              <th className="px-3 py-2">Reconciled</th>
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
                <td className="px-3 py-2" data-testid={`banking-recon-${r.code}`}>
                  {recon[r.id] ? (
                    <button
                      type="button"
                      className="space-y-0.5 text-left"
                      onClick={() => void openRecon(r.id)}
                      data-testid={`banking-recon-open-${r.code}`}
                    >
                      <StatusBadge meta={RECON_META[recon[r.id].status]} />
                      {recon[r.id].differenceMinor ? (
                        <span className="block text-xs tabular-nums text-amber-700">
                          <CellAmount minor={recon[r.id].differenceMinor!} />
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums">{r.unreviewedLineCount}</td>
                <td className="space-x-2 px-3 py-2 text-right">
                  <Link
                    href={`/books/transactions?accountId=${encodeURIComponent(r.id)}`}
                    className="inline-flex h-7 items-center rounded-md border border-border px-2 text-xs hover:bg-muted"
                    data-testid={`banking-transactions-${r.code}`}
                  >
                    Transactions
                  </Link>
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
                        setUploadOpen(true);
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
                <td colSpan={11} className="px-3 py-6 text-muted-foreground">
                  No bank / card / gateway / cash accounts on the COA.
                </td>
              </tr>
            ) : null}
            {loading ? (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {detail ? (
        <div className="space-y-3 rounded-lg border border-border p-4" data-testid="banking-recon-detail">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-medium">
                {detail.code} · {detail.name} — reconciliation to {formatDateUae(detail.asOf)}
              </h2>
              <p className="text-sm text-muted-foreground">
                Statement{" "}
                {detail.statementBalanceMinor == null ? (
                  "— (no statement covers this date)"
                ) : (
                  <CellAmount minor={detail.statementBalanceMinor} />
                )}{" "}
                · Ledger <CellAmount minor={detail.ledgerBalanceMinor} />
                {detail.differenceMinor != null ? (
                  <>
                    {" "}
                    · Difference <CellAmount minor={detail.differenceMinor} />
                  </>
                ) : null}
                {detail.unexplainedMinor ? (
                  <>
                    {" "}
                    · <span className="text-red-600">Unexplained </span>
                    <CellAmount minor={detail.unexplainedMinor} />
                  </>
                ) : null}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setDetail(null)}>
              Close
            </Button>
          </div>
          {detail.items.length ? (
            <table className="w-full text-sm" data-testid="banking-recon-items">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">Date</th>
                  <th className="py-1 pr-3">Item</th>
                  <th className="py-1 pr-3">Why unreconciled</th>
                  <th className="py-1 pr-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {detail.items.map((it, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-1 pr-3">{it.date ? formatDateUae(it.date) : "—"}</td>
                    <td className="py-1 pr-3">
                      {it.entryNo ? <span className="font-mono text-xs">{it.entryNo} </span> : null}
                      {it.description || "—"}
                    </td>
                    <td className="py-1 pr-3">{ITEM_STATE_LABEL[it.state] || it.state}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      <CellAmount minor={it.amountMinor} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing unreconciled.</p>
          )}
        </div>
      ) : null}

      <UploadDialog
        open={uploadOpen}
        onOpenChange={(v) => {
          setUploadOpen(v);
          if (!v) setUploadForId(null);
        }}
        defaultDocType="bank_statement"
        intendedAccountId={uploadForId}
        onUploaded={() => void reload()}
      />
    </div>
  );
}
