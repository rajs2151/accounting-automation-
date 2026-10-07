"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useBooksShell } from "@/components/books/books-shell-context";
import {
  CellAccount,
  CellAmount,
  CellDate,
  CellEntryId,
  CellReadMore,
  CellStatusPill,
  CellTags,
  CellTypePill,
  type AccountCell,
} from "@/components/books/cells";
import { BooksDateInput } from "@/components/books/date-input";
import {
  CreateEntrySheet,
  type CreateEntryPrefill,
} from "@/components/books/create-entry-sheet";
import { BooksDataGrid, type BooksGridColumn } from "@/components/books/data-grid";
import {
  EMPTY_LEDGER_FILTERS,
  buildJournalsQuery,
  type LedgerFilterState,
} from "@/components/books/ledger-filters";
import { LedgerPageChrome, LedgerToolbar } from "@/components/books/ledger-page-chrome";
import {
  formatAuditAction,
  journalLineSide,
  linkedEntryLabel,
} from "@/components/books/journal-drawer";
import { BooksSideDrawer } from "@/components/books/side-drawer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
import { formatMinor } from "@/lib/money";

type JournalRow = {
  id: string;
  periodId: string;
  periodLabel?: string;
  description: string;
  memo: string;
  reference?: string | null;
  entryDate: string;
  status: string;
  entryNo?: string | null;
  entryType: string;
  voucherType?: string;
  amount: number;
  debitTotal: number;
  creditTotal: number;
  debitAccount: AccountCell | null;
  creditAccount: AccountCell | null;
  debitLineCount?: number;
  creditLineCount?: number;
  tags: string[];
  reversesEntryId?: string | null;
  reversedByEntryId?: string | null;
  correctsEntryId?: string | null;
  recurringId?: string | null;
  recurringIndex?: number | null;
  recurringTotal?: number | null;
};

type JournalDetail = {
  id: string;
  memo: string;
  reference?: string | null;
  entryDate: string;
  status: string;
  entryNo?: string | null;
  entryType?: string;
  voucherType?: string;
  note?: string;
  tags?: string[];
  periodId: string;
  periodLabel?: string;
  periodStatus?: string;
  createdBy?: string;
  createdByName?: string | null;
  createdAt?: string;
  postedAt?: string | null;
  reversesEntryId?: string | null;
  reversedByEntryId?: string | null;
  correctsEntryId?: string | null;
  reversesEntryNo?: string | null;
  reversedByEntryNo?: string | null;
  correctsEntryNo?: string | null;
  autoReverseNextPeriod?: boolean;
  attachments?: Array<{ id: string; originalName: string }>;
  lines: Array<{
    id: string;
    accountId?: string;
    accountCode: string;
    accountName: string;
    parentCode?: string | null;
    parentName?: string | null;
    debitMinor: number;
    creditMinor: number;
    currency?: string;
    lineMemo: string;
    vatTreatment?: string | null;
    vatCode?: string | null;
    vatAmountMinor?: number;
    linkedVatLineId?: string | null;
    tags?: string[];
  }>;
};

type AuditRow = {
  id: string;
  action: string;
  at: string;
  source: string;
  actor?: string;
  actorName?: string | null;
  after?: Record<string, unknown> | null;
};
type Account = { id: string; code: string; name: string; accountType?: string };

