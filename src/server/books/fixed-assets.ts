/**
 * P5-2: fixed asset register + monthly straight-line depreciation.
 *
 * Rounding: monthly = floor((cost - residual) / life_months) fils; last month absorbs the
 * remainder so the life total equals cost - residual exactly.
 * First month = calendar month of in_service_date (full month, even if mid-month).
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal, softDeleteBooksJournalDraft } from "@/server/books/journals";
import { assertSyntheticTenant } from "@/server/security-gate";

const DEFAULT_ASSET_CODE = "1600";
const DEFAULT_ACCUM_CODE = "1690";
const DEFAULT_EXPENSE_CODE = "6800";

export type FixedAssetRow = {
  id: string;
  name: string;
  assetAccountId: string;
  assetAccountCode: string;
  accumulatedAccountId: string;
  accumulatedAccountCode: string;
  expenseAccountId: string;
  expenseAccountCode: string;
  costMinor: number;
  residualMinor: number;
  inServiceDate: string;
  lifeMonths: number;
  method: string;
  disposedAt: string | null;
  sourceJournalEntryId: string | null;
  sourceDocumentId: string | null;
};

export type DepreciationScheduleLine = {
  monthIndex: number;
  periodLabelHint: string;
  amountMinor: number;
};

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Months from in-service month to period month (0 = first depreciation month). */
export function depreciationMonthIndex(inServiceDate: string, periodStart: string): number {
  const [sy, sm] = inServiceDate.slice(0, 7).split("-").map(Number);
  const [py, pm] = periodStart.slice(0, 7).split("-").map(Number);
  return (py - sy) * 12 + (pm - sm);
}

/**
 * Straight-line schedule in fils. Last month absorbs remainder.
 * Hand-check: 3_600_000 / 36 → 100_000 each; 900_000 / 7 → 128_571 × 6 + 128_574.
 */
export function monthlyStraightLineAmounts(
  costMinor: number,
  residualMinor: number,
  lifeMonths: number,
): number[] {
  if (!Number.isInteger(costMinor) || !Number.isInteger(residualMinor) || !Number.isInteger(lifeMonths)) {
    throw new BooksError("bad_asset_amounts", "invalid");
  }
  if (lifeMonths <= 0) throw new BooksError("bad_life_months", "invalid");
  if (residualMinor < 0 || costMinor <= 0 || residualMinor >= costMinor) {
    throw new BooksError("bad_asset_cost", "invalid");
  }
  const depreciable = costMinor - residualMinor;
  const base = Math.floor(depreciable / lifeMonths);
  const rem = depreciable - base * lifeMonths;
  const amounts = Array.from({ length: lifeMonths }, () => base);
  amounts[lifeMonths - 1] = base + rem;
  return amounts;
}

export function amountForDepreciationMonth(
  costMinor: number,
  residualMinor: number,
  lifeMonths: number,
  monthIndex: number,
): number | null {
  if (monthIndex < 0 || monthIndex >= lifeMonths) return null;
  return monthlyStraightLineAmounts(costMinor, residualMinor, lifeMonths)[monthIndex] ?? null;
}

async function resolveAccountId(
  db: PoolClient,
  clientId: string,
  accountId: string | undefined,
  defaultCode: string,
): Promise<string> {
  if (accountId) {
    const row = await db.query(
      `SELECT id FROM books_accounts WHERE id = $1 AND client_id = $2 AND active = true`,
      [accountId, clientId],
    );
    if (!row.rowCount) throw new BooksError("account_not_found", "not_found");
    return String(row.rows[0].id);
  }
  const byCode = await db.query(
    `SELECT id FROM books_accounts WHERE client_id = $1 AND code = $2 AND active = true`,
    [clientId, defaultCode],
  );
  if (!byCode.rowCount) throw new BooksError(`account_missing:${defaultCode}`, "not_found");
  return String(byCode.rows[0].id);
}

