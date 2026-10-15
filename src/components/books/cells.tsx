"use client";

import { cn } from "@/lib/utils";
import { formatDateUae } from "@/lib/date";
import { formatMinor } from "@/lib/money";

const VAT_TAX_CODES = new Set(["1430", "2210"]);

export function CellDate({ value }: { value: string }) {
  return <span className="text-sm text-foreground whitespace-nowrap">{formatDateUae(value)}</span>;
}

export function CellEntryId({
  entryNo,
  reference,
  id: _id,
}: {
  entryNo?: string | null;
  reference?: string | null;
  id: string;
}) {
  const label = entryNo || reference || "—";
  return (
    <span className="inline-flex max-w-full truncate rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-foreground" title={label}>
      {label}
    </span>
  );
}

export type AccountCell = { code: string; name: string; vatTreatment?: string | null };

export function CellAccount({
  account,
  lineCount,
}: {
  account: AccountCell | null | undefined;
  /** When > 1, show CrossVal-style "Split (n lines)" instead of a single account. */
  lineCount?: number;
}) {
  if (lineCount != null && lineCount > 1) {
    return (
      <span className="text-sm text-muted-foreground" data-testid="account-split">
        Split ({lineCount} lines)
      </span>
    );
  }
  if (!account?.code) return <span className="text-muted-foreground">—</span>;
  const showVat = VAT_TAX_CODES.has(account.code);
  return (
    <div className="min-w-0 max-w-[200px]" title={`${account.code} · ${account.name}`}>
      <div className="truncate text-sm font-medium text-foreground">{account.name}</div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono">{account.code}</span>
        {showVat ? (
          <span className="rounded bg-amber-50 px-1 py-0 text-[10px] font-medium uppercase text-amber-800 border border-amber-200">
            Tax
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function CellAmount({ minor }: { minor: number }) {
  return (
    <span className="block text-right text-sm font-medium tabular-nums text-foreground">
      {formatMinor(minor)} <span className="text-xs font-normal text-muted-foreground">AED</span>
    </span>
  );
}

const TYPE_STYLES: Record<string, string> = {
  auto: "bg-blue-50 text-blue-700 border-blue-200",
  manual: "bg-gray-100 text-gray-700 border-gray-200",
  closing: "bg-purple-50 text-purple-700 border-purple-200",
  opening: "bg-gray-100 text-gray-700 border-gray-200",
  reversal: "bg-gray-100 text-gray-600 border-gray-200",
};

export function CellTypePill({ entryType }: { entryType: string }) {
  const key = entryType?.toLowerCase() || "manual";
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        TYPE_STYLES[key] || TYPE_STYLES.manual,
      )}
    >
      {key}
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  posted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  draft: "bg-amber-50 text-amber-800 border-amber-200",
  scheduled: "bg-amber-50 text-amber-800 border-amber-200",
  reversed: "bg-gray-100 text-gray-600 border-gray-200",
  blocked: "bg-red-50 text-red-700 border-red-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

export function CellStatusPill({ status }: { status: string }) {
  const key = status?.toLowerCase() || "draft";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium capitalize whitespace-nowrap",
        STATUS_STYLES[key] || STATUS_STYLES.draft,
      )}
    >
      {key}
    </span>
  );
}

export function CellTags({ tags }: { tags: string[] }) {
  if (!tags?.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1 min-w-[88px]">
      {tags.slice(0, 3).map((tag) => (
        <span key={tag} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
          {tag}
        </span>
      ))}
      {tags.length > 3 ? <span className="text-xs text-muted-foreground">+{tags.length - 3}</span> : null}
    </div>
  );
}

export function CellReadMore({ text, max = 56 }: { text: string; max?: number }) {
  const value = (text || "—").replace(/\u2014|\u2013/g, "-");
  if (value.length <= max) return <span className="text-sm break-words">{value}</span>;
  return (
    <span className="text-sm break-words" title={value}>
      {value.slice(0, max)}…
    </span>
  );
}

export function CellAvatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className="inline-flex size-7 items-center justify-center rounded-full bg-primary-subtle text-xs font-medium text-primary"
      title={name}
    >
      {initials || "?"}
    </span>
  );
}

export function CellScorePill({ score }: { score: number }) {
  const tone =
    score >= 80 ? "bg-emerald-50 text-emerald-700" : score >= 50 ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700";
  return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium tabular-nums", tone)}>{score}</span>;
}
