"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  Bookmark,
  ChevronDown,
  Filter,
  Search,
  Tag,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { BooksDateInput } from "@/components/books/date-input";
import {
  EMPTY_LEDGER_FILTERS,
  ENTRY_STATUSES,
  ENTRY_TYPES,
  VOUCHER_TYPE_FILTERS,
  type LedgerFilterState,
  type SavedViewConfig,
} from "@/components/books/ledger-filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { csvCell } from "@/lib/csv";
import { cn } from "@/lib/utils";

type TagRow = { id: string; name: string; colour: string; usageCount?: number };
type UserRow = { id: string; name: string; role?: string };
type AccountRow = { id: string; code: string; name: string };
type SavedView = { id: string; name: string; scope: string; config: SavedViewConfig };

export type LedgerToolbarProps = {
  periodId: string;
  toolbarSearch: string;
  onToolbarSearchChange: (q: string) => void;
  types: string[];
  onTypesChange: (types: string[]) => void;
  statuses: string[];
  onStatusesChange: (statuses: string[]) => void;
  drawerFilters: LedgerFilterState;
  onDrawerFiltersChange: (f: LedgerFilterState) => void;
  appliedFilters: LedgerFilterState;
  onApplyFilters: (f: LedgerFilterState) => void;
  rowCount?: number;
  selectionMode: boolean;
  onSelectionModeChange: (on: boolean) => void;
  selectedIds: string[];
  selectedRows: Array<{
    id: string;
    entryNo?: string | null;
    description?: string;
    memo?: string;
    entryDate: string;
    status: string;
    entryType: string;
    amount: number;
    tags: string[];
  }>;
  onBulkDone: () => void;
  currentUserId?: string;
  isAdmin?: boolean;
};

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-xs">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`}>
        <X className="size-3" />
      </button>
    </span>
  );
}

function ManageTagsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [newName, setNewName] = useState("");
  const [newColour, setNewColour] = useState("#6B7280");
  const [mergeSource, setMergeSource] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");

  const reload = useCallback(async () => {
    const list = await fetch("/api/books/tags").then((r) => r.json());
    if (Array.isArray(list)) setTags(list);
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage tags</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-auto">
          <ul className="space-y-2 text-sm">
            {tags.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5">
                <span className="size-3 rounded-full" style={{ background: t.colour }} />
                <Input
                  className="h-8 flex-1 min-w-[120px]"
                  defaultValue={t.name}
                  onBlur={async (e) => {
                    const name = e.target.value.trim();
                    if (!name || name === t.name) return;
                    await fetch(`/api/books/tags/${t.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name }),
                    });
                    void reload();
                  }}
                />
                <Input
                  type="color"
                  className="h-8 w-12 p-0"
                  defaultValue={t.colour}
                  onChange={async (e) => {
                    await fetch(`/api/books/tags/${t.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ colour: e.target.value }),
                    });
                    void reload();
                  }}
                />
                <span className="text-xs text-muted-foreground tabular-nums">{t.usageCount ?? 0} uses</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={async () => {
                    await fetch(`/api/books/tags/${t.id}`, { method: "DELETE" });
                    void reload();
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input placeholder="New tag name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Input type="color" className="w-12" value={newColour} onChange={(e) => setNewColour(e.target.value)} />
            <Button
              onClick={async () => {
                if (!newName.trim()) return;
                await fetch("/api/books/tags", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: newName.trim(), colour: newColour }),
                });
                setNewName("");
                void reload();
              }}
            >
              Add
            </Button>
          </div>
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted-foreground">Merge tags</p>
            <div className="flex flex-wrap gap-2">
              <select
                className="h-9 rounded-md border border-border px-2 text-sm"
                value={mergeSource}
                onChange={(e) => setMergeSource(e.target.value)}
              >
                <option value="">Source…</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <span className="self-center text-xs text-muted-foreground">into</span>
              <select
                className="h-9 rounded-md border border-border px-2 text-sm"
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
              >
                <option value="">Target…</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                disabled={!mergeSource || !mergeTarget}
                onClick={async () => {
                  await fetch("/api/books/tags/merge", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sourceTagId: mergeSource, targetTagId: mergeTarget }),
                  });
                  setMergeSource("");
                  setMergeTarget("");
                  void reload();
                }}
              >
                Merge
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function LedgerToolbar({
  periodId: _periodId,
  toolbarSearch,
  onToolbarSearchChange,
  types,
  onTypesChange,
  statuses,
  onStatusesChange,
  drawerFilters,
  onDrawerFiltersChange,
  appliedFilters,
  onApplyFilters,
  rowCount,
  selectionMode,
  onSelectionModeChange,
  selectedIds,
  selectedRows,
  onBulkDone,
  isAdmin,
}: LedgerToolbarProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState(drawerFilters);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseDate, setReverseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagMode, setBulkTagMode] = useState<"add" | "remove">("add");
  const [bulkTagName, setBulkTagName] = useState("");

  useEffect(() => {
    if (filtersOpen) setDraftFilters(drawerFilters);
  }, [filtersOpen, drawerFilters]);

  useEffect(() => {
    fetch("/api/books/accounts?postableOnly=1")
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list)) setAccounts(list);
      })
      .catch(() => undefined);
    fetch("/api/books/users")
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list)) setUsers(list);
      })
      .catch(() => undefined);
    fetch("/api/books/tags")
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list)) setTagNames(list.map((t: TagRow) => t.name));
      })
      .catch(() => undefined);
    fetch("/api/books/saved-views")
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list)) setSavedViews(list);
      })
      .catch(() => undefined);
  }, []);

  const filterChips = useMemo(() => {
    const chips: { key: string; label: string; clear: () => void }[] = [];
    const f = appliedFilters;
    if (f.fromDate) {
      chips.push({
        key: "from",
        label: `From ${f.fromDate}`,
        clear: () => onApplyFilters({ ...f, fromDate: "" }),
      });
    }
    if (f.toDate) {
      chips.push({
        key: "to",
        label: `To ${f.toDate}`,
        clear: () => onApplyFilters({ ...f, toDate: "" }),
      });
    }
    if (f.accountIds.length) {
      chips.push({
        key: "accounts",
        label: `${f.accountIds.length} account(s)`,
        clear: () => onApplyFilters({ ...f, accountIds: [] }),
      });
    }
    if (f.amountMin || f.amountMax) {
      chips.push({
        key: "amount",
        label: `Amount ${f.amountMin || "…"} – ${f.amountMax || "…"}`,
        clear: () => onApplyFilters({ ...f, amountMin: "", amountMax: "" }),
      });
    }
    if (f.createdBy) {
      const u = users.find((x) => x.id === f.createdBy);
      chips.push({
        key: "created",
        label: `Created by ${u?.name || f.createdBy.slice(0, 8)}`,
        clear: () => onApplyFilters({ ...f, createdBy: "" }),
      });
    }
    if (f.postedBy) {
      const u = users.find((x) => x.id === f.postedBy);
      chips.push({
        key: "posted",
        label: `Posted by ${u?.name || f.postedBy.slice(0, 8)}`,
        clear: () => onApplyFilters({ ...f, postedBy: "" }),
      });
    }
    f.tags.forEach((t) => {
      chips.push({
        key: `tag-${t}`,
        label: `Tag: ${t}`,
        clear: () => onApplyFilters({ ...f, tags: f.tags.filter((x) => x !== t) }),
      });
    });
    if (f.hasAttachment === "yes") {
      chips.push({
        key: "attach-y",
        label: "Has attachment",
        clear: () => onApplyFilters({ ...f, hasAttachment: "" }),
      });
    }
    if (f.hasAttachment === "no") {
      chips.push({
        key: "attach-n",
        label: "No attachment",
        clear: () => onApplyFilters({ ...f, hasAttachment: "" }),
      });
    }
    return chips;
  }, [appliedFilters, onApplyFilters, users]);

  async function exportCsv() {
    const header = ["Date", "Entry ID", "Description", "Amount (fils)", "Type", "Status", "Tags"];
    const lines = selectedRows.length
      ? selectedRows
      : [];
    if (!lines.length) {
      toast.error("Select rows to export, or use selection mode.");
      return;
    }
    const body = lines.map((r) =>
      [
        csvCell(r.entryDate),
        csvCell(r.entryNo || r.id),
        csvCell(r.description || r.memo || ""),
        csvCell(String(r.amount)),
        csvCell(r.entryType),
        csvCell(r.status),
        csvCell((r.tags || []).join("; ")),
      ].join(","),
    );
    const csv = [header.join(","), ...body].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "journal-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-9"
            placeholder="Search description, entry ID, amount, account…"
            value={toolbarSearch}
            onChange={(e) => onToolbarSearchChange(e.target.value)}
            data-testid="ledger-toolbar-search"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => setFiltersOpen(true)} data-testid="ledger-filters-open">
          <Filter className="size-4" />
          Filters
          {filterChips.length ? (
            <Badge variant="secondary" className="ml-1 rounded-full px-1.5 text-[10px]">
              {filterChips.length}
            </Badge>
          ) : null}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setTagsOpen(true)}>
          <Tag className="size-4" />
          Manage Tags
        </Button>
        <Popover>
          <PopoverTrigger render={<Button variant="outline" size="sm" />}>
            <BookOpen className="size-4" />
            Guide
          </PopoverTrigger>
          <PopoverContent className="w-80 text-sm" align="start">
            <p className="font-medium">Entry types</p>
            <ul className="mt-1 list-disc pl-4 text-muted-foreground">
              <li>Manual — accountant-created journals</li>
              <li>Auto — system-generated from rules/imports</li>
              <li>Opening / Closing — period boundary entries</li>
              <li>Reversal — negates a prior posted entry (immutable original)</li>
            </ul>
            <p className="mt-3 font-medium">Statuses</p>
            <ul className="mt-1 list-disc pl-4 text-muted-foreground">
              <li>Draft — editable, not in trial balance</li>
              <li>Posted — locked lines, affects balances</li>
              <li>Reversed — original entry superseded by reversal pair</li>
              <li>Scheduled — will post on scheduled date</li>
              <li>Blocked — schedule could not post (period locked)</li>
            </ul>
          </PopoverContent>
        </Popover>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" data-testid="ledger-type-filter" />}
          >
            Type{types.length ? ` (${types.length})` : ""}
            <ChevronDown className="ml-1 size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {ENTRY_TYPES.map((t) => (
              <DropdownMenuCheckboxItem
                key={t}
                checked={types.includes(t)}
                onCheckedChange={(checked) => {
                  onTypesChange(checked ? [...types, t] : types.filter((x) => x !== t));
                }}
              >
                <span className="capitalize">{t}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" data-testid="ledger-status-filter" />}
          >
            Status{statuses.length ? ` (${statuses.length})` : ""}
            <ChevronDown className="ml-1 size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {ENTRY_STATUSES.map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={statuses.includes(s)}
                onCheckedChange={(checked) => {
                  onStatusesChange(checked ? [...statuses, s] : statuses.filter((x) => x !== s));
                }}
              >
                <span className="capitalize">{s}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <Bookmark className="size-4" />
            Views
            <ChevronDown className="ml-1 size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {savedViews.length === 0 ? (
              <DropdownMenuItem disabled>No saved views</DropdownMenuItem>
            ) : (
              savedViews.map((v) => (
                <DropdownMenuItem
                  key={v.id}
                  onClick={() => {
                    const cfg = (v.config || {}) as SavedViewConfig;
                    if (cfg.search != null) onToolbarSearchChange(cfg.search);
                    if (cfg.types) onTypesChange(cfg.types);
                    if (cfg.statuses) onStatusesChange(cfg.statuses);
                    if (cfg.filters) onApplyFilters(cfg.filters);
                  }}
                >
                  {v.name}
                  <span className="ml-auto text-[10px] uppercase text-muted-foreground">{v.scope}</span>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={async () => {
                const name = window.prompt("View name");
                if (!name?.trim()) return;
                await fetch("/api/books/saved-views", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name: name.trim(),
                    scope: "personal",
                    config: {
                      search: toolbarSearch,
                      types,
                      statuses,
                      filters: appliedFilters,
                    },
                  }),
                });
                const list = await fetch("/api/books/saved-views").then((r) => r.json());
                if (Array.isArray(list)) setSavedViews(list);
                toast.success("View saved");
              }}
            >
              Save current view…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant={selectionMode ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onSelectionModeChange(!selectionMode)}
          data-testid="ledger-select-rows"
        >
          {selectionMode ? "Done selecting" : "Select rows"}
        </Button>
        {typeof rowCount === "number" ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{rowCount} rows</span>
        ) : null}
      </div>

      {filterChips.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {filterChips.map((c) => (
            <FilterChip key={c.key} label={c.label} onRemove={c.clear} />
          ))}
          <Button
            variant="link"
            size="sm"
            className="h-auto px-1 text-xs"
            onClick={() => onApplyFilters(EMPTY_LEDGER_FILTERS)}
          >
            Clear all
          </Button>
        </div>
      ) : null}

      {selectionMode && selectedIds.length > 0 ? (
        <div
          className="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2 shadow-md"
          data-testid="books-bulk-bar"
        >
          <span className="text-sm">{selectedIds.length} selected</span>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setBulkTagMode("add");
                setBulkTagOpen(true);
              }}
            >
              Add tag
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setBulkTagMode("remove");
                setBulkTagOpen(true);
              }}
            >
              Remove tag
            </Button>
            <Button size="sm" variant="outline" onClick={() => void exportCsv()}>
              Export CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!isAdmin}
              title={isAdmin ? undefined : "Approver or admin only"}
              onClick={() => setReverseOpen(true)}
              data-testid="ledger-bulk-reverse"
            >
              Reverse
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                const res = await fetch("/api/books/journals/bulk/post", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ entryIds: selectedIds }),
                });
                const data = await res.json();
                if (!res.ok) toast.error(String(data.error || "Post failed"));
                else {
                  toast.success("Drafts posted");
                  onBulkDone();
                }
              }}
            >
              Post drafts
            </Button>
          </div>
        </div>
      ) : null}

      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md overflow-y-auto p-6"
          data-testid="ledger-filters-drawer"
        >
          <SheetHeader className="p-0">
            <SheetTitle>Filters</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4 pb-4">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>From date</Label>
                <BooksDateInput
                  value={draftFilters.fromDate}
                  onChange={(iso) => setDraftFilters({ ...draftFilters, fromDate: iso })}
                />
              </div>
              <div>
                <Label>To date</Label>
                <BooksDateInput
                  value={draftFilters.toDate}
                  onChange={(iso) => setDraftFilters({ ...draftFilters, toDate: iso })}
                />
              </div>
            </div>
            <div>
              <Label>Accounts</Label>
              <div className="mt-1 max-h-40 overflow-auto rounded-md border border-border p-2 space-y-1">
                {accounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draftFilters.accountIds.includes(a.id)}
                      onCheckedChange={(checked) => {
                        setDraftFilters({
                          ...draftFilters,
                          accountIds: checked
                            ? [...draftFilters.accountIds, a.id]
                            : draftFilters.accountIds.filter((id) => id !== a.id),
                        });
                      }}
                    />
                    <span className="font-mono text-xs">{a.code}</span>
                    {a.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Amount min (AED)</Label>
                <Input
                  inputMode="decimal"
                  value={draftFilters.amountMin}
                  onChange={(e) => setDraftFilters({ ...draftFilters, amountMin: e.target.value })}
                />
              </div>
              <div>
                <Label>Amount max (AED)</Label>
                <Input
                  inputMode="decimal"
                  value={draftFilters.amountMax}
                  onChange={(e) => setDraftFilters({ ...draftFilters, amountMax: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label>Created by</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border border-border px-2 text-sm"
                value={draftFilters.createdBy}
                onChange={(e) => setDraftFilters({ ...draftFilters, createdBy: e.target.value })}
              >
                <option value="">Any</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Posted by</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border border-border px-2 text-sm"
                value={draftFilters.postedBy}
                onChange={(e) => setDraftFilters({ ...draftFilters, postedBy: e.target.value })}
              >
                <option value="">Any</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Tags</Label>
              <div className="mt-1 flex flex-wrap gap-2">
                {tagNames.map((t) => (
                  <label key={t} className="inline-flex items-center gap-1 text-xs">
                    <Checkbox
                      checked={draftFilters.tags.includes(t)}
                      onCheckedChange={(checked) => {
                        setDraftFilters({
                          ...draftFilters,
                          tags: checked
                            ? [...draftFilters.tags, t]
                            : draftFilters.tags.filter((x) => x !== t),
                        });
                      }}
                    />
                    {t}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label>Voucher type</Label>
              <div className="mt-1 flex flex-wrap gap-2">
                {VOUCHER_TYPE_FILTERS.map((vt) => (
                  <label key={vt} className="inline-flex items-center gap-1 text-xs">
                    <Checkbox
                      checked={(draftFilters.voucherTypes || []).includes(vt)}
                      onCheckedChange={(checked) => {
                        const cur = draftFilters.voucherTypes || [];
                        setDraftFilters({
                          ...draftFilters,
                          voucherTypes: checked ? [...cur, vt] : cur.filter((x) => x !== vt),
                        });
                      }}
                    />
                    {vt}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label>Attachment</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border border-border px-2 text-sm"
                value={draftFilters.hasAttachment}
                onChange={(e) =>
                  setDraftFilters({
                    ...draftFilters,
                    hasAttachment: e.target.value as LedgerFilterState["hasAttachment"],
                  })
                }
              >
                <option value="">Any</option>
                <option value="yes">Has attachment</option>
                <option value="no">No attachment</option>
              </select>
            </div>
          </div>
          <SheetFooter className="mt-6 flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setDraftFilters(EMPTY_LEDGER_FILTERS);
              }}
            >
              Clear all
            </Button>
            <Button
              onClick={() => {
                onDrawerFiltersChange(draftFilters);
                onApplyFilters(draftFilters);
                setFiltersOpen(false);
              }}
            >
              Apply
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ManageTagsDialog open={tagsOpen} onOpenChange={setTagsOpen} />

      <Dialog open={bulkTagOpen} onOpenChange={setBulkTagOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{bulkTagMode === "add" ? "Add tag to drafts" : "Remove tag from drafts"}</DialogTitle>
          </DialogHeader>
          <Input value={bulkTagName} onChange={(e) => setBulkTagName(e.target.value)} placeholder="Tag name" />
          <DialogFooter className="gap-2">
            <Button
              onClick={async () => {
                const path =
                  bulkTagMode === "add"
                    ? "/api/books/journals/bulk/add-tag"
                    : "/api/books/journals/bulk/remove-tag";
                await fetch(path, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ entryIds: selectedIds, tags: [bulkTagName.trim()] }),
                });
                setBulkTagOpen(false);
                onBulkDone();
              }}
            >
              {bulkTagMode === "add" ? "Add tag" : "Remove tag"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reverseOpen} onOpenChange={setReverseOpen}>
        <DialogContent data-testid="ledger-reverse-dialog">
          <DialogHeader>
            <DialogTitle>Reverse selected entries</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Approver action — original stays immutable; a linked reversal is posted. Reason is required for
            audit.
          </p>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Reversal date</label>
            <BooksDateInput
              data-testid="ledger-reverse-date"
              value={reverseDate}
              onChange={setReverseDate}
            />
          </div>
          <Textarea
            value={reverseReason}
            onChange={(e) => setReverseReason(e.target.value)}
            placeholder="Reason for reversal"
            data-testid="ledger-reverse-reason"
          />
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={!reverseReason.trim() || !isAdmin || !reverseDate}
              data-testid="ledger-reverse-confirm"
              onClick={async () => {
                const res = await fetch("/api/books/journals/bulk/reverse", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    entryIds: selectedIds,
                    entryDate: reverseDate,
                    reason: reverseReason.trim(),
                  }),
                });
                if (!res.ok) toast.error("Reverse failed");
                else {
                  toast.success("Reversals created");
                  setReverseOpen(false);
                  setReverseReason("");
                  onBulkDone();
                }
              }}
            >
              Reverse
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function LedgerPageChrome({
  title,
  subtitle,
  rightActions,
  infoBanner,
  children,
  transactionsEmpty,
  toolbar,
}: {
  title: string;
  subtitle: string;
  rightActions?: ReactNode;
  infoBanner?: string;
  children: ReactNode;
  transactionsEmpty?: boolean;
  toolbar?: ReactNode;
}) {
  const pathname = usePathname();
  const [bannerOpen, setBannerOpen] = useState(true);

  const tabs = [
    { href: "/books/transactions", label: "Transactions" },
    { href: "/books/journals", label: "Journals" },
  ];

  return (
    <div className="space-y-4" data-testid="ledger-page-chrome">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            <Badge variant="secondary" className="rounded-md text-[10px] uppercase">
              Beta
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">{rightActions}</div>
      </div>

      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "border-b-2 px-4 py-2 text-sm -mb-px",
                active
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {toolbar}

      {infoBanner && bannerOpen ? (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-primary/20 bg-primary-subtle px-3 py-2 text-sm text-foreground">
          <span>{infoBanner}</span>
          <button type="button" onClick={() => setBannerOpen(false)} aria-label="Dismiss info">
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>
      ) : null}

      {transactionsEmpty ? (
        <div className="rounded-lg border border-dashed border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium text-foreground">Bank transactions live next door</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Matching and posting are on the Transactions screen. Journals here stay the posted ledger.
          </p>
          <Link
            href="/books/transactions"
            className="mt-4 inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-sm hover:bg-muted"
          >
            Open Transactions
          </Link>
        </div>
      ) : (
        children
      )}
    </div>
  );
}