function mapAsset(row: Record<string, unknown>): FixedAssetRow {
  return {
    id: String(row.id),
    name: String(row.name),
    assetAccountId: String(row.assetAccountId),
    assetAccountCode: String(row.assetAccountCode),
    accumulatedAccountId: String(row.accumulatedAccountId),
    accumulatedAccountCode: String(row.accumulatedAccountCode),
    expenseAccountId: String(row.expenseAccountId),
    expenseAccountCode: String(row.expenseAccountCode),
    costMinor: Number(row.costMinor),
    residualMinor: Number(row.residualMinor),
    inServiceDate: iso(row.inServiceDate),
    lifeMonths: Number(row.lifeMonths),
    method: String(row.method),
    disposedAt: row.disposedAt == null ? null : iso(row.disposedAt),
    sourceJournalEntryId: row.sourceJournalEntryId == null ? null : String(row.sourceJournalEntryId),
    sourceDocumentId: row.sourceDocumentId == null ? null : String(row.sourceDocumentId),
  };
}

const ASSET_SELECT = `
  SELECT a.id, a.name,
         a.asset_account_id AS "assetAccountId", aa.code AS "assetAccountCode",
         a.accumulated_account_id AS "accumulatedAccountId", ac.code AS "accumulatedAccountCode",
         a.expense_account_id AS "expenseAccountId", ae.code AS "expenseAccountCode",
         a.cost_minor AS "costMinor", a.residual_minor AS "residualMinor",
         a.in_service_date AS "inServiceDate", a.life_months AS "lifeMonths",
         a.method, a.disposed_at AS "disposedAt",
         a.source_journal_entry_id AS "sourceJournalEntryId",
         a.source_document_id AS "sourceDocumentId"
  FROM books_fixed_assets a
  JOIN books_accounts aa ON aa.id = a.asset_account_id
  JOIN books_accounts ac ON ac.id = a.accumulated_account_id
  JOIN books_accounts ae ON ae.id = a.expense_account_id
`;

export async function listBooksFixedAssets(userId: string, clientId: string): Promise<FixedAssetRow[]> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `${ASSET_SELECT}
       WHERE a.client_id = $1
       ORDER BY a.in_service_date, a.name`,
      [clientId],
    );
    return rows.rows.map((r) => mapAsset(r as Record<string, unknown>));
  });
}

export async function registerBooksFixedAsset(
  userId: string,
  clientId: string,
  body: {
    name: string;
    costMinor: number;
    residualMinor?: number;
    inServiceDate: string;
    lifeMonths: number;
    assetAccountId?: string;
    accumulatedAccountId?: string;
    expenseAccountId?: string;
    sourceJournalEntryId?: string | null;
    sourceDocumentId?: string | null;
    disposedAt?: string | null;
  },
): Promise<FixedAssetRow & { schedulePreview: DepreciationScheduleLine[] }> {
  const name = String(body.name || "").trim();
  if (!name) throw new BooksError("asset_name_required", "invalid");
  const costMinor = Number(body.costMinor);
  const residualMinor = Number(body.residualMinor ?? 0);
  const lifeMonths = Number(body.lifeMonths);
  const inServiceDate = String(body.inServiceDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inServiceDate)) {
    throw new BooksError("in_service_date_required", "invalid");
  }
  // Validate schedule math early (also rejects bad cost/residual/life).
  const amounts = monthlyStraightLineAmounts(costMinor, residualMinor, lifeMonths);

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const assetAccountId = await resolveAccountId(db, clientId, body.assetAccountId, DEFAULT_ASSET_CODE);
    const accumulatedAccountId = await resolveAccountId(
      db,
      clientId,
      body.accumulatedAccountId,
      DEFAULT_ACCUM_CODE,
    );
    const expenseAccountId = await resolveAccountId(
      db,
      clientId,
      body.expenseAccountId,
      DEFAULT_EXPENSE_CODE,
    );
    const id = randomUUID();
    await db.query(
      `INSERT INTO books_fixed_assets (
         id, client_id, name, asset_account_id, accumulated_account_id, expense_account_id,
         cost_minor, residual_minor, in_service_date, life_months, method,
         disposed_at, source_journal_entry_id, source_document_id, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'straight_line',$11,$12,$13,$14)`,
      [
        id,
        clientId,
        name,
        assetAccountId,
        accumulatedAccountId,
        expenseAccountId,
        costMinor,
        residualMinor,
        inServiceDate,
        lifeMonths,
        body.disposedAt ? String(body.disposedAt).slice(0, 10) : null,
        body.sourceJournalEntryId || null,
        body.sourceDocumentId || null,
        userId,
      ],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_fixed_asset",
      entityId: id,
      after: { name, costMinor, residualMinor, inServiceDate, lifeMonths },
    });
    const row = await db.query(`${ASSET_SELECT} WHERE a.id = $1 AND a.client_id = $2`, [id, clientId]);
    const asset = mapAsset(row.rows[0] as Record<string, unknown>);
    return { ...asset, schedulePreview: schedulePreviewFromAmounts(inServiceDate, amounts) };
  });
}

