"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, Plus, Trash2, X } from "lucide-react";

import { BooksDateInput } from "@/components/books/date-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { vatAmountForBase, vatCodeLabel } from "@/lib/vat";
const VOUCHER_TYPE_OPTIONS = [
  "Sales",
  "Purchase",
  "Receipt",
  "Payment",
  "Contra",
  "Journal",
  "Credit Note",
  "Debit Note",
  "Opening",
  "Closing",
] as const;

type Account = { id: string; code: string; name: string; accountType?: string };

type LineDraft = {
  key: string;
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  vatCode: string;
  vatAmountMinor: number;
  lineMemo: string;
  lineTags: string[];
  isAutoVatCompanion?: boolean;
};

type BooksTag = { id: string; name: string; colour: string };

type TemplateKey =
  | "blank"
  | "accrual"
  | "prepayment"
  | "depreciation"
  | "reclassification"
  | "vat_settlement";

export type CreateEntryPrefill = {
  entryDate?: string;
  memo?: string;
  reference?: string;
  voucherType?: string;
  tags?: string[];
  correctsEntryId?: string;
  lines?: Array<{
    accountId: string;
    debitMinor?: number;
    creditMinor?: number;
    lineMemo?: string;
    vatCode?: string | null;
    vatAmountMinor?: number;
    tags?: string[];
  }>;
};

const VAT_OPTIONS = ["", "SR", "ZR", "EX", "OOS", "RC"] as const;

const TYPE_LABEL: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Revenue",
  expense: "Expenses",
};

