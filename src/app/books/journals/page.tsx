"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { BooksSideDrawer } from "@/components/books/side-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
};

type JournalDetail = {
  id: string;
  memo: string;
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
  reversesEntryId?: string | null;
  reversedByEntryId?: string | null;
  correctsEntryId?: string | null;
  attachments?: Array<{ id: string; originalName: string }>;
  lines: Array<{
    id: string;
    accountId?: string;
    accountCode: string;
    accountName: string;
    debitMinor: number;
    creditMinor: number;
    lineMemo: string;
    vatTreatment?: string | null;
    vatCode?: string | null;
    vatAmountMinor?: number;
    tags?: string[];
  }>;
};

type AuditRow = {
  id: string;
  action: string;
  at: string;
  source: string;
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
  const [editMemo, setEditMemo] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editTags, setEditTags] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);

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
    setSelectedId(row.id);
    setTab("overview");
    const [d, a] = await Promise.all([
      fetch(`/api/books/journals/${row.id}`).then((r) => r.json()),
      fetch(`/api/books/journals/${row.id}/audit`).then((r) => r.json()),
    ]);
    if (d?.id) {
      setDetail(d);
      setEditMemo(String(d.memo || ""));
      setEditNote(String(d.note || ""));
      setEditTags(Array.isArray(d.tags) ? d.tags.join(", ") : "");
    }
    if (Array.isArray(a)) setAudit(a);
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
    setCreatePrefill({
      entryDate: detail.entryDate,
      memo: detail.memo,
      voucherType: detail.voucherType || "Journal",
      tags: detail.tags || [],
      lines: detail.lines.map((l) => ({
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
            <span className="inline-flex rounded bg-sky-50 px-1.5 py-0 text-[10px] font-medium text-sky-800 border border-sky-200">
              Recurring
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

  const primaryDebit = detail?.lines.find((l) => l.debitMinor > 0);
  const primaryCredit = detail?.lines.find((l) => l.creditMinor > 0);

  return (
    <>
      <LedgerPageChrome
        title="Ledger"
        subtitle="Journal entries for the selected period — source of truth for balances."
        infoBanner="Tip: click a row to open the side drawer. Posted entries are immutable; use reversal + new entry to correct."
        rightActions={
          <>
            <Link
              href="/books/rules"
              className="inline-flex h-7 items-center rounded-lg border border-border bg-background px-2.5 text-sm font-medium hover:bg-muted"
            >
              Rules
            </Link>
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
            setSelectedId(null);
            setDetail(null);
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
          <div className="space-y-4">
            {periodLocked ? (
              <div
                className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                data-testid="period-locked-banner"
              >
                Period locked — unlock to change
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 p-3">
                <div className="text-xs font-medium uppercase text-emerald-800">Debit</div>
                <div className="mt-1 text-sm font-semibold text-foreground">
                  {primaryDebit ? `${primaryDebit.accountCode} · ${primaryDebit.accountName}` : "—"}
                </div>
                <div className="mt-2 text-lg font-semibold tabular-nums text-emerald-900">
                  {primaryDebit ? formatMinor(primaryDebit.debitMinor) : "—"}
                </div>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50/80 p-3">
                <div className="text-xs font-medium uppercase text-red-800">Credit</div>
                <div className="mt-1 text-sm font-semibold text-foreground">
                  {primaryCredit ? `${primaryCredit.accountCode} · ${primaryCredit.accountName}` : "—"}
                </div>
                <div className="mt-2 text-lg font-semibold tabular-nums text-red-900">
                  {primaryCredit ? formatMinor(primaryCredit.creditMinor) : "—"}
                </div>
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">Details</h3>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Date</dt>
                <dd>{formatDateUae(detail.entryDate)}</dd>
                <dt className="text-muted-foreground">Period</dt>
                <dd>{detail.periodLabel || "—"}</dd>
                <dt className="text-muted-foreground">Voucher</dt>
                <dd>{detail.voucherType || "Journal"}</dd>
              </dl>
            </div>

            {isDraftLike && !periodLocked ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => openDraftEditor()} data-testid="drawer-edit-draft">
                  Edit entry
                </Button>
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
                </div>
                <p className="text-xs text-muted-foreground">
                  Editing amounts creates an automatic reversal and a prefilled correction entry.
                </p>
              </div>
            ) : null}

            {!isPostedOpen && !isDraftLike ? (
              <div>
                <h3 className="mb-1 text-sm font-medium">Description</h3>
                <p className="text-sm">{detail.memo || "—"}</p>
              </div>
            ) : null}

            <div>
              <h3 className="mb-2 text-sm font-medium">All lines</h3>
              <div className="space-y-2">
                {detail.lines.map((line) => (
                  <div key={line.id} className="rounded-md border border-border px-3 py-2 text-sm">
                    <div className="font-medium">
                      {line.accountCode} · {line.accountName}
                    </div>
                    <div className="flex justify-between tabular-nums text-muted-foreground">
                      <span>{line.lineMemo || "—"}</span>
                      <span>
                        {line.debitMinor > 0
                          ? `Dr ${formatMinor(line.debitMinor)}`
                          : `Cr ${formatMinor(line.creditMinor)}`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="mb-1 text-sm font-medium">Attachments</h3>
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
          <div className="space-y-2" data-testid="journal-audit">
            {detail?.reversesEntryId || detail?.reversedByEntryId || detail?.correctsEntryId ? (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm space-y-1">
                <div className="font-medium">Linked entries</div>
                {detail.reversesEntryId ? (
                  <div>
                    Reverses:{" "}
                    <button
                      type="button"
                      className="text-primary underline"
                      onClick={() =>
                        void openRow({
                          id: detail.reversesEntryId!,
                          periodId: detail.periodId,
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
                        })
                      }
                    >
                      {detail.reversesEntryId.slice(0, 8)}…
                    </button>
                  </div>
                ) : null}
                {detail.reversedByEntryId ? (
                  <div>
                    Reversed by:{" "}
                    <button
                      type="button"
                      className="text-primary underline"
                      onClick={() =>
                        void openRow({
                          id: detail.reversedByEntryId!,
                          periodId: detail.periodId,
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
                        })
                      }
                    >
                      {detail.reversedByEntryId.slice(0, 8)}…
                    </button>
                  </div>
                ) : null}
                {detail.correctsEntryId ? (
                  <div>Corrects: {detail.correctsEntryId.slice(0, 8)}…</div>
                ) : null}
              </div>
            ) : null}
            {audit.length === 0 ? (
              <p className="text-sm text-muted-foreground">No audit events.</p>
            ) : (
              audit.map((event) => (
                <div key={event.id} className="border-b border-border py-2 text-sm">
                  <div className="font-medium capitalize">{event.action.replaceAll("_", " ")}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatDateUae(event.at)} · {new Date(event.at).toISOString().slice(11, 19)} UTC ·{" "}
                    {event.source}
                  </div>
                  {event.after && typeof event.after === "object" && "reversalId" in event.after ? (
                    <div className="text-xs text-muted-foreground">
                      Reversal id: {String(event.after.reversalId).slice(0, 8)}…
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </BooksSideDrawer>
    </>
  );
}