function schedulePreviewFromAmounts(
  inServiceDate: string,
  amounts: number[],
): DepreciationScheduleLine[] {
  const [y0, m0] = inServiceDate.slice(0, 7).split("-").map(Number);
  return amounts.map((amountMinor, monthIndex) => {
    const abs = m0 - 1 + monthIndex;
    const y = y0 + Math.floor(abs / 12);
    const m = (abs % 12) + 1;
    const labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return {
      monthIndex,
      periodLabelHint: `${labels[m - 1]} ${y}`,
      amountMinor,
    };
  });
}

export async function previewBooksFixedAssetSchedule(
  userId: string,
  clientId: string,
  assetId: string,
): Promise<{ asset: FixedAssetRow; schedule: DepreciationScheduleLine[] }> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const row = await db.query(`${ASSET_SELECT} WHERE a.id = $1 AND a.client_id = $2`, [
      assetId,
      clientId,
    ]);
    if (!row.rowCount) throw new BooksError("asset_not_found", "not_found");
    const asset = mapAsset(row.rows[0] as Record<string, unknown>);
    const amounts = monthlyStraightLineAmounts(asset.costMinor, asset.residualMinor, asset.lifeMonths);
    return { asset, schedule: schedulePreviewFromAmounts(asset.inServiceDate, amounts) };
  });
}

type DueAsset = FixedAssetRow & { amountMinor: number; monthIndex: number };

async function loadPeriod(
  db: PoolClient,
  clientId: string,
  periodId: string,
): Promise<{ id: string; start: string; end: string; status: string; label: string }> {
  const period = await db.query(
    `SELECT id, label, status, period_start, period_end
     FROM books_periods WHERE id = $1 AND client_id = $2`,
    [periodId, clientId],
  );
  if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
  return {
    id: String(period.rows[0].id),
    label: String(period.rows[0].label),
    status: String(period.rows[0].status),
    start: iso(period.rows[0].period_start),
    end: iso(period.rows[0].period_end),
  };
}

/**
 * What an asset should be charged in this period: the schedule's cumulative amount through this month
 * minus what earlier periods actually charged (so a skipped month is caught up and the total never
 * passes cost − residual). Disposed assets depreciate through their disposal month only.
 */