function newLineKey() {
  return `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function emptyLine(): LineDraft {
  return {
    key: newLineKey(),
    accountId: "",
    debitMinor: 0,
    creditMinor: 0,
    vatCode: "",
    vatAmountMinor: 0,
    lineMemo: "",
    lineTags: [],
  };
}

function parseAmount(raw: string): number {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!cleaned) return 0;
  const parts = cleaned.split(".");
  const fils =
    parts.length === 2
      ? Number(parts[0] || 0) * 100 + Number((parts[1] + "00").slice(0, 2))
      : Number(cleaned) * 100;
  return Math.max(0, Math.round(fils));
}

function accountByCode(accounts: Account[], code: string) {
  return accounts.find((a) => a.code === code)?.id || "";
}

function withAutoVatCompanions(lines: LineDraft[], accounts: Account[]): LineDraft[] {
  const vatIn = accountByCode(accounts, "1430");
  const vatOut = accountByCode(accounts, "2210");
  const base = lines.filter((l) => !l.isAutoVatCompanion);
  const out: LineDraft[] = [];

  for (const line of base) {
    out.push(line);
    const acct = accounts.find((a) => a.id === line.accountId);
    if (!acct || (line.vatCode !== "SR" && line.vatCode !== "RC")) continue;
    const baseMinor = line.debitMinor || line.creditMinor || 0;
    const vatAmt = line.vatAmountMinor > 0 ? line.vatAmountMinor : vatAmountForBase(baseMinor, line.vatCode);
    if (vatAmt <= 0) continue;

    if (acct.accountType === "expense" && line.debitMinor > 0 && vatIn) {
      out.push({
        key: `${line.key}-vat`,
        accountId: vatIn,
        debitMinor: vatAmt,
        creditMinor: 0,
        vatCode: "",
        vatAmountMinor: 0,
        lineMemo: `VAT on ${acct.code}`,
        lineTags: line.lineTags,
        isAutoVatCompanion: true,
      });
    }
    if (acct.accountType === "income" && line.creditMinor > 0 && vatOut) {
      out.push({
        key: `${line.key}-vat`,
        accountId: vatOut,
        debitMinor: 0,
        creditMinor: vatAmt,
        vatCode: "",
        vatAmountMinor: 0,
        lineMemo: `VAT on ${acct.code}`,
        lineTags: line.lineTags,
        isAutoVatCompanion: true,
      });
    }
  }
  return out;
}

function addMonths(dateStr: string, frequency: string, step: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (frequency === "monthly") d.setUTCMonth(d.getUTCMonth() + step);
  else if (frequency === "quarterly") d.setUTCMonth(d.getUTCMonth() + step * 3);
  else d.setUTCFullYear(d.getUTCFullYear() + step);
  return d.toISOString().slice(0, 10);
}

function AccountCombobox({
  accounts,
  value,
  onChange,
  testId,
}: {
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = accounts.find((a) => a.id === value);

  const grouped = useMemo(() => {
    const filtered = accounts.filter((a) => {
      const hay = `${a.code} ${a.name}`.toLowerCase();
      return hay.includes(q.trim().toLowerCase());
    });
    const map = new Map<string, Account[]>();
    for (const a of filtered) {
      const t = a.accountType || "other";
      if (!map.has(t)) map.set(t, []);
      map.get(t)!.push(a);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [accounts, q]);

  return (
    <>
      <select
        className="sr-only"
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
        aria-hidden
      >
        <option value="" />
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} · {a.name}
          </option>
        ))}
      </select>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="flex h-9 w-full items-center justify-start truncate rounded-md border border-border bg-background px-2 text-left text-sm font-normal hover:bg-muted/50"
          data-testid={`${testId}-trigger`}
        >
          {selected ? `${selected.code} · ${selected.name}` : "Account…"}
        </PopoverTrigger>
        <PopoverContent className="w-80 p-2" align="start">
          <Input
            placeholder="Search accounts…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="mb-2 h-8"
          />
          <div className="max-h-64 overflow-y-auto text-sm">
            {grouped.map(([type, list]) => (
              <div key={type} className="mb-2">
                <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {TYPE_LABEL[type] || type}
                </p>
                {list.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="flex w-full rounded px-2 py-1.5 text-left hover:bg-muted"
                    data-testid={`${testId}-option-${a.code}`}
                    onClick={() => {
                      onChange(a.id);
                      setOpen(false);
                      setQ("");
                    }}
                  >
                    <span className="tabular-nums text-muted-foreground">{a.code}</span>
                    <span className="ml-2 truncate">{a.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

export function CreateEntrySheet({
  open,
  onOpenChange,
  periodId,
  accounts,
  onCreated,
  prefill,
  editEntryId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  periodId: string;
  accounts: Account[];
  onCreated: (entryId: string) => void;
  prefill?: CreateEntryPrefill | null;
  /** When set, save uses PATCH replace instead of create. */
  editEntryId?: string | null;
}) {
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [voucherType, setVoucherType] = useState<string>("Journal");
  const [correctsEntryId, setCorrectsEntryId] = useState<string | null>(null);
  const [entryTags, setEntryTags] = useState<string[]>([]);
  const [tagQuery, setTagQuery] = useState("");
  const [tagCatalog, setTagCatalog] = useState<BooksTag[]>([]);
  const [lines, setLines] = useState<LineDraft[]>(() => [emptyLine(), emptyLine()]);
  const [template, setTemplate] = useState<TemplateKey>("blank");
  const [schedule, setSchedule] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [recurringFreq, setRecurringFreq] = useState<"monthly" | "quarterly" | "yearly">("monthly");
  const [recurringStart, setRecurringStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [recurringOccurrences, setRecurringOccurrences] = useState(12);
  const [autoReverse, setAutoReverse] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<Array<{ fileId: string; name: string }>>([]);
  const [dismissedVatKeys, setDismissedVatKeys] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [vatPaymentHint, setVatPaymentHint] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/books/tags")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setTagCatalog(data);
      })
      .catch(() => undefined);
  }, [open]);

  useEffect(() => {
    if (!open || !prefill) return;
    if (prefill.entryDate) setEntryDate(prefill.entryDate);
    if (prefill.memo) setDescription(prefill.memo);
    if (prefill.reference != null) setReference(prefill.reference);
    if (prefill.voucherType) setVoucherType(prefill.voucherType);
    if (prefill.tags) setEntryTags(prefill.tags);
    if (prefill.correctsEntryId) setCorrectsEntryId(prefill.correctsEntryId);
    if (prefill.lines?.length) {
      setLines(
        prefill.lines.map((l) => ({
          ...emptyLine(),
          accountId: l.accountId,
          debitMinor: l.debitMinor || 0,
          creditMinor: l.creditMinor || 0,
          lineMemo: l.lineMemo || "",
          vatCode: l.vatCode || "",
          vatAmountMinor: l.vatAmountMinor || 0,
          lineTags: l.tags || [],
        })),
      );
    }
  }, [open, prefill]);

  const displayLines = useMemo(() => {
    const generated = withAutoVatCompanions(
      lines.filter((l) => !l.isAutoVatCompanion),
      accounts,
    );
    return generated.filter((l) => {
      if (!l.isAutoVatCompanion) return true;
      const parentKey = l.key.replace(/-vat$/, "");
      return !dismissedVatKeys.has(parentKey);
    });
  }, [lines, accounts, dismissedVatKeys]);

  const { debit, credit, balanced, emptyTotals } = useMemo(() => {
    let d = 0;
    let c = 0;
    for (const line of displayLines) {
      d += line.debitMinor;
      c += line.creditMinor;
    }
    return {
      debit: d,
      credit: c,
      balanced: d === c && d > 0,
      emptyTotals: d === 0 && c === 0,
    };
  }, [displayLines]);

  const recurringPreview = useMemo(() => {
    if (!recurring) return [];
    const n = Math.min(6, Math.max(1, recurringOccurrences));
    return Array.from({ length: n }, (_, i) => addMonths(recurringStart, recurringFreq, i));
  }, [recurring, recurringOccurrences, recurringStart, recurringFreq]);

  const applyTemplate = useCallback(
    async (key: TemplateKey) => {
      setTemplate(key);
      setVatPaymentHint("");
      if (key === "blank") {
        setLines([emptyLine(), emptyLine()]);
        return;
      }
      if (key === "vat_settlement") {
        if (!periodId) {
          setError("Select a period for VAT settlement.");
          return;
        }
        const res = await fetch(`/api/books/vat-settlement?periodId=${periodId}`);
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Could not load VAT balances");
          return;
        }
        setDescription(String(data.returnEntry?.memo || "VAT return"));
        setVoucherType("Journal");
        setEntryTags(["vat"]);
        const rl = Array.isArray(data.returnEntry?.lines) ? data.returnEntry.lines : [];
        setLines(
          rl.length
            ? rl.map(
                (l: {
                  accountId: string;
                  debitMinor: number;
                  creditMinor: number;
                  lineMemo: string;
                }) => ({
                  ...emptyLine(),
                  accountId: l.accountId,
                  debitMinor: l.debitMinor,
                  creditMinor: l.creditMinor,
                  lineMemo: l.lineMemo,
                  lineTags: ["vat"],
                }),
              )
            : [emptyLine(), emptyLine()],
        );
        if (data.paymentEntry) {
          setVatPaymentHint(
            `After posting the return, create payment: ${data.paymentEntry.memo} (${formatMinor(Number(data.payableMinor || 0))} AED).`,
          );
        }
        return;
      }
      const bank = accountByCode(accounts, "1120");
      const rent = accountByCode(accounts, "6200");
      const accrued = accountByCode(accounts, "2120");
      const prepaid = accountByCode(accounts, "1410");
      const depr = accountByCode(accounts, "6800");
      const accumDepr = accountByCode(accounts, "1690");
      const office = accountByCode(accounts, "6600");
      const rev = accountByCode(accounts, "4100");

      if (key === "accrual") {
        setDescription("Accrual");
        setLines([
          { ...emptyLine(), accountId: rent, debitMinor: 0, creditMinor: 0 },
          { ...emptyLine(), accountId: accrued, debitMinor: 0, creditMinor: 0 },
        ]);
      } else if (key === "prepayment") {
        setDescription("Prepayment");
        setLines([
          { ...emptyLine(), accountId: prepaid, debitMinor: 0 },
          { ...emptyLine(), accountId: bank, creditMinor: 0 },
        ]);
      } else if (key === "depreciation") {
        setDescription("Depreciation");
        setLines([
          { ...emptyLine(), accountId: depr, debitMinor: 0 },
          { ...emptyLine(), accountId: accumDepr, creditMinor: 0 },
        ]);
      } else if (key === "reclassification") {
        setDescription("Reclassification");
        setLines([
          { ...emptyLine(), accountId: office, debitMinor: 0 },
          { ...emptyLine(), accountId: rev, creditMinor: 0 },
        ]);
      }
    },
    [accounts, periodId],
  );

  function updateLineByKey(key: string, patch: Partial<LineDraft>) {
    const base = lines.filter((l) => !l.isAutoVatCompanion);
    const inBase = base.findIndex((l) => l.key === key);
    if (inBase >= 0) {
      if (patch.vatCode !== undefined || patch.debitMinor !== undefined || patch.creditMinor !== undefined) {
        setDismissedVatKeys((d) => {
          const next = new Set(d);
          next.delete(base[inBase].key);
          return next;
        });
      }
      setLines(
        base.map((l, i) => {
          if (i !== inBase) return l;
          const merged = { ...l, ...patch };
          const baseMinor = merged.debitMinor || merged.creditMinor || 0;
          if (patch.vatAmountMinor === undefined) {
            merged.vatAmountMinor = vatAmountForBase(baseMinor, merged.vatCode);
          }
          return merged;
        }),
      );
      return;
    }
    const companion = displayLines.find((l) => l.key === key);
    if (!companion) return;
    setDismissedVatKeys((d) => new Set(d).add(companion.key.replace(/-vat$/, "")));
    setLines([
      ...base,
      {
        ...companion,
        ...patch,
        isAutoVatCompanion: false,
        key: newLineKey(),
      },
    ]);
  }

  function removeLineByKey(key: string) {
    const line = displayLines.find((l) => l.key === key);
    if (line?.isAutoVatCompanion) {
      setDismissedVatKeys((d) => new Set(d).add(key.replace(/-vat$/, "")));
      return;
    }
    setLines((prev) => {
      const base = prev.filter((l) => !l.isAutoVatCompanion && l.key !== key);
      return base.length >= 2 ? base : [...base, emptyLine()];
    });
  }

  function addTag(name: string) {
    const t = name.trim();
    if (!t || entryTags.includes(t)) return;
    setEntryTags((prev) => [...prev, t]);
    setTagQuery("");
  }

  async function onPickFiles(files: FileList | null) {
    if (!files?.length) return;
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      form.append("filename", file.name);
      const res = await fetch("/api/books/attachments", { method: "POST", body: form });
      const payload = await res.json();
      if (res.ok && payload.fileId) {
        setPendingFiles((prev) => [...prev, { fileId: String(payload.fileId), name: file.name }]);
      }
    }
  }

  async function submit(post: boolean) {
    setError("");
    if (!periodId) {
      setError("Select a period in the top bar.");
      return;
    }
    if (!balanced) {
      setError("Entry must balance before saving.");
      return;
    }
    const payloadLines = displayLines
      .filter((l) => l.accountId && (l.debitMinor > 0 || l.creditMinor > 0))
      .map((l) => ({
        accountId: l.accountId,
        debitMinor: l.debitMinor || undefined,
        creditMinor: l.creditMinor || undefined,
        lineMemo: l.lineMemo || undefined,
        vatCode: l.isAutoVatCompanion ? null : l.vatCode || null,
        vatAmountMinor: l.isAutoVatCompanion ? undefined : l.vatAmountMinor || undefined,
        isVatCompanion: Boolean(l.isAutoVatCompanion),
        tags: [...new Set([...entryTags, ...l.lineTags])],
      }));
    if (payloadLines.length < 2) {
      setError("Add at least two lines with accounts and amounts.");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        periodId,
        entryDate,
        reference,
        memo: description,
        voucherType,
        correctsEntryId,
        tags: entryTags,
        post: Boolean(post && !schedule && !editEntryId),
        scheduledFor: schedule ? scheduledFor || entryDate : null,
        autoReverseNextPeriod: autoReverse,
        templateKey: template === "blank" ? null : template,
        recurring: recurring
          ? {
              frequency: recurringFreq,
              startDate: recurringStart,
              occurrences: recurringOccurrences,
            }
          : null,
        attachmentFileIds: pendingFiles.map((f) => f.fileId),
        lines: payloadLines,
      };
      // Dual-control: never post as the preparer in the same request.
      const createBody = { ...body, post: false };
      const res = editEntryId
        ? await fetch(`/api/books/journals/${editEntryId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(createBody),
          })
        : await fetch("/api/books/journals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(createBody),
          });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || payload.message || "create_failed");
      const entryId = String(payload.id);
      if (post && !schedule && !editEntryId) {
        const postRes = await fetch(`/api/books/journals/${entryId}/post`, { method: "POST" });
        const postPayload = await postRes.json().catch(() => ({}));
        if (!postRes.ok) {
          setError(
            postPayload.error === "post_preparer_cannot_approve" ||
              postPayload.error === "post_requires_approver"
              ? "Saved as draft — an approver must post (preparer ≠ approver)."
              : String(postPayload.error || "post_failed"),
          );
          onCreated(entryId);
          setSubmitting(false);
          return;
        }
      }
      onCreated(entryId);
      onOpenChange(false);
      setDescription("");
      setReference("");
      setVoucherType("Journal");
      setCorrectsEntryId(null);
      setEntryTags([]);
      setLines([emptyLine(), emptyLine()]);
      setPendingFiles([]);
      setSchedule(false);
      setRecurring(false);
      setVatPaymentHint("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "create_failed");
    } finally {
      setSubmitting(false);
    }
  }

  const tagSuggestions = tagCatalog.filter(
    (t) =>
      t.name.toLowerCase().includes(tagQuery.toLowerCase()) &&
      !entryTags.includes(t.name) &&
      tagQuery.trim(),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex h-full w-full flex-col gap-0 overflow-hidden p-0 sm:min-w-[900px] sm:max-w-[900px] max-xl:w-full xl:min-w-[900px] [&>button]:top-6 [&>button]:right-6"
        data-testid="create-entry-sheet"
      >
        <SheetHeader className="shrink-0 border-b border-border px-6 py-4">
          <SheetTitle>Create journal entry</SheetTitle>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mb-4 flex flex-wrap gap-2">
            {(
              [
                ["blank", "Blank"],
                ["accrual", "Accrual"],
                ["prepayment", "Prepayment"],
                ["depreciation", "Depreciation"],
                ["reclassification", "Reclassification"],
                ["vat_settlement", "VAT settlement"],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={template === key ? "default" : "outline"}
                onClick={() => void applyTemplate(key)}
              >
                {label}
              </Button>
            ))}
          </div>
          {vatPaymentHint ? (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="vat-settlement-hint">
              {vatPaymentHint}
            </p>
          ) : null}

          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <Label htmlFor="ce-date">Date</Label>
              <BooksDateInput
                id="ce-date"
                data-testid="create-entry-date"
                value={entryDate}
                onChange={setEntryDate}
              />
            </div>
            <div>
              <Label htmlFor="ce-voucher">Voucher type</Label>
              <select
                id="ce-voucher"
                className="mt-0 flex h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={voucherType}
                onChange={(e) => setVoucherType(e.target.value)}
                data-testid="create-entry-voucher-type"
              >
                {VOUCHER_TYPE_OPTIONS.map((vt) => (
                  <option key={vt} value={vt}>
                    {vt}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="ce-ref">Reference</Label>
              <Input
                id="ce-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Invoice #, cheque #…"
              />
            </div>
          </div>

          <div className="mt-4">
            <Label htmlFor="ce-desc">Description</Label>
            <Textarea
              id="ce-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this entry is for"
              rows={2}
            />
          </div>

          <div className="mt-4">
            <Label>Tags</Label>
            <div className="mt-1 flex flex-wrap gap-1 rounded-md border border-border p-2">
              {entryTags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {t}
                  <button type="button" aria-label={`Remove ${t}`} onClick={() => setEntryTags((p) => p.filter((x) => x !== t))}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <Input
                id="ce-tags"
                className="h-7 min-w-[120px] flex-1 border-0 shadow-none focus-visible:ring-0"
                value={tagQuery}
                placeholder="Add tag…"
                onChange={(e) => setTagQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag(tagQuery);
                  }
                }}
              />
            </div>
            {tagSuggestions.length ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {tagSuggestions.slice(0, 8).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted"
                    onClick={() => addTag(t.name)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="mt-4">
            <Label>Attachments</Label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                onChange={(e) => void onPickFiles(e.target.files)}
              />
              <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Paperclip className="size-4" />
                Upload
              </Button>
              {pendingFiles.map((f) => (
                <span key={f.fileId} className="text-xs text-muted-foreground">
                  {f.name}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <Label>Lines</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLines((prev) => [...prev.filter((l) => !l.isAutoVatCompanion), emptyLine()])}
              >
                <Plus className="size-4" />
                Add line
              </Button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[1100px] text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="w-8 px-2 py-2 text-left">#</th>
                    <th className="min-w-[180px] px-2 py-2 text-left">Account</th>
                    <th className="min-w-[220px] px-2 py-2 text-left">Line description</th>
                    <th className="min-w-[110px] px-2 py-2 text-right">Debit</th>
                    <th className="min-w-[110px] px-2 py-2 text-right">Credit</th>
                    <th className="min-w-[110px] px-2 py-2 text-left">VAT code</th>
                    <th className="min-w-[110px] px-2 py-2 text-right">VAT amount</th>
                    <th className="min-w-[100px] px-2 py-2 text-left">Tags</th>
                    <th className="w-10 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {displayLines.map((line, idx) => {
                    const rowNum = line.isAutoVatCompanion ? "VAT" : idx + 1;
                    return (
                      <tr
                        key={line.key}
                        className={cn("border-t border-border", line.isAutoVatCompanion && "bg-muted/20")}
                        data-testid="create-entry-line"
                      >
                        <td className="px-2 py-1 tabular-nums text-muted-foreground text-xs">{rowNum}</td>
                        <td className="px-2 py-1">
                          <AccountCombobox
                            accounts={accounts}
                            value={line.accountId}
                            onChange={(id) => updateLineByKey(line.key, { accountId: id })}
                            testId="create-entry-account"
                          />
                        </td>
                        <td className="px-2 py-1 min-w-[220px]">
                          <Input
                            className="h-8 min-w-[200px] text-xs"
                            value={line.lineMemo}
                            placeholder="e.g. VAT on 4100 Service revenue"
                            onChange={(e) => updateLineByKey(line.key, { lineMemo: e.target.value })}
                          />
                        </td>
                        <td className="px-2 py-1 min-w-[110px]">
                          <Input
                            className="h-8 min-w-[110px] tabular-nums text-right"
                            placeholder="Debit"
                            data-testid="create-entry-debit"
                            defaultValue={line.debitMinor ? (line.debitMinor / 100).toFixed(2) : ""}
                            key={`d-${line.key}-${line.debitMinor}`}
                            onBlur={(e) =>
                              updateLineByKey(line.key, {
                                debitMinor: parseAmount(e.target.value),
                                creditMinor: 0,
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1 min-w-[110px]">
                          <Input
                            className="h-8 min-w-[110px] tabular-nums text-right"
                            placeholder="Credit"
                            data-testid="create-entry-credit"
                            defaultValue={line.creditMinor ? (line.creditMinor / 100).toFixed(2) : ""}
                            key={`c-${line.key}-${line.creditMinor}`}
                            onBlur={(e) =>
                              updateLineByKey(line.key, {
                                creditMinor: parseAmount(e.target.value),
                                debitMinor: 0,
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1 min-w-[110px]">
                          <select
                            className="h-8 w-full min-w-[110px] rounded-md border border-border bg-background px-1 text-xs"
                            data-testid="create-entry-vat"
                            disabled={line.isAutoVatCompanion}
                            value={line.vatCode}
                            onChange={(e) => updateLineByKey(line.key, { vatCode: e.target.value })}
                          >
                            {VAT_OPTIONS.map((o) => (
                              <option key={o || "none"} value={o}>
                                {vatCodeLabel(o)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1 min-w-[110px]">
                          <Input
                            className="h-8 min-w-[100px] tabular-nums text-right text-xs"
                            data-testid="create-entry-vat-amount"
                            disabled={line.isAutoVatCompanion}
                            defaultValue={line.vatAmountMinor ? (line.vatAmountMinor / 100).toFixed(2) : ""}
                            key={`v-${line.key}-${line.vatAmountMinor}`}
                            onBlur={(e) =>
                              updateLineByKey(line.key, { vatAmountMinor: parseAmount(e.target.value) })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <Input
                            className="h-8 text-xs"
                            placeholder="tags"
                            value={line.lineTags.join(", ")}
                            onChange={(e) =>
                              updateLineByKey(line.key, {
                                lineTags: e.target.value
                                  .split(",")
                                  .map((t) => t.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={!line.isAutoVatCompanion && lines.filter((l) => !l.isAutoVatCompanion).length <= 2}
                            onClick={() => removeLineByKey(line.key)}
                            aria-label="Remove line"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} />
              Schedule for later post
            </label>
            {schedule ? (
              <BooksDateInput
                data-testid="create-entry-scheduled-for"
                value={scheduledFor}
                onChange={setScheduledFor}
              />
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
              Recurring entry
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={autoReverse} onChange={(e) => setAutoReverse(e.target.checked)} />
              Auto-reverse next period
            </label>
          </div>

          {recurring ? (
            <div className="mt-2 grid gap-2 rounded-md border border-border p-3 text-sm md:grid-cols-3">
              <div>
                <Label>Frequency</Label>
                <select
                  className="mt-1 h-9 w-full rounded-md border border-border px-2"
                  value={recurringFreq}
                  onChange={(e) => setRecurringFreq(e.target.value as typeof recurringFreq)}
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              <div>
                <Label>Start</Label>
                <BooksDateInput value={recurringStart} onChange={setRecurringStart} />
              </div>
              <div>
                <Label>Occurrences</Label>
                <Input
                  type="number"
                  min={1}
                  max={120}
                  value={recurringOccurrences}
                  onChange={(e) => setRecurringOccurrences(Number(e.target.value) || 1)}
                />
              </div>
              <p className="md:col-span-3 text-xs text-muted-foreground">
                Preview: {recurringPreview.join(", ")}
                {recurringOccurrences > 6 ? "…" : ""}
              </p>
            </div>
          ) : null}

          {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
        </div>

        <div
          className="sticky bottom-0 shrink-0 border-t border-border bg-background px-6 py-4"
          data-testid="create-entry-footer"
        >
          <div
            className={cn(
              "mb-3 rounded-md border px-3 py-2 text-sm tabular-nums",
              emptyTotals
                ? "border-border bg-muted/40 text-muted-foreground"
                : balanced
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-red-200 bg-red-50 text-red-800",
            )}
            data-testid="create-entry-balance"
          >
            {emptyTotals
              ? `Dr ${formatMinor(0)} · Cr ${formatMinor(0)}`
              : balanced
                ? `Dr ${formatMinor(debit)} · Cr ${formatMinor(credit)} · Balanced`
                : `Dr ${formatMinor(debit)} · Cr ${formatMinor(credit)} · Out of balance by ${formatMinor(Math.abs(debit - credit))}`}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="secondary" disabled={submitting || !balanced} onClick={() => void submit(false)}>
              Save draft
            </Button>
            <Button disabled={submitting || !balanced} onClick={() => void submit(true)} data-testid="create-journal">
              {submitting ? "Saving…" : "Post"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
