"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { BooksDateInput } from "@/components/books/date-input";
import { Badge } from "@/components/ui/badge";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateUae } from "@/lib/date";
import {
  maskIbanDisplay,
  statementBalanceBadgeLabel,
} from "@/lib/iban-display";
import { displayToMinor, formatMinor, MoneyTypeError } from "@/lib/money";
import { cn } from "@/lib/utils";

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
  currency?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  validationFlags?: string[];
  fileId?: string | null;
  inboxItemId?: string | null;
};

type ListRow = {
  id: string;
  bankName?: string | null;
  iban?: string | null;
  accountLabel?: string | null;
  currency?: string | null;
  fileId?: string | null;
  inboxItemId?: string | null;
  rowKind?: string;
  periodFrom?: string | null;
  periodTo?: string | null;
};

type SectionState = {
  meta: StmtMeta;
  openingAed: string;
  closingAed: string;
  lines: Line[];
  flags: string[];
  collapsed: boolean;
};

function minor(v: unknown): number {
  if (v == null || v === "") return 0;
  return Number(v);
}

function parseStatementPayload(data: Record<string, unknown>): SectionState {
  const opening = minor(data.opening_balance_minor ?? data.openingBalanceMinor);
  const closing = minor(data.closing_balance_minor ?? data.closingBalanceMinor);
  const flags = (data.validation_flags || data.validationFlags || []) as string[];
  return {
    meta: {
      id: String(data.id),
      accountLabel: (data.account_label ?? data.accountLabel) as string | null | undefined,
      iban: data.iban as string | null | undefined,
      bankName: (data.bank_name ?? data.bankName) as string | null | undefined,
      currency: (data.currency as string | null | undefined) || "AED",
      periodFrom: (data.period_from ?? data.periodFrom) as string | null | undefined,
      periodTo: (data.period_to ?? data.periodTo) as string | null | undefined,
      openingBalanceMinor: opening,
      closingBalanceMinor: closing,
      validationFlags: flags,
      fileId: (data.file_id ?? data.fileId) as string | null | undefined,
      inboxItemId: (data.inbox_item_id ?? data.inboxItemId) as string | null | undefined,
    },
    openingAed: formatMinor(opening) || "0.00",
    closingAed: formatMinor(closing) || "0.00",
    flags,
    collapsed: false,
    lines: ((data.lines as Record<string, unknown>[]) || []).map((l) => ({
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
  };
}

function accountKey(row: { id: string; iban?: string | null; accountLabel?: string | null; bankName?: string | null }) {
  return row.iban || row.accountLabel || row.bankName || row.id;
}

function periodText(from?: string | null, to?: string | null) {
  const a = from ? formatDateUae(String(from).slice(0, 10)) : "—";
  const b = to ? formatDateUae(String(to).slice(0, 10)) : "—";
  return `${a} – ${b}`;
}

function amountDisplay(minorUnits: number): string {
  return minorUnits === 0 ? "" : formatMinor(minorUnits);
}

function ClickEditText({
  value,
  onChange,
  className,
  "data-testid": testId,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  "data-testid"?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (editing) {
    return (
      <Input
        className={cn("h-8", className)}
        value={draft}
        autoFocus
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          onChange(draft);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onChange(draft);
            setEditing(false);
          } else if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "block w-full rounded-md border border-transparent px-2 py-1 text-start text-sm hover:border-border hover:bg-muted/40",
        className,
      )}
      data-testid={testId}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
    >
      {value || <span className="text-muted-foreground">—</span>}
    </button>
  );
}

function ClickEditAmount({
  minorUnits,
  onCommit,
  className,
  "data-testid": testId,
  align = "end",
  blankZero = true,
}: {
  minorUnits: number;
  onCommit: (minor: number) => void;
  className?: string;
  "data-testid"?: string;
  align?: "start" | "end";
  /** When true, zero shows blank (debit/credit columns). */
  blankZero?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const display = blankZero ? amountDisplay(minorUnits) : formatMinor(minorUnits) || "0.00";
  const [draft, setDraft] = useState(display || "0.00");

  useEffect(() => {
    if (!editing) setDraft(display || "0.00");
  }, [display, editing]);

  function commit() {
    try {
      const next = displayToMinor(draft.trim() || "0.00") ?? 0;
      onCommit(next);
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof MoneyTypeError ? "Invalid amount" : "Invalid amount");
    }
  }

  if (editing) {
    return (
      <Input
        className={cn("h-8 tabular-nums", align === "end" && "text-end", className)}
        value={draft}
        autoFocus
        inputMode="decimal"
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft(display || "0.00");
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "block w-full min-h-8 rounded-md border border-transparent px-2 py-1 text-sm tabular-nums hover:border-border hover:bg-muted/40",
        align === "end" ? "text-end" : "text-start",
        className,
      )}
      data-testid={testId}
      onClick={() => {
        setDraft(display || "0.00");
        setEditing(true);
      }}
    >
      {display || <span className="text-muted-foreground">&nbsp;</span>}
    </button>
  );
}

export default function StatementReviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [list, setList] = useState<ListRow[]>([]);
  const [sections, setSections] = useState<Record<string, SectionState>>({});
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [currencyFilter, setCurrencyFilter] = useState<string>("all");
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<{
    filename: string | null;
    uploadedBy: string | null;
    uploadedAt: string | null;
    extractorVersion: string | null;
    status: string;
    validationFlags: unknown;
    error: string | null;
    events: Array<{ id: string; actor: string | null; action: string; at: string }>;
  } | null>(null);

  const reloadList = useCallback(async () => {
    const rows = await fetch("/api/books/statements").then((r) => r.json());
    if (Array.isArray(rows)) setList(rows);
  }, []);

  const loadStatement = useCallback(async (id: string, collapsedDefault: boolean) => {
    const data = await fetch(`/api/books/statements/${id}`).then((r) => r.json());
    if (data.error) {
      toast.error(data.error);
      return null;
    }
    const parsed = parseStatementPayload(data);
    parsed.collapsed = collapsedDefault;
    return parsed;
  }, []);

  const reload = useCallback(async () => {
    const current = await loadStatement(params.id, false);
    if (!current) return;

    const listRows: ListRow[] = await fetch("/api/books/statements")
      .then((r) => r.json())
      .then((rows) => (Array.isArray(rows) ? rows : []));

    const currentList = listRows.find((r) => r.id === params.id);
    const fileId = current.meta.fileId || currentList?.fileId || null;
    const inboxItemId = current.meta.inboxItemId || currentList?.inboxItemId || null;

    const siblings = listRows.filter((r) => {
      if (r.rowKind === "pending") return false;
      if (fileId && r.fileId === fileId) return true;
      if (!fileId && inboxItemId && r.inboxItemId === inboxItemId) return true;
      return r.id === params.id;
    });

    const next: Record<string, SectionState> = { [params.id]: current };
    await Promise.all(
      siblings
        .filter((s) => s.id !== params.id)
        .map(async (s) => {
          const section = await loadStatement(s.id, true);
          if (section) next[s.id] = section;
        }),
    );
    setSections(next);
  }, [loadStatement, params.id]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const currentMeta = sections[params.id]?.meta;
  const siblingIds = useMemo(() => {
    const fileId = currentMeta?.fileId || list.find((r) => r.id === params.id)?.fileId || null;
    const inboxItemId =
      currentMeta?.inboxItemId || list.find((r) => r.id === params.id)?.inboxItemId || null;
    return list
      .filter((r) => {
        if (r.rowKind === "pending") return false;
        if (fileId && r.fileId === fileId) return true;
        if (!fileId && inboxItemId && r.inboxItemId === inboxItemId) return true;
        return r.id === params.id;
      })
      .map((r) => r.id);
  }, [currentMeta, list, params.id]);

  const multiAccount = siblingIds.length > 1;

  const accountOptions = useMemo(() => {
    const opts = new Map<string, string>();
    for (const id of siblingIds) {
      const s = sections[id]?.meta || list.find((r) => r.id === id);
      if (!s) continue;
      const key = accountKey(s);
      const label =
        [s.bankName || s.accountLabel || "Account", s.iban ? maskIbanDisplay(s.iban) : null]
          .filter(Boolean)
          .join(" · ") || key;
      opts.set(key, label);
    }
    return [...opts.entries()];
  }, [siblingIds, sections, list]);

  const currencyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const id of siblingIds) {
      const s = sections[id]?.meta || list.find((r) => r.id === id);
      const c = s?.currency || "AED";
      set.add(c);
    }
    return [...set].sort();
  }, [siblingIds, sections, list]);

  const visibleSectionIds = useMemo(() => {
    return siblingIds.filter((id) => {
      const s = sections[id]?.meta || list.find((r) => r.id === id);
      if (!s) return id === params.id;
      if (accountFilter !== "all" && accountKey(s) !== accountFilter) return false;
      if (currencyFilter !== "all" && (s.currency || "AED") !== currencyFilter) return false;
      return true;
    });
  }, [siblingIds, sections, list, accountFilter, currencyFilter, params.id]);

  async function recheck(statementId: string) {
    const section = sections[statementId];
    if (!section) return;
    let openingBalanceMinor: number;
    let closingBalanceMinor: number;
    try {
      openingBalanceMinor = displayToMinor(section.openingAed) ?? 0;
      closingBalanceMinor = displayToMinor(section.closingAed) ?? 0;
    } catch (e) {
      toast.error(e instanceof MoneyTypeError ? "Invalid amount" : "Invalid amount");
      return;
    }
    const res = await fetch(`/api/books/statements/${statementId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        openingBalanceMinor,
        closingBalanceMinor,
        lines: section.lines,
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

  function updateSection(id: string, patch: Partial<SectionState>) {
    setSections((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }

  function updateLine(statementId: string, index: number, patch: Partial<Line>) {
    setSections((prev) => {
      const cur = prev[statementId];
      if (!cur) return prev;
      const lines = [...cur.lines];
      lines[index] = { ...lines[index]!, ...patch };
      return { ...prev, [statementId]: { ...cur, lines } };
    });
  }

  const pickerRows = list.filter((r) => r.rowKind !== "pending");

  async function loadLogs() {
    const nextOpen = !logsOpen;
    setLogsOpen(nextOpen);
    if (!nextOpen) return;
    const res = await fetch(`/api/books/statements/${params.id}/logs`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error || "logs_failed");
      return;
    }
    setLogs(data);
  }

  return (
    <div className="space-y-4 py-4" data-testid="statement-review">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Statement review</h1>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="statement-logs-toggle"
          onClick={() => void loadLogs()}
        >
          {logsOpen ? "Hide statement logs" : "Statement logs"}
        </Button>
      </div>

      {logsOpen && logs ? (
        <div
          className="space-y-2 rounded-lg border border-border p-3 text-sm"
          data-testid="statement-logs"
        >
          <p>
            <span className="text-muted-foreground">File</span> {logs.filename || "—"}
            {" · "}
            <span className="text-muted-foreground">Extractor</span>{" "}
            {logs.extractorVersion || "—"}
            {" · "}
            <span className="text-muted-foreground">Status</span> {logs.status}
          </p>
          {logs.error ? <p className="text-red-600">{logs.error}</p> : null}
          {Array.isArray(logs.validationFlags) && logs.validationFlags.length ? (
            <p className="text-xs text-muted-foreground">
              Flags: {(logs.validationFlags as string[]).join(", ")}
            </p>
          ) : null}
          <ul className="space-y-1 font-mono text-xs">
            {logs.events.length === 0 ? (
              <li className="text-muted-foreground">No audit events yet.</li>
            ) : (
              logs.events.map((e) => (
                <li key={e.id}>
                  {e.at ? String(e.at).replace("T", " ").slice(0, 19) : "—"} UTC · {e.action}
                  {e.actor ? ` · ${e.actor.slice(0, 8)}…` : ""}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <Label>Statement</Label>
          <Select
            value={params.id}
            onValueChange={(v) => {
              if (v) router.push(`/books/statements/${v}`);
            }}
          >
            <SelectTrigger className="mt-1 w-full" data-testid="statement-picker">
              <SelectValue placeholder="Select statement">
                {(v: unknown) => {
                  // Show the statement's name, not its id.
                  const s = pickerRows.find((r) => r.id === v);
                  return s
                    ? (s.bankName || s.accountLabel || "Statement") + (s.iban ? ` · ${maskIbanDisplay(s.iban)}` : "")
                    : "Select statement";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {pickerRows.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {(s.bankName || s.accountLabel || "Statement") +
                    (s.iban ? ` · ${maskIbanDisplay(s.iban)}` : "")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {multiAccount ? (
          <>
            <div className="min-w-[180px]">
              <Label>Account</Label>
              <Select value={accountFilter} onValueChange={(v) => v && setAccountFilter(v)}>
                <SelectTrigger className="mt-1 w-full" data-testid="statement-account-filter">
                  <SelectValue placeholder="All accounts" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All accounts</SelectItem>
                  {accountOptions.map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[160px]">
              <Label>Currency</Label>
              <Select value={currencyFilter} onValueChange={(v) => v && setCurrencyFilter(v)}>
                <SelectTrigger className="mt-1 w-full" data-testid="statement-currency-filter">
                  <SelectValue placeholder="All currencies" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All currencies</SelectItem>
                  {currencyOptions.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        ) : null}
      </div>

      <div className="space-y-3">
        {visibleSectionIds.map((statementId) => {
          const section = sections[statementId];
          if (!section) {
            return (
              <div key={statementId} className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
                Loading…
              </div>
            );
          }

          const { meta, lines, openingAed, closingAed, flags, collapsed } = section;
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
          const balanced = !empty && computed === closing;
          const badgeLabel = statementBalanceBadgeLabel({
            openingMinor: opening,
            closingMinor: closing,
            sumDebitMinor: sumDr,
            sumCreditMinor: sumCr,
            empty,
          });
          const formula = `Opening + Σcr − Σdr = ${formatMinor(computed)}`;
          const ambiguous = flags.includes("account_attribution_ambiguous");
          const isPrimary = statementId === params.id;

          return (
            <section
              key={statementId}
              className="overflow-hidden rounded-lg border border-border"
              data-testid={isPrimary ? "statement-account-section" : `statement-sibling-${statementId}`}
            >
              <div className="flex flex-wrap items-center gap-2 bg-muted/30 px-3 py-2.5">
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={collapsed ? "Expand account" : "Collapse account"}
                  data-testid={isPrimary ? "statement-collapse" : undefined}
                  onClick={() => updateSection(statementId, { collapsed: !collapsed })}
                >
                  {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                </button>

                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium" data-testid={isPrimary ? "statement-account" : undefined}>
                    {meta.bankName || meta.accountLabel || "Account"}
                  </span>
                  <span className="text-muted-foreground"> · </span>
                  <span className="font-mono text-xs" data-testid={isPrimary ? "statement-iban" : undefined}>
                    {maskIbanDisplay(meta.iban)}
                  </span>
                  <span className="text-muted-foreground"> · </span>
                  <span data-testid={isPrimary ? "statement-currency" : undefined}>{meta.currency || "AED"}</span>
                  <span className="text-muted-foreground"> · </span>
                  <span data-testid={isPrimary ? "statement-period" : undefined}>
                    {periodText(meta.periodFrom, meta.periodTo)}
                  </span>
                </div>

                {ambiguous ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="inline-flex"
                          data-testid={isPrimary ? "statement-ambiguous" : undefined}
                        />
                      }
                    >
                      <Badge
                        variant="outline"
                        className="gap-1 border-amber-200 bg-amber-50 font-normal text-amber-900"
                      >
                        <AlertTriangle className="size-3" />
                        Ambiguous
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      Multiple IBANs in this file — account attribution is ambiguous. Confirm which
                      account these lines belong to.
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                <Tooltip>
                  <TooltipTrigger render={<button type="button" className="inline-flex" />}>
                    <Badge
                      variant="outline"
                      data-testid={isPrimary ? "statement-balance-status" : undefined}
                      className={cn(
                        "font-normal",
                        empty
                          ? "border-border bg-muted/60 text-muted-foreground"
                          : balanced
                            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                            : "border-red-200 bg-red-50 text-red-900",
                      )}
                    >
                      {badgeLabel}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{formula}</TooltipContent>
                </Tooltip>
              </div>

              {!collapsed ? (
                <div className="space-y-3 p-3">
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-muted-foreground">Opening</span>
                    <div className="w-28">
                      <ClickEditAmount
                        minorUnits={opening}
                        blankZero={false}
                        data-testid={isPrimary ? "statement-opening" : undefined}
                        align="start"
                        onCommit={(m) => updateSection(statementId, { openingAed: formatMinor(m) || "0.00" })}
                      />
                    </div>
                    <span className="text-muted-foreground" aria-hidden>
                      →
                    </span>
                    <span className="text-muted-foreground">Closing</span>
                    <div className="w-28">
                      <ClickEditAmount
                        minorUnits={closing}
                        blankZero={false}
                        data-testid={isPrimary ? "statement-closing" : undefined}
                        align="start"
                        onCommit={(m) => updateSection(statementId, { closingAed: formatMinor(m) || "0.00" })}
                      />
                    </div>
                    <Button
                      size="sm"
                      className="ms-auto"
                      onClick={() => void recheck(statementId)}
                      disabled={empty}
                    >
                      Re-check
                    </Button>
                  </div>

                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-start">
                        <tr>
                          <th className="px-3 py-2 font-medium">Date</th>
                          <th className="px-3 py-2 font-medium">Description</th>
                          <th className="px-3 py-2 text-end font-medium">Debit</th>
                          <th className="px-3 py-2 text-end font-medium">Credit</th>
                          <th className="px-3 py-2 text-end font-medium">Running</th>
                          <th className="w-12 px-2 py-2 text-center font-medium" title="Running balance check">
                            RB
                          </th>
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
                              <td className="px-2 py-1">
                                {isPrimary ? (
                                  <ClickEditDate
                                    value={l.lineDate || ""}
                                    onChange={(iso) => updateLine(statementId, i, { lineDate: iso || null })}
                                  />
                                ) : (
                                  <span className="px-2 text-sm">
                                    {l.lineDate ? formatDateUae(l.lineDate) : "—"}
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-1">
                                {isPrimary ? (
                                  <ClickEditText
                                    value={l.description}
                                    onChange={(v) => updateLine(statementId, i, { description: v })}
                                  />
                                ) : (
                                  <span className="px-2 text-sm">{l.description || "—"}</span>
                                )}
                              </td>
                              <td className="px-2 py-1">
                                {isPrimary ? (
                                  <ClickEditAmount
                                    minorUnits={l.debitMinor}
                                    onCommit={(m) =>
                                      updateLine(statementId, i, {
                                        debitMinor: m,
                                        creditMinor: m > 0 ? 0 : l.creditMinor,
                                      })
                                    }
                                  />
                                ) : (
                                  <span className="block px-2 text-end tabular-nums">
                                    {amountDisplay(l.debitMinor)}
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-1">
                                {isPrimary ? (
                                  <ClickEditAmount
                                    minorUnits={l.creditMinor}
                                    onCommit={(m) =>
                                      updateLine(statementId, i, {
                                        creditMinor: m,
                                        debitMinor: m > 0 ? 0 : l.debitMinor,
                                      })
                                    }
                                  />
                                ) : (
                                  <span className="block px-2 text-end tabular-nums">
                                    {amountDisplay(l.creditMinor)}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-end tabular-nums">
                                {l.runningBalanceMinor == null ? "—" : formatMinor(l.runningBalanceMinor)}
                              </td>
                              <td
                                className="px-2 py-2 text-center"
                                data-testid={isPrimary ? `rb-check-${i}` : undefined}
                              >
                                <Tooltip>
                                  <TooltipTrigger render={<button type="button" className="inline-flex" />}>
                                    {l.flags?.includes("balance_break") ? (
                                      <span className="font-medium text-red-600">✗</span>
                                    ) : (
                                      <span className="text-emerald-700">✓</span>
                                    )}
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {l.flags?.includes("balance_break")
                                      ? "Running balance does not match statement"
                                      : "Running balance matches statement"}
                                  </TooltipContent>
                                </Tooltip>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  {isPrimary ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        updateSection(statementId, {
                          lines: [
                            ...lines,
                            {
                              lineDate: null,
                              description: "",
                              debitMinor: 0,
                              creditMinor: 0,
                              runningBalanceMinor: null,
                            },
                          ],
                        })
                      }
                    >
                      Insert row
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ClickEditDate({
  value,
  onChange,
}: {
  value: string;
  onChange: (iso: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <BooksDateInput
        value={value}
        onChange={(iso) => {
          onChange(iso);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="block w-full rounded-md border border-transparent px-2 py-1 text-start text-sm hover:border-border hover:bg-muted/40"
      onClick={() => setEditing(true)}
    >
      {value ? formatDateUae(value) : <span className="text-muted-foreground">—</span>}
    </button>
  );
}