function readUserCookie(): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(/(?:^|;\s*)daftar_user=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export default function BooksJournalsPage() {
  const { periodId, globalSearch } = useBooksShell();
  const [rows, setRows] = useState<JournalRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JournalDetail | null>(null);
  const detailRequestId = useRef<string | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [toolbarSearch, setToolbarSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<CreateEntryPrefill | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [drawerFilters, setDrawerFilters] = useState<LedgerFilterState>(EMPTY_LEDGER_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<LedgerFilterState>(EMPTY_LEDGER_FILTERS);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [meId, setMeId] = useState("");
  const [posting, setPosting] = useState(false);
  const [editMemo, setEditMemo] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editTags, setEditTags] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseDate, setReverseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reversing, setReversing] = useState(false);

  const searchQuery = toolbarSearch || globalSearch;

  const reload = useCallback(async () => {
    const usePeriod = periodId;
    if (!usePeriod) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const qs = buildJournalsQuery(usePeriod, searchQuery, types, statuses, appliedFilters);
      const list = await fetch(`/api/books/journals?${qs}`).then((r) => r.json());
      if (Array.isArray(list)) setRows(list);
      else setError(String(list.error || "load_failed"));
    } catch {
      setError("Could not load journals.");
    } finally {
      setLoading(false);
    }
  }, [periodId, searchQuery, types, statuses, appliedFilters]);

  useEffect(() => {
    fetch("/api/books/accounts?postableOnly=1")
      .then((r) => r.json())
      .then((accountList) => {
        if (Array.isArray(accountList)) setAccounts(accountList);
      })
      .catch(() => undefined);
    fetch("/api/books/users")
      .then((r) => r.json())
      .then((users) => {
        if (!Array.isArray(users)) return;
        const uid = readUserCookie();
        setMeId(uid);
        const me = users.find((u: { id: string; role?: string }) => u.id === uid);
        setIsAdmin(me?.role === "admin" || me?.role === "approver");
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void reload(), searchQuery ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [reload, searchQuery]);

  useEffect(() => {
    if (!selectionMode) setSelectedIds([]);
  }, [selectionMode]);

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.includes(r.id)),
    [rows, selectedIds],
  );

  async function openRow(row: JournalRow) {
    const rowId = row.id;
    // Clear stale drawer content only when switching to a different row.
    if (selectedId !== rowId) {
      setDetail(null);
      setAudit([]);
    }
    setSelectedId(rowId);
    detailRequestId.current = rowId;
    setTab("overview");
    const [d, a] = await Promise.all([
      fetch(`/api/books/journals/${rowId}`).then((r) => r.json()),
      fetch(`/api/books/journals/${rowId}/audit`).then((r) => r.json()),
    ]);
    // Drop responses that arrived after the user selected another row.
    if (detailRequestId.current !== rowId) return;
    if (d?.id === rowId) {
      setDetail(d);
      setEditMemo(String(d.memo || ""));
      setEditNote(String(d.note || ""));
      setEditTags(Array.isArray(d.tags) ? d.tags.join(", ") : "");
    }
    setAudit(Array.isArray(a) ? a : []);
  }

  async function savePostedMeta() {
    if (!detail) return;
    setSavingMeta(true);
    try {
      const tags = editTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await Promise.all([
        fetch(`/api/books/journals/${detail.id}/memo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memo: editMemo }),
        }),
        fetch(`/api/books/journals/${detail.id}/note`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: editNote }),
        }),
        fetch(`/api/books/journals/${detail.id}/tags`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags }),
        }),
      ]);
      await openRow({ ...detail, description: editMemo, memo: editMemo, amount: 0, debitTotal: 0, creditTotal: 0, debitAccount: null, creditAccount: null, tags, entryType: detail.entryType || "manual" } as JournalRow);
      void reload();
    } finally {
      setSavingMeta(false);
    }
  }

  async function confirmDrawerReverse() {
    if (!detail || !reverseReason.trim()) return;
    setReversing(true);
    setError("");
    try {
      const res = await fetch(`/api/books/journals/${detail.id}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryDate: reverseDate,
          reason: reverseReason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(apiErrorMessage(data));
        toast.error(apiErrorMessage(data));
        return;
      }
      toast.success(`Reversed${data.entryNo ? ` — reversal ${data.entryNo} posted` : ""}`);
      setReverseOpen(false);
      setReverseReason("");
      const origId = detail.id;
      await reload();
      await openRow({ id: origId } as JournalRow);
    } finally {
      setReversing(false);
    }
  }

  async function postDraft() {
    if (!detail) return;
    setPosting(true);
    try {
      const res = await fetch(`/api/books/journals/${detail.id}/post`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(apiErrorMessage(data));
        return;
      }
      toast.success(`Posted${data.entryNo ? ` as ${data.entryNo}` : ""}`);
      const id = detail.id;
      await reload();
      await openRow({ id } as JournalRow);
    } finally {
      setPosting(false);
    }
  }

  async function startCorrection() {
    if (!detail) return;
    const res = await fetch(`/api/books/journals/${detail.id}/correct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryDate: detail.entryDate }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "correction_failed");
      return;
    }
    setCreatePrefill({
      ...(data.prefill || {}),
      correctsEntryId: detail.id,
    });
    setEditEntryId(null);
    setCreateOpen(true);
    void reload();
  }

  function openDraftEditor() {
    if (!detail) return;
    // Primaries store linkedVatLineId → companion; exclude companions so the
    // sheet regenerates a single VAT line instead of doubling.
    const companionIds = new Set(
      detail.lines
        .map((l) => l.linkedVatLineId)
        .filter((id): id is string => Boolean(id))
        .map(String),
    );
    setCreatePrefill({
      entryDate: detail.entryDate,
      memo: detail.memo,
      // Keep the draft's voucher reference (e.g. DRAFT-0010) on save.
      reference: detail.reference || "",
      voucherType: detail.voucherType || "Journal",
      tags: detail.tags || [],
      autoReverseNextPeriod: Boolean(detail.autoReverseNextPeriod),
      lines: detail.lines
        .filter((l) => !companionIds.has(l.id))
        .map((l) => ({
          accountId: String(l.accountId || ""),
          debitMinor: l.debitMinor,
          creditMinor: l.creditMinor,
          lineMemo: l.lineMemo,
          vatCode: l.vatCode,
          vatAmountMinor: l.vatAmountMinor,
          tags: l.tags || [],
        })),
    });
    setEditEntryId(detail.id);
    setCreateOpen(true);
  }

  const periodLocked = detail?.periodStatus === "LOCKED";
  const isDraftLike = detail?.status === "draft" || detail?.status === "scheduled";
  const isPostedOpen = detail?.status === "posted" && !periodLocked;
  // Dual control: the approver posting a draft must not be its creator or have edited it.
  const postBlockedReason: string | null = !detail
    ? null
    : !isAdmin
      ? "Only an approver or admin can post"
      : detail.createdBy && detail.createdBy === meId
        ? "You prepared this entry, so someone else must post it"
        : audit.some((e) => e.action === "update" && e.actor === meId)
          ? "You edited this entry, so someone else must post it"
          : null;

  const columns: BooksGridColumn<JournalRow>[] = [
    {
      id: "date",
      header: "Date",
      size: 110,
      accessor: (r) => r.entryDate,
      cell: (r) => <CellDate value={r.entryDate} />,
    },
    {
      id: "entryId",
      header: "Voucher",
      size: 118,
      accessor: (r) => r.entryNo || r.reference || r.id,
      cell: (r) => <CellEntryId entryNo={r.entryNo} reference={r.reference} id={r.id} />,
    },
    {
      id: "voucherType",
      header: "Type",
      size: 100,
      accessor: (r) => r.voucherType || "",
      cell: (r) => <span className="text-xs text-muted-foreground">{r.voucherType || "—"}</span>,
    },
    {
      id: "description",
      header: "Description",
      size: 180,
      accessor: (r) => r.description || r.memo,
      cell: (r) => (
        <div className="space-y-0.5">
          <CellReadMore text={r.description || r.memo || ""} max={40} />
          {r.recurringId ? (
            <span
              className="inline-flex rounded bg-sky-50 px-1.5 py-0 text-[10px] font-medium text-sky-800 border border-sky-200"
              data-testid="journal-recurring-badge"
            >
              {r.recurringIndex != null && r.recurringTotal != null
                ? `Entry ${r.recurringIndex} of ${r.recurringTotal}`
                : "Recurring"}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: "debitAccount",
      header: "Debit account",
      size: 150,
      enableSorting: false,
      cell: (r) => <CellAccount account={r.debitAccount} lineCount={r.debitLineCount} />,
    },
    {
      id: "creditAccount",
      header: "Credit account",
      size: 150,
      enableSorting: false,
      cell: (r) => <CellAccount account={r.creditAccount} lineCount={r.creditLineCount} />,
    },
    {
      id: "amount",
      header: "Amount",
      size: 110,
      className: "text-right",
      accessor: (r) => r.amount ?? r.debitTotal,
      cell: (r) => <CellAmount minor={r.amount ?? r.debitTotal} />,
    },
    {
      id: "type",
      header: "Type",
      size: 88,
      accessor: (r) => r.entryType,
      cell: (r) => <CellTypePill entryType={r.entryType || "manual"} />,
    },
    {
      id: "status",
      header: "Status",
      size: 100,
      accessor: (r) => r.status,
      cell: (r) => <CellStatusPill status={r.status} />,
    },
    {
      id: "tags",
      header: "Tags",
      size: 120,
      enableSorting: false,
      cell: (r) => <CellTags tags={r.tags || []} />,
    },
  ];

  const detailCurrency =
    detail?.lines.find((l) => l.currency)?.currency ||
    detail?.lines[0]?.currency ||
    "AED";

  function openLinked(id: string) {
    void openRow({
      id,
      periodId: detail?.periodId || periodId,
      description: "",
      memo: "",
      entryDate: "",
      status: "",
      entryType: "manual",
      amount: 0,
      debitTotal: 0,
      creditTotal: 0,
      debitAccount: null,
      creditAccount: null,
      tags: [],
    });
  }

  return (
    <>
      <LedgerPageChrome
        title="Journals"
        subtitle="Every posted voucher for the period, as debits and credits. Balances and reports are built from these."
        infoBanner="Click a row to open it. Posted entries can’t be edited — reverse it and post a corrected entry."
        rightActions={
          <>
            <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="create-journal-open">
              Create Entry
            </Button>
          </>
        }
        toolbar={
          periodId ? (
            <LedgerToolbar
              periodId={periodId}
              toolbarSearch={toolbarSearch}
              onToolbarSearchChange={setToolbarSearch}
              types={types}
              onTypesChange={setTypes}
              statuses={statuses}
              onStatusesChange={setStatuses}
              drawerFilters={drawerFilters}
              onDrawerFiltersChange={setDrawerFilters}
              appliedFilters={appliedFilters}
              onApplyFilters={setAppliedFilters}
              rowCount={rows.length}
              selectionMode={selectionMode}
              onSelectionModeChange={setSelectionMode}
              selectedIds={selectedIds}
              selectedRows={selectedRows}
              onBulkDone={() => {
                setSelectedIds([]);
                void reload();
              }}
              isAdmin={isAdmin}
            />
          ) : null
        }
      >
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <BooksDataGrid
          columns={columns}
          rows={rows}
          loading={loading}
          searchQuery=""
          selectedId={selectedId}
          onRowClick={(row) => void openRow(row)}
          emptyLabel="No journals in this period."
          enableRowSelection={selectionMode}
          onSelectionChange={setSelectedIds}
          getRowClassName={(r) =>
            r.status === "reversed" || r.reversedByEntryId
              ? "opacity-55 text-muted-foreground"
              : undefined
          }
        />
      </LedgerPageChrome>

      <CreateEntrySheet
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) {
            setCreatePrefill(null);
            setEditEntryId(null);
          }
        }}
        periodId={periodId}
        accounts={accounts}
        prefill={createPrefill}
        editEntryId={editEntryId}
        onCreated={(id) => {
          void reload();
          void openRow({
            id,
            periodId,
            description: "",
            memo: "",
            entryDate: "",
            status: "posted",
            entryType: "manual",
            amount: 0,
            debitTotal: 0,
            creditTotal: 0,
            debitAccount: null,
            creditAccount: null,
            tags: [],
          });
        }}
      />

      <BooksSideDrawer
        open={Boolean(selectedId)}
        onOpenChange={(open) => {
          if (!open) {
            detailRequestId.current = null;
            setSelectedId(null);
            setDetail(null);
            setAudit([]);
          }
        }}
        title={detail?.memo || "Journal entry"}
        entryNo={detail?.entryNo}
        status={detail?.status}
        entryType={detail?.voucherType || detail?.entryType || "manual"}
        source="app"
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "audit", label: "Audit Log & Linked Entries" },
        ]}
        activeTab={tab}
        onTabChange={setTab}
      >
        {tab === "overview" && detail ? (
          <div className="space-y-4" data-testid="journal-drawer-overview">
            {periodLocked ? (
              <div
                className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                data-testid="period-locked-banner"
              >
                Period locked — unlock to change
              </div>
            ) : null}

            {isPostedOpen ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div>
                  <label className="text-xs text-muted-foreground">Description</label>
                  <Textarea
                    className="mt-1"
                    rows={2}
                    value={editMemo}
                    onChange={(e) => setEditMemo(e.target.value)}
                    data-testid="drawer-edit-memo"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Note</label>
                  <Textarea
                    className="mt-1"
                    rows={2}
                    value={editNote}
                    onChange={(e) => setEditNote(e.target.value)}
                    data-testid="drawer-edit-note"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Tags (comma-separated)</label>
                  <Input
                    className="mt-1"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    data-testid="drawer-edit-tags"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={savingMeta} onClick={() => void savePostedMeta()}>
                    Save description / note / tags
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void startCorrection()}
                    data-testid="drawer-edit-amounts"
                  >
                    Edit date / accounts / amounts
                  </Button>
                  {isAdmin ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        setReverseDate(detail.entryDate?.slice(0, 10) || new Date().toISOString().slice(0, 10));
                        setReverseReason("");
                        setReverseOpen(true);
                      }}
                      data-testid="drawer-reverse"
                    >
                      Reverse
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Editing amounts creates an automatic reversal and a prefilled correction entry.
                </p>
              </div>
            ) : (
              <div>
                <h3 className="mb-1 text-sm font-medium">Description</h3>
                <p className="text-sm">{detail.memo || "—"}</p>
                {isDraftLike && !periodLocked ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openDraftEditor()}
                      data-testid="drawer-edit-draft"
                    >
                      Edit entry
                    </Button>
                    <Button
                      size="sm"
                      disabled={posting || Boolean(postBlockedReason)}
                      title={postBlockedReason || undefined}
                      onClick={() => void postDraft()}
                      data-testid="drawer-post-draft"
                    >
                      {posting ? "Posting…" : "Post"}
                    </Button>
                    {postBlockedReason ? (
                      <span className="text-xs text-muted-foreground" data-testid="drawer-post-blocked">
                        {postBlockedReason}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}

            <div>
              <h3 className="mb-2 text-sm font-medium">Journal lines</h3>
              <div className="space-y-2" data-testid="journal-line-cards">
                {detail.lines.map((line) => {
                  const side = journalLineSide(line);
                  const isDr = side === "debit";
                  return (
                    <div
                      key={line.id}
                      className={
                        isDr
                          ? "rounded-lg border border-emerald-200 bg-emerald-50/80 p-3"
                          : "rounded-lg border border-red-200 bg-red-50/80 p-3"
                      }
                      data-testid={`journal-line-${side}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div
                            className={
                              isDr
                                ? "text-[10px] font-semibold uppercase tracking-wide text-emerald-800"
                                : "text-[10px] font-semibold uppercase tracking-wide text-red-800"
                            }
                          >
                            {isDr ? "Debit" : "Credit"}
                          </div>
                          <div className="mt-0.5 text-sm font-semibold text-foreground">
                            {line.accountCode} · {line.accountName}
                          </div>
                          {line.parentCode ? (
                            <div className="text-xs text-muted-foreground">
                              Parent: {line.parentCode} · {line.parentName}
                            </div>
                          ) : null}
                          {line.lineMemo ? (
                            <div className="mt-1 text-xs text-muted-foreground">{line.lineMemo}</div>
                          ) : null}
                        </div>
                        <div
                          className={
                            isDr
                              ? "shrink-0 text-base font-semibold tabular-nums text-emerald-900"
                              : "shrink-0 text-base font-semibold tabular-nums text-red-900"
                          }
                        >
                          {formatMinor(isDr ? line.debitMinor : line.creditMinor)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">Details</h3>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm" data-testid="journal-drawer-details">
                <dt className="text-muted-foreground">Date</dt>
                <dd>{formatDateUae(detail.entryDate)}</dd>
                <dt className="text-muted-foreground">Period</dt>
                <dd>{detail.periodLabel || "—"}</dd>
                <dt className="text-muted-foreground">Currency</dt>
                <dd>{detailCurrency}</dd>
                <dt className="text-muted-foreground">Voucher</dt>
                <dd>{detail.voucherType || "Journal"}</dd>
                <dt className="text-muted-foreground">Created by</dt>
                <dd>{detail.createdByName || "—"}</dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>
                  {detail.createdAt
                    ? `${formatDateUae(detail.createdAt)} · ${new Date(detail.createdAt).toISOString().slice(11, 19)} UTC`
                    : "—"}
                </dd>
                <dt className="text-muted-foreground">Posted</dt>
                <dd>
                  {detail.postedAt
                    ? `${formatDateUae(detail.postedAt)} · ${new Date(detail.postedAt).toISOString().slice(11, 19)} UTC`
                    : "—"}
                </dd>
              </dl>
            </div>

            <div>
              <h3 className="mb-1 text-sm font-medium">Linked documents</h3>
              {detail.attachments?.length ? (
                <ul className="text-sm text-muted-foreground">
                  {detail.attachments.map((a) => (
                    <li key={a.id}>{a.originalName}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No documents linked yet.</p>
              )}
            </div>

            {!isPostedOpen ? (
              <div>
                <h3 className="mb-1 text-sm font-medium">Note</h3>
                <p className="text-sm text-muted-foreground">{detail.note?.trim() || "—"}</p>
              </div>
            ) : null}
          </div>
        ) : null}
        {tab === "audit" ? (
          <div className="space-y-3" data-testid="journal-audit">
            {detail?.reversesEntryId || detail?.reversedByEntryId || detail?.correctsEntryId ? (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm space-y-1">
                <div className="font-medium">Linked entries</div>
                {detail.reversesEntryId ? (
                  <div>
                    Reverses:{" "}
                    <button
                      type="button"
                      className="text-primary underline"
                      data-testid="audit-link-reverses"
                      onClick={() => openLinked(detail.reversesEntryId!)}
                    >
                      {linkedEntryLabel(detail.reversesEntryNo, detail.reversesEntryId)}
                    </button>
                  </div>
                ) : null}
                {detail.reversedByEntryId ? (
                  <div>
                    Reversed by:{" "}
                    <button
                      type="button"
                      className="text-primary underline"
                      data-testid="audit-link-reversed-by"
                      onClick={() => openLinked(detail.reversedByEntryId!)}
                    >
                      {linkedEntryLabel(detail.reversedByEntryNo, detail.reversedByEntryId)}
                    </button>
                  </div>
                ) : null}
                {detail.correctsEntryId ? (
                  <div>
                    Corrects:{" "}
                    <button
                      type="button"
                      className="text-primary underline"
                      onClick={() => openLinked(detail.correctsEntryId!)}
                    >
                      {linkedEntryLabel(detail.correctsEntryNo, detail.correctsEntryId)}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {audit.length === 0 ? (
              <p className="text-sm text-muted-foreground">No audit events.</p>
            ) : (
              <ol className="relative space-y-0 border-l border-border pl-4">
                {audit.map((event) => {
                  const amountAfter =
                    event.after && typeof event.after === "object" && "amount" in event.after
                      ? Number(event.after.amount)
                      : event.after && typeof event.after === "object" && "entryNo" in event.after
                        ? String(event.after.entryNo)
                        : null;
                  return (
                    <li key={event.id} className="relative pb-4 last:pb-0">
                      <span className="absolute -left-[1.15rem] top-1.5 size-2 rounded-full bg-primary" />
                      <div className="text-sm font-medium">{formatAuditAction(event.action)}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatDateUae(event.at)} · {new Date(event.at).toISOString().slice(11, 19)} UTC
                        {" · "}
                        {event.actorName || "Unknown"} · {event.source}
                      </div>
                      {amountAfter != null && amountAfter !== "" ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {typeof amountAfter === "number"
                            ? `Amount ${formatMinor(amountAfter)}`
                            : `Entry ${amountAfter}`}
                        </div>
                      ) : null}
                      {event.after && typeof event.after === "object" && "reversalId" in event.after ? (
                        <button
                          type="button"
                          className="mt-0.5 text-xs text-primary underline"
                          onClick={() => openLinked(String(event.after!.reversalId))}
                        >
                          Open reversal{" "}
                          {event.after.reversalNo
                            ? String(event.after.reversalNo)
                            : detail?.reversedByEntryId === String(event.after.reversalId) &&
                                detail?.reversedByEntryNo
                              ? detail.reversedByEntryNo
                              : `${String(event.after.reversalId).slice(0, 8)}…`}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        ) : null}
      </BooksSideDrawer>

      <Dialog open={reverseOpen} onOpenChange={setReverseOpen}>
        <DialogContent data-testid="drawer-reverse-dialog">
          <DialogHeader>
            <DialogTitle>Reverse journal entry</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Posts a linked opposite entry. The original stays on the books as reversed (immutable).
          </p>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Reversal date</label>
            <BooksDateInput
              data-testid="drawer-reverse-date"
              value={reverseDate}
              onChange={setReverseDate}
            />
          </div>
          <Textarea
            value={reverseReason}
            onChange={(e) => setReverseReason(e.target.value)}
            placeholder="Reason for reversal (required)"
            data-testid="drawer-reverse-reason"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={reversing || !reverseReason.trim() || !reverseDate}
              data-testid="drawer-reverse-confirm"
              onClick={() => void confirmDrawerReverse()}
            >
              {reversing ? "Reversing…" : "Reverse"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