async function depreciationDueThisPeriod(
  db: PoolClient,
  asset: FixedAssetRow,
  periodStart: string,
): Promise<{ amountMinor: number; monthIndex: number } | null> {
  const monthIndex = depreciationMonthIndex(asset.inServiceDate, periodStart);
  if (monthIndex < 0 || asset.lifeMonths <= 0) return null;
  if (asset.disposedAt && asset.disposedAt.slice(0, 7) < periodStart.slice(0, 7)) return null;
  const schedule = monthlyStraightLineAmounts(asset.costMinor, asset.residualMinor, asset.lifeMonths);
  const lastIndex = Math.min(monthIndex, asset.lifeMonths - 1);
  let expected = 0;
  for (let i = 0; i <= lastIndex; i++) expected += schedule[i] ?? 0;
  const charged = await db.query(
    `SELECT COALESCE(SUM(r.amount_minor), 0)::bigint AS charged
     FROM books_depreciation_runs r
     JOIN books_journal_entries e ON e.id = r.journal_entry_id
     JOIN books_periods p ON p.id = r.period_id
     WHERE r.asset_id = $1 AND e.deleted_at IS NULL AND e.status <> 'reversed'
       AND p.period_start < $2::date`,
    [asset.id, periodStart],
  );
  const amountMinor = expected - Number(charged.rows[0].charged);
  return amountMinor > 0 ? { amountMinor, monthIndex } : null;
}

/** Active assets due a depreciation charge in this period (not disposed, within life). */
export async function assetsDueForDepreciation(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<DueAsset[]> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const period = await loadPeriod(db, clientId, periodId);
    const rows = await db.query(
      `${ASSET_SELECT}
       WHERE a.client_id = $1
         AND (a.disposed_at IS NULL OR a.disposed_at >= $3::date)
         AND a.in_service_date <= $2::date`,
      [clientId, period.end, period.start],
    );
    const due: DueAsset[] = [];
    for (const raw of rows.rows) {
      const asset = mapAsset(raw as Record<string, unknown>);
      const d = await depreciationDueThisPeriod(db, asset, period.start);
      if (!d) continue;
      due.push({ ...asset, amountMinor: d.amountMinor, monthIndex: d.monthIndex });
    }
    return due;
  });
}

/**
 * Create one draft JV (entry_type=depreciation) for all assets due in the period that lack a run.
 * Idempotent: second call returns the existing journal without new lines.
 */
