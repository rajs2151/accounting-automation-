"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { BooksDateInput } from "@/components/books/date-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateUae } from "@/lib/date";
import { displayToMinor, formatMinor, MoneyTypeError } from "@/lib/money";

type Line = {
  id?: string;
  lineDate: string | null;
  description: string;
  debitMinor: number;
  creditMinor: number;
  runningBalanceMinor: number | null;
  flags?: string[];
};

type StmtMeta = {
  id: string;
  accountLabel?: string | null;
  iban?: string | null;
  bankName?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  validationFlags?: string[];
};

function minor(v: unknown): number {
  if (v == null || v === "") return 0;
  return Number(v);
}

export default function StatementReviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [list, setList] = useState<Array<{ id: string; bankName?: string; iban?: string }>>([]);
  const [meta, setMeta] = useState<StmtMeta | null>(null);
  const [openingAed, setOpeningAed] = useState("0.00");
  const [closingAed, setClosingAed] = useState("0.00");
  const [lines, setLines] = useState<Line[]>([]);
  const [flags, setFlags] = useState<string[]>([]);

  const reloadList = useCallback(async () => {
    const rows = await fetch("/api/books/statements").then((r) => r.json());
    if (Array.isArray(rows)) setList(rows);
  }, []);

  const reload = useCallback(async () => {
    const data = await fetch(`/api/books/statements/${params.id}`).then((r) => r.json());
    if (data.error) {
      toast.error(data.error);
      return;
    }
    const opening = minor(data.opening_balance_minor ?? data.openingBalanceMinor);
    const closing = minor(data.closing_balance_minor ?? data.closingBalanceMinor);
    setMeta({
      id: String(data.id),
      accountLabel: data.account_label ?? data.accountLabel,
      iban: data.iban,
      bankName: data.bank_name ?? data.bankName,
      periodFrom: data.period_from ?? data.periodFrom,
      periodTo: data.period_to ?? data.periodTo,
      openingBalanceMinor: opening,
      closingBalanceMinor: closing,
      validationFlags: data.validation_flags || data.validationFlags || [],
    });
    setOpeningAed(formatMinor(opening) || "0.00");
    setClosingAed(formatMinor(closing) || "0.00");
    setFlags(data.validation_flags || data.validationFlags || []);
    setLines(
      (data.lines || []).map((l: Record<string, unknown>) => ({
        id: String(l.id),
        lineDate: l.lineDate
          ? String(l.lineDate).slice(0, 10)
          : l.line_date
            ? String(l.line_date).slice(0, 10)
            : null,
        description: String(l.description || ""),
        debitMinor: minor(l.debitMinor ?? l.debit_minor),
        creditMinor: minor(l.creditMinor ?? l.credit_minor),
        runningBalanceMinor:
          (l.runningBalanceMinor ?? l.running_balance_minor) == null
            ? null
            : minor(l.runningBalanceMinor ?? l.running_balance_minor),
        flags: (l.flags as string[]) || [],
      })),
    );
  }, [params.id]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function recheck() {
    let openingBalanceMinor: number;
    let closingBalanceMinor: number;
    try {
      openingBalanceMinor = displayToMinor(openingAed) ?? 0;
      closingBalanceMinor = displayToMinor(closingAed) ?? 0;
    } catch (e) {
      toast.error(e instanceof MoneyTypeError ? "Invalid amount" : "Invalid amount");
      return;
    }
    const res = await fetch(`/api/books/statements/${params.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        openingBalanceMinor,
        closingBalanceMinor,
        lines,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "recheck_failed");
      return;
    }
    toast.success("Re-checked");
    void reload();
  }

  const opening = (() => {
    try {
      return displayToMinor(openingAed) ?? 0;
    } catch {
      return 0;
    }
  })();
  const closing = (() => {
    try {
      return displayToMinor(closingAed) ?? 0;
    } catch {
      return 0;
    }
  })();
  const sumDr = lines.reduce((s, l) => s + l.debitMinor, 0);
  const sumCr = lines.reduce((s, l) => s + l.creditMinor, 0);
  const computed = opening + sumCr - sumDr;
  const empty = lines.length === 0;

  return (
    <div className="space-y-4 py-4" data-testid="statement-review">
      <h1 className="text-2xl font-semibold">Statement review</h1>
      <p className="text-sm text-muted-foreground">
        Phase 1 staging — bank matching consumes these in Phase 2.
      </p>

      <div className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3">
        <div>
          <Label>Statement</Label>
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            data-testid="statement-picker"
            value={params.id}
            onChange={(e) => router.push(`/books/statements/${e.target.value}`)}
          >
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {(s.bankName || "Statement") + (s.iban ? ` · ${s.iban}` : "")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Account / bank</Label>
          <Input
            className="mt-1"
            readOnly
            value={meta?.accountLabel || meta?.bankName || "—"}
            data-testid="statement-account"
          />
        </div>
        <div>
          <Label>IBAN</Label>
          <Input className="mt-1 font-mono text-xs" readOnly value={meta?.iban || "—"} data-testid="statement-iban" />
        </div>
        <div>
          <Label>Period from</Label>
          <Input
            className="mt-1"
            readOnly
            value={meta?.periodFrom ? formatDateUae(String(meta.periodFrom).slice(0, 10)) : "—"}
          />
        </div>
        <div>
          <Label>Period to</Label>
          <Input
            className="mt-1"
            readOnly
            value={meta?.periodTo ? formatDateUae(String(meta.periodTo).slice(0, 10)) : "—"}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <label>
          Opening (AED)
          <Input
            className="mt-1 w-40"
            value={openingAed}
            onChange={(e) => setOpeningAed(e.target.value)}
            data-testid="statement-opening"
          />
        </label>
        <label>
          Closing (AED)
          <Input
            className="mt-1 w-40"
            value={closingAed}
            onChange={(e) => setClosingAed(e.target.value)}
            data-testid="statement-closing"
          />
        </label>
        <div className="self-end pb-2" data-testid="statement-balance-status">
          {empty ? (
            <span className="text-muted-foreground">No rows</span>
          ) : (
            <>
              Opening + Σcr − Σdr = {formatMinor(computed)}{" "}
              {computed === closing ? (
                <span className="text-emerald-700">OK</span>
              ) : (
                <span className="text-red-600">≠ closing</span>
              )}
            </>
          )}
        </div>
        <Button className="self-end" onClick={() => void recheck()} disabled={empty}>
          Re-check
        </Button>
      </div>
      {flags?.length > 0 && (
        <p className="text-sm text-red-600">Flags: {flags.join(", ")}</p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">Debit</th>
              <th className="px-3 py-2">Credit</th>
              <th className="px-3 py-2">Running</th>
              <th className="px-3 py-2">RB check</th>
            </tr>
          </thead>
          <tbody>
            {empty ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  No rows
                </td>
              </tr>
            ) : (
              lines.map((l, i) => (
                <tr key={l.id || i} className="border-t border-border">
                  <td className="px-3 py-2">
                    <BooksDateInput
                      value={l.lineDate || ""}
                      onChange={(iso) => {
                        const next = [...lines];
                        next[i] = { ...l, lineDate: iso || null };
                        setLines(next);
                      }}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      value={l.description}
                      onChange={(e) => {
                        const next = [...lines];
                        next[i] = { ...l, description: e.target.value };
                        setLines(next);
                      }}
                    />
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatMinor(l.debitMinor)}</td>
                  <td className="px-3 py-2 tabular-nums">{formatMinor(l.creditMinor)}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {l.runningBalanceMinor == null ? "—" : formatMinor(l.runningBalanceMinor)}
                  </td>
                  <td className="px-3 py-2" data-testid={`rb-check-${i}`}>
                    {l.flags?.includes("balance_break") ? (
                      <span className="font-medium text-red-600">✗</span>
                    ) : (
                      <span className="text-emerald-700">✓</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Button
        variant="outline"
        onClick={() =>
          setLines((prev) => [
            ...prev,
            {
              lineDate: null,
              description: "",
              debitMinor: 0,
              creditMinor: 0,
              runningBalanceMinor: null,
            },
          ])
        }
      >
        Insert row
      </Button>
    </div>
  );
}