export async function runBooksDepreciation(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<{
  journalEntryId: string | null;
  status: string | null;
  created: boolean;
  assetCount: number;
  totalMinor: number;
  skippedExisting: number;
}> {
  const due = await assetsDueForDepreciation(userId, clientId, periodId);

  const prep = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const period = await loadPeriod(db, clientId, periodId);
    if (!["OPEN", "REOPENED"].includes(period.status)) {
      throw new BooksError("period_locked", "period_closed");
    }

    // A run whose journal was deleted (draft) or reversed no longer charges anything: clear it so the
    // asset can be run again (otherwise the unique (asset, period) key blocks it forever).
    await db.query(
      `DELETE FROM books_depreciation_runs r
       USING books_journal_entries e
       WHERE e.id = r.journal_entry_id AND r.client_id = $1 AND r.period_id = $2
         AND (e.deleted_at IS NOT NULL OR e.status = 'reversed')`,
      [clientId, periodId],
    );
    const existing = await db.query(
      `SELECT r.asset_id AS "assetId", r.journal_entry_id AS "journalEntryId", e.status
       FROM books_depreciation_runs r
       JOIN books_journal_entries e ON e.id = r.journal_entry_id
       WHERE r.client_id = $1 AND r.period_id = $2 AND e.deleted_at IS NULL`,
      [clientId, periodId],
    );
    const have = new Set(existing.rows.map((r) => String(r.assetId)));
    const pending = due.filter((a) => !have.has(a.id));

    if (pending.length === 0) {
      const journalEntryId = existing.rows[0] ? String(existing.rows[0].journalEntryId) : null;
      const status = existing.rows[0] ? String(existing.rows[0].status) : null;
      return {
        kind: "noop" as const,
        journalEntryId,
        status,
        skippedExisting: have.size,
        periodEnd: period.end,
        periodLabel: period.label,
        pending: [] as DueAsset[],
      };
    }

    return {
      kind: "create" as const,
      journalEntryId: null as string | null,
      status: null as string | null,
      skippedExisting: have.size,
      periodEnd: period.end,
      periodLabel: period.label,
      pending,
    };
  });

  if (prep.kind === "noop") {
    return {
      journalEntryId: prep.journalEntryId,
      status: prep.status,
      created: false,
      assetCount: due.length,
      totalMinor: due.reduce((s, a) => s + a.amountMinor, 0),
      skippedExisting: prep.skippedExisting,
    };
  }

  const lines = prep.pending.flatMap((asset) => [
    {
      accountId: asset.expenseAccountId,
      debitMinor: asset.amountMinor,
      creditMinor: 0,
      lineMemo: `Depreciation — ${asset.name}`,
    },
    {
      accountId: asset.accumulatedAccountId,
      debitMinor: 0,
      creditMinor: asset.amountMinor,
      lineMemo: `Accum. depr — ${asset.name}`,
    },
  ]);

  const journal = await createBooksJournal(userId, clientId, {
    periodId,
    entryDate: prep.periodEnd,
    memo: `Depreciation ${prep.periodLabel}`,
    voucherType: "Journal",
    entryType: "depreciation",
    lines,
    post: false,
  });

  // All run rows link in one transaction with no ON CONFLICT escape: if a concurrent run already
  // claimed any of these assets for the period, the whole link fails and our draft is removed — never
  // two depreciation journals for the same asset and month.
  const linked = await withUser(userId, async (db) => {
    try {
      await db.query("SAVEPOINT depr_link");
      for (const asset of prep.pending) {
        await db.query(
          `INSERT INTO books_depreciation_runs (
             id, client_id, asset_id, period_id, amount_minor, journal_entry_id
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), clientId, asset.id, periodId, asset.amountMinor, journal.id],
        );
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await db.query("ROLLBACK TO SAVEPOINT depr_link");
      return false;
    }
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_depreciation_run",
      entityId: journal.id,
      after: {
        periodId,
        assetIds: prep.pending.map((a) => a.id),
        totalMinor: prep.pending.reduce((s, a) => s + a.amountMinor, 0),
      },
    });
    return true;
  });

  if (!linked) {
    await softDeleteBooksJournalDraft(userId, clientId, journal.id).catch(() => undefined);
    throw new BooksError("depreciation_run_in_progress", "conflict");
  }

  return {
    journalEntryId: journal.id,
    status: journal.status,
    created: true,
    assetCount: prep.pending.length + prep.skippedExisting,
    totalMinor: prep.pending.reduce((s, a) => s + a.amountMinor, 0),
    skippedExisting: prep.skippedExisting,
  };
}

export type DepreciationGateAsset = { id: string; name: string; amountMinor: number };

/** Close gate helper: assets due this period without a posted depreciation run. */
export async function missingPostedDepreciation(
  db: PoolClient,
  clientId: string,
  periodId: string,
  periodStart: string,
  periodEnd: string,
): Promise<DepreciationGateAsset[]> {
  const rows = await db.query(
    `${ASSET_SELECT}
     WHERE a.client_id = $1
       AND (a.disposed_at IS NULL OR a.disposed_at >= $3::date)
       AND a.in_service_date <= $2::date`,
    [clientId, periodEnd, periodStart],
  );
  const missing: DepreciationGateAsset[] = [];
  for (const raw of rows.rows) {
    const asset = mapAsset(raw as Record<string, unknown>);
    const d = await depreciationDueThisPeriod(db, asset, periodStart);
    if (!d) continue;
    const amount = d.amountMinor;
    const run = await db.query(
      `SELECT r.id, e.status
       FROM books_depreciation_runs r
       JOIN books_journal_entries e ON e.id = r.journal_entry_id
       WHERE r.asset_id = $1 AND r.period_id = $2 AND e.deleted_at IS NULL`,
      [asset.id, periodId],
    );
    if (!run.rowCount || String(run.rows[0].status) !== "posted") {
      missing.push({ id: asset.id, name: asset.name, amountMinor: amount });
    }
  }
  return missing;
}
