/**
 * P5-3: manual FX rates + month-end unrealised revaluation.
 *
 * Rounding: revalued AED fils = aedFromOriginal(original_minor, rate_scaled)
 * (round half up via src/lib/fx.ts). Diff per item = revalued − carried AED fils.
 * One JV (entry_type=fx_revaluation) with a line per adjusted item + one net 7310 line;
 * auto-reverse on the 1st of the next month (create with autoReverseNextPeriod).
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { aedFromOriginal, parseFxRateToScaled } from "@/lib/fx";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import {
  createBooksJournal,
  softDeleteBooksJournalDraft,
  type BooksLineInput,
} from "@/server/books/journals";
import { assertSyntheticTenant } from "@/server/security-gate";

const FX_UNREALISED = "7310";
const AR_CONTROL = "1210";
const AP_CONTROL = "2110";

export type FxRateRow = {
  id: string;
  currency: string;
  rateDate: string;
  rateScaled: number;
  source: string;
  enteredBy: string;
};

export type FxRevalItem = {
  kind: "bank" | "ar" | "ap";
  refId: string;
  label: string;
  accountId: string;
  accountCode: string;
  currency: string;
  originalMinor: number;
  carriedAedMinor: number;
  revaluedAedMinor: number;
  diffAedMinor: number;
};

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export async function listBooksFxRates(
  userId: string,
  clientId: string,
  opts?: { currency?: string },
): Promise<FxRateRow[]> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, currency, rate_date AS "rateDate", rate_scaled AS "rateScaled",
              source, entered_by AS "enteredBy"
       FROM books_fx_rates
       WHERE client_id = $1 AND ($2::text IS NULL OR currency = $2)
       ORDER BY rate_date DESC, currency`,
      [clientId, opts?.currency || null],
    );
    return rows.rows.map((r) => ({
      id: String(r.id),
      currency: String(r.currency),
      rateDate: iso(r.rateDate),
      rateScaled: Number(r.rateScaled),
      source: String(r.source),
      enteredBy: String(r.enteredBy),
    }));
  });
}

export async function upsertBooksFxRate(
  userId: string,
  clientId: string,
  body: { currency: string; rateDate: string; rateScaled?: number; rate?: string | number },
): Promise<FxRateRow> {
  const currency = String(body.currency || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || currency === "AED") {
    throw new BooksError("fx_currency_invalid", "invalid");
  }
  const rateDate = String(body.rateDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) {
    throw new BooksError("fx_rate_date_required", "invalid");
  }
  const rateDay = new Date(`${rateDate}T00:00:00Z`);
  if (Number.isNaN(rateDay.getTime()) || rateDay.toISOString().slice(0, 10) !== rateDate) {
    throw new BooksError("invalid_date", "invalid");
  }
  let rateScaled: number;
  if (body.rateScaled != null) {
    rateScaled = Number(body.rateScaled);
  } else if (body.rate != null && String(body.rate).trim() !== "") {
    // Zero, negative or malformed rates ("-3.6725", "abc") are refused, never stored.
    try {
      rateScaled = Number(parseFxRateToScaled(body.rate));
    } catch {
      throw new BooksError("invalid_fx_rate", "invalid");
    }
  } else {
    throw new BooksError("fx_rate_required", "invalid");
  }
  if (!Number.isSafeInteger(rateScaled) || rateScaled <= 0) {
    throw new BooksError("invalid_fx_rate", "invalid");
  }

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const id = randomUUID();
    const upserted = await db.query(
      `INSERT INTO books_fx_rates (id, client_id, currency, rate_date, rate_scaled, source, entered_by)
       VALUES ($1,$2,$3,$4,$5,'manual',$6)
       ON CONFLICT (client_id, currency, rate_date) DO UPDATE SET
         rate_scaled = EXCLUDED.rate_scaled,
         entered_by = EXCLUDED.entered_by,
         source = 'manual'
       RETURNING id, currency, rate_date AS "rateDate", rate_scaled AS "rateScaled",
                 source, entered_by AS "enteredBy"`,
      [id, clientId, currency, rateDate, rateScaled, userId],
    );
    const row = upserted.rows[0];
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "upsert",
      entity: "books_fx_rate",
      entityId: String(row.id),
      after: { currency, rateDate, rateScaled },
    });
    return {
      id: String(row.id),
      currency: String(row.currency),
      rateDate: iso(row.rateDate),
      rateScaled: Number(row.rateScaled),
      source: String(row.source),
      enteredBy: String(row.enteredBy),
    };
  });
}

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

async function rateMapForDate(
  db: PoolClient,
  clientId: string,
  rateDate: string,
  currencies: string[],
): Promise<{ rates: Map<string, number>; missing: string[] }> {
  const rates = new Map<string, number>();
  const missing: string[] = [];
  for (const ccy of [...new Set(currencies)]) {
    const row = await db.query(
      // Closing rate = the latest rate on or before period end (a rate entered for the last business
      // day must count; an exact-date match made the month fail when the 30th was a weekend).
      `SELECT rate_scaled FROM books_fx_rates
       WHERE client_id = $1 AND currency = $2 AND rate_date <= $3::date
       ORDER BY rate_date DESC LIMIT 1`,
      [clientId, ccy, rateDate],
    );
    if (!row.rowCount) missing.push(ccy);
    else rates.set(ccy, Number(row.rows[0].rate_scaled));
  }
  return { rates, missing };
}

/**
 * Foreign-currency bank/card accounts that carry postings with no foreign amount (AED-only lines,
 * e.g. made before the account was switched to its currency). Revaluing them would compare a partial
 * foreign balance with the full AED balance and write most of it off as an FX loss, so they must be
 * fixed (or the gate waived) instead. Revaluation JVs and their reversals are AED-only by design.
 */
export async function fxAccountsWithUntrackedPostings(
  db: PoolClient,
  clientId: string,
  asOf: string,
): Promise<string[]> {
  const res = await db.query(
    `SELECT DISTINCT a.code
     FROM books_journal_lines l
     JOIN books_journal_entries e ON e.id = l.entry_id
     JOIN books_journal_entries be ON be.id = COALESCE(e.reverses_entry_id, e.id)
     JOIN books_accounts a ON a.id = l.account_id
     WHERE e.client_id = $1 AND a.client_id = $1 AND a.active = true AND a.is_postable = true
       AND UPPER(a.currency) <> 'AED'
       AND (a.is_bank = true OR a.is_card = true OR a.is_gateway = true
            OR COALESCE(a.sub_type, '') IN ('bank','cash','card','gateway'))
       AND e.status IN ('posted', 'reversed') AND e.deleted_at IS NULL
       AND e.entry_date <= $2::date
       AND COALESCE(be.entry_type, '') <> 'fx_revaluation'
       AND (l.original_minor IS NULL OR UPPER(l.currency) <> UPPER(a.currency))
       AND (l.debit_minor <> 0 OR l.credit_minor <> 0)
     ORDER BY a.code`,
    [clientId, asOf],
  );
  return res.rows.map((r) => String(r.code));
}

/** Foreign bank/card balances + open AR/AP in non-AED with open_original ≠ 0. */
const FX_RUN_DONE = new Set(["posted", "reversed"]);

async function assertNoUntrackedFxPostings(db: PoolClient, clientId: string, asOf: string) {
  const codes = await fxAccountsWithUntrackedPostings(db, clientId, asOf);
  if (codes.length) {
    throw new BooksError(`fx_account_missing_foreign_amounts:${codes.join(",")}`, "invalid");
  }
}

/** Revaluation differences with the closing rate (null when a rate is missing). */
async function currentFxDiffs(db: PoolClient, clientId: string, periodEnd: string) {
  const raw = await collectFxMonetaryItems(db, clientId, periodEnd);
  const { rates, missing } = await rateMapForDate(db, clientId, periodEnd, raw.map((r) => r.currency));
  if (missing.length) return null;
  return enrichItems(raw, rates);
}

export async function collectFxMonetaryItems(
  db: PoolClient,
  clientId: string,
  asOf: string,
): Promise<
  Array<{
    kind: "bank" | "ar" | "ap";
    refId: string;
    label: string;
    accountId: string;
    accountCode: string;
    currency: string;
    originalMinor: number;
    carriedAedMinor: number;
  }>
> {
  const out: Array<{
    kind: "bank" | "ar" | "ap";
    refId: string;
    label: string;
    accountId: string;
    accountCode: string;
    currency: string;
    originalMinor: number;
    carriedAedMinor: number;
  }> = [];

  const banks = await db.query(
    `SELECT a.id, a.code, a.name, UPPER(a.currency) AS currency
     FROM books_accounts a
     WHERE a.client_id = $1 AND a.active = true AND a.is_postable = true
       AND UPPER(a.currency) <> 'AED'
       AND (
         a.is_bank = true OR a.is_card = true OR a.is_gateway = true
         OR COALESCE(a.sub_type, '') IN ('bank','cash','card','gateway')
       )`,
    [clientId],
  );

  for (const acct of banks.rows) {
    const ccy = String(acct.currency);
    const bal = await db.query(
      `SELECT
         COALESCE(SUM(CASE
           WHEN UPPER(l.currency) = $3::text THEN
             CASE WHEN l.debit_minor > 0 THEN COALESCE(l.original_minor, 0)
                  ELSE -COALESCE(l.original_minor, 0) END
           ELSE 0 END), 0)::bigint AS orig,
         COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::bigint AS aed
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE e.client_id = $1 AND l.account_id = $2
         AND e.status IN ('posted', 'reversed') AND e.deleted_at IS NULL
         AND e.entry_date <= $4::date`,
      [clientId, acct.id, ccy, asOf],
    );
    const originalMinor = Number(bal.rows[0].orig);
    const carriedAedMinor = Number(bal.rows[0].aed);
    if (originalMinor === 0 && carriedAedMinor === 0) continue;
    out.push({
      kind: "bank",
      refId: String(acct.id),
      label: `${acct.code} ${acct.name}`,
      accountId: String(acct.id),
      accountCode: String(acct.code),
      currency: ccy,
      originalMinor,
      carriedAedMinor,
    });
  }

  // Open AR/AP *as of* the revaluation date, rebuilt from settlements and credit/debit notes dated on
  // or before it — not today's open-item state (an invoice paid on 3 June still belongs in May's run).
  const open = await db.query(
    `SELECT * FROM (
       SELECT oi.id, oi.side, oi.currency, p.name AS party_name,
              oi.original_minor - COALESCE(alloc.orig, 0) - COALESCE(notes.orig, 0) AS open_original_minor,
              oi.aed_original_minor - COALESCE(alloc.aed, 0) - COALESCE(notes.aed, 0) AS open_aed_minor
       FROM books_open_items oi
       JOIN books_parties p ON p.id = oi.party_id
       JOIN books_journal_entries oe ON oe.id = oi.journal_entry_id
       LEFT JOIN books_documents d ON d.id = oi.document_id
       LEFT JOIN LATERAL (
         SELECT SUM(a.allocated_original_minor) AS orig, SUM(a.allocated_aed_minor) AS aed
         FROM books_allocations a
         JOIN books_journal_entries se ON se.id = a.settlement_journal_id
         WHERE a.open_item_id = oi.id AND se.status = 'posted' AND se.deleted_at IS NULL
           AND se.entry_date <= $2::date
       ) alloc ON true
       LEFT JOIN LATERAL (
         SELECT SUM(n.original_total_minor) AS orig, SUM(n.aed_total_minor) AS aed
         FROM books_documents n
         WHERE d.id IS NOT NULL AND n.original_document_id = d.id AND n.client_id = $1
           AND n.status = 'posted' AND n.deleted_at IS NULL
           AND n.doc_type IN ('credit_note', 'debit_note') AND n.issue_date <= $2::date
       ) notes ON true
       WHERE oi.client_id = $1
         AND UPPER(oi.currency) <> 'AED'
         -- A voided invoice / payment has its journal marked 'reversed': it no longer counts.
         AND oe.status = 'posted' AND oe.deleted_at IS NULL AND oe.entry_date <= $2::date
         AND (d.id IS NULL OR (d.status = 'posted' AND d.deleted_at IS NULL))
     ) x
     WHERE x.open_original_minor > 0`,
    [clientId, asOf],
  );

  for (const row of open.rows) {
    const side = String(row.side) === "AP" ? "ap" : "ar";
    const controlCode = side === "ap" ? AP_CONTROL : AR_CONTROL;
    const acct = await db.query(
      `SELECT id, code FROM books_accounts
       WHERE client_id = $1 AND code = $2 AND active = true`,
      [clientId, controlCode],
    );
    if (!acct.rowCount) continue;
    out.push({
      kind: side,
      refId: String(row.id),
      label: `${side.toUpperCase()} ${row.party_name}`,
      accountId: String(acct.rows[0].id),
      accountCode: String(acct.rows[0].code),
      currency: String(row.currency).toUpperCase(),
      originalMinor: Number(row.open_original_minor),
      carriedAedMinor: Number(row.open_aed_minor),
    });
  }

  return out;
}

export function buildFxRevaluationLines(
  items: FxRevalItem[],
  fxAccountId: string,
): BooksLineInput[] {
  const lines: BooksLineInput[] = [];
  let net7310 = 0; // >0 → Dr 7310 (net loss); <0 → Cr 7310 (net gain)

  for (const item of items) {
    if (item.diffAedMinor === 0) continue;
    const abs = Math.abs(item.diffAedMinor);
    if (item.kind === "bank" || item.kind === "ar") {
      // Asset: revalued > carried → Dr account / gain; else Cr account / loss
      if (item.diffAedMinor > 0) {
        lines.push({
          accountId: item.accountId,
          debitMinor: abs,
          creditMinor: 0,
          lineMemo: `FX reval ${item.label}`,
        });
        net7310 -= abs;
      } else {
        lines.push({
          accountId: item.accountId,
          debitMinor: 0,
          creditMinor: abs,
          lineMemo: `FX reval ${item.label}`,
        });
        net7310 += abs;
      }
    } else {
      // Liability AP: revalued > carried → Cr AP / loss; else Dr AP / gain
      if (item.diffAedMinor > 0) {
        lines.push({
          accountId: item.accountId,
          debitMinor: 0,
          creditMinor: abs,
          lineMemo: `FX reval ${item.label}`,
        });
        net7310 += abs;
      } else {
        lines.push({
          accountId: item.accountId,
          debitMinor: abs,
          creditMinor: 0,
          lineMemo: `FX reval ${item.label}`,
        });
        net7310 -= abs;
      }
    }
  }

  if (net7310 > 0) {
    lines.push({
      accountId: fxAccountId,
      debitMinor: net7310,
      creditMinor: 0,
      lineMemo: "FX unrealised (net)",
    });
  } else if (net7310 < 0) {
    lines.push({
      accountId: fxAccountId,
      debitMinor: 0,
      creditMinor: -net7310,
      lineMemo: "FX unrealised (net)",
    });
  }
  return lines;
}

async function enrichItems(
  raw: Awaited<ReturnType<typeof collectFxMonetaryItems>>,
  rates: Map<string, number>,
): Promise<FxRevalItem[]> {
  return raw.map((r) => {
    const rate = rates.get(r.currency)!;
    const revaluedAedMinor = aedFromOriginal(r.originalMinor, rate);
    return {
      ...r,
      revaluedAedMinor,
      diffAedMinor: revaluedAedMinor - r.carriedAedMinor,
    };
  });
}

export async function previewBooksFxRevaluation(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<{
  periodEnd: string;
  items: FxRevalItem[];
  missingRates: string[];
  totalDiffAedMinor: number;
}> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const period = await loadPeriod(db, clientId, periodId);
    await assertNoUntrackedFxPostings(db, clientId, period.end);
    const raw = await collectFxMonetaryItems(db, clientId, period.end);
    const { rates, missing } = await rateMapForDate(
      db,
      clientId,
      period.end,
      raw.map((r) => r.currency),
    );
    if (missing.length) {
      return {
        periodEnd: period.end,
        items: [],
        missingRates: missing,
        totalDiffAedMinor: 0,
      };
    }
    const items = await enrichItems(raw, rates);
    return {
      periodEnd: period.end,
      items,
      missingRates: [],
      totalDiffAedMinor: items.reduce((s, i) => s + i.diffAedMinor, 0),
    };
  });
}

/**
 * Create/replace draft FX revaluation JV for the period (dual-control post later).
 * Idempotent: replaces draft; refuses if a posted run exists (until reversed).
 */
export async function runBooksFxRevaluation(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<{
  journalEntryId: string | null;
  status: string | null;
  kind: "journal" | "noop";
  created: boolean;
  replaced: boolean;
  missingRates: string[];
  itemCount: number;
  totalDiffAedMinor: number;
}> {
  const prep = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const period = await loadPeriod(db, clientId, periodId);
    if (!["OPEN", "REOPENED"].includes(period.status)) {
      throw new BooksError("period_locked", "period_closed");
    }

    const existing = await db.query(
      `SELECT r.id, r.journal_entry_id AS "journalEntryId", r.kind, e.status AS "entryStatus"
       FROM books_fx_revaluation_runs r
       LEFT JOIN books_journal_entries e ON e.id = r.journal_entry_id AND e.deleted_at IS NULL
       WHERE r.client_id = $1 AND r.period_id = $2`,
      [clientId, periodId],
    );
    if (existing.rowCount) {
      const ex = existing.rows[0];
      // Once posted, the JV auto-reverses next month and its status becomes 'reversed' — still done.
      // Re-running then would revalue AR/AP a second time and overwrite the link to the posted JV.
      if (ex.kind === "journal" && FX_RUN_DONE.has(String(ex.entryStatus))) {
        throw new BooksError("fx_revaluation_already_posted", "conflict");
      }
    }

    await assertNoUntrackedFxPostings(db, clientId, period.end);
    const raw = await collectFxMonetaryItems(db, clientId, period.end);
    const { rates, missing } = await rateMapForDate(
      db,
      clientId,
      period.end,
      raw.map((r) => r.currency),
    );
    if (missing.length) {
      throw new BooksError(`fx_rate_missing:${missing.sort().join(",")}`, "invalid");
    }

    const fxAcct = await db.query(
      `SELECT id FROM books_accounts WHERE client_id = $1 AND code = $2 AND active = true`,
      [clientId, FX_UNREALISED],
    );
    if (!fxAcct.rowCount) throw new BooksError(`account_missing:${FX_UNREALISED}`, "not_found");

    const items = await enrichItems(raw, rates);
    const nonzero = items.filter((i) => i.diffAedMinor !== 0);
    return {
      period,
      items,
      nonzero,
      fxAccountId: String(fxAcct.rows[0].id),
      existingRunId: existing.rowCount ? String(existing.rows[0].id) : null,
      existingJournalId: existing.rows[0]?.journalEntryId
        ? String(existing.rows[0].journalEntryId)
        : null,
      existingStatus: existing.rows[0]?.entryStatus ? String(existing.rows[0].entryStatus) : null,
      existingKind: existing.rows[0]?.kind ? String(existing.rows[0].kind) : null,
    };
  });

  let replaced = false;
  if (prep.existingJournalId && prep.existingStatus === "draft") {
    await softDeleteBooksJournalDraft(userId, clientId, prep.existingJournalId);
    replaced = true;
  }

  if (prep.nonzero.length === 0) {
    await withUser(userId, async (db) => {
      if (prep.existingRunId) {
        await db.query(
          `UPDATE books_fx_revaluation_runs
           SET journal_entry_id = NULL, kind = 'noop'
           WHERE id = $1`,
          [prep.existingRunId],
        );
      } else {
        await db.query(
          `INSERT INTO books_fx_revaluation_runs (id, client_id, period_id, journal_entry_id, kind)
           VALUES ($1,$2,$3,NULL,'noop')`,
          [randomUUID(), clientId, periodId],
        );
      }
      await writeBooksAudit(db, {
        clientId,
        actor: userId,
        action: "create",
        entity: "books_fx_revaluation_run",
        entityId: periodId,
        after: { kind: "noop", itemCount: prep.items.length },
      });
    });
    return {
      journalEntryId: null,
      status: null,
      kind: "noop",
      created: true,
      replaced,
      missingRates: [],
      itemCount: prep.items.length,
      totalDiffAedMinor: 0,
    };
  }

  const lines = buildFxRevaluationLines(prep.nonzero, prep.fxAccountId);
  const journal = await createBooksJournal(userId, clientId, {
    periodId,
    entryDate: prep.period.end,
    memo: `FX revaluation ${prep.period.label}`,
    voucherType: "Journal",
    entryType: "fx_revaluation",
    autoReverseNextPeriod: true,
    lines,
    post: false,
    // Revaluation adjusts AR/AP control balances to closing FX rates.
    allowControlAccounts: true,
  });

  await withUser(userId, async (db) => {
    if (prep.existingRunId) {
      await db.query(
        `UPDATE books_fx_revaluation_runs
         SET journal_entry_id = $2, kind = 'journal'
         WHERE id = $1`,
        [prep.existingRunId, journal.id],
      );
    } else {
      await db.query(
        `INSERT INTO books_fx_revaluation_runs (id, client_id, period_id, journal_entry_id, kind)
         VALUES ($1,$2,$3,$4,'journal')`,
        [randomUUID(), clientId, periodId, journal.id],
      );
    }
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_fx_revaluation_run",
      entityId: journal.id,
      after: {
        periodId,
        itemCount: prep.nonzero.length,
        totalDiffAedMinor: prep.nonzero.reduce((s, i) => s + i.diffAedMinor, 0),
      },
    });
  });

  return {
    journalEntryId: journal.id,
    status: journal.status,
    kind: "journal",
    created: true,
    replaced,
    missingRates: [],
    itemCount: prep.nonzero.length,
    totalDiffAedMinor: prep.nonzero.reduce((s, i) => s + i.diffAedMinor, 0),
  };
}

/** Close-gate helper. */
export async function fxRevaluationGateState(
  db: PoolClient,
  clientId: string,
  periodId: string,
  periodEnd: string,
): Promise<{
  status: "pass" | "fail";
  count: number;
  detail: string;
  missingRates: string[];
}> {
  const untracked = await fxAccountsWithUntrackedPostings(db, clientId, periodEnd);
  if (untracked.length) {
    return {
      status: "fail",
      count: untracked.length,
      detail: `Foreign-currency account(s) ${untracked.join(", ")} have postings without a foreign amount — fix them before revaluing`,
      missingRates: [],
    };
  }
  const raw = await collectFxMonetaryItems(db, clientId, periodEnd);
  if (raw.length === 0) {
    return { status: "pass", count: 0, detail: "No foreign-currency monetary balances", missingRates: [] };
  }
  const { missing } = await rateMapForDate(
    db,
    clientId,
    periodEnd,
    raw.map((r) => r.currency),
  );
  if (missing.length) {
    return {
      status: "fail",
      count: missing.length,
      detail: `Missing rates for ${periodEnd}: ${missing.sort().join(", ")}`,
      missingRates: missing,
    };
  }

  const run = await db.query(
    `SELECT r.kind, r.journal_entry_id, e.status
     FROM books_fx_revaluation_runs r
     LEFT JOIN books_journal_entries e ON e.id = r.journal_entry_id AND e.deleted_at IS NULL
     WHERE r.client_id = $1 AND r.period_id = $2`,
    [clientId, periodId],
  );
  if (!run.rowCount) {
    return {
      status: "fail",
      count: raw.length,
      detail: `Missing FX revaluation run (${raw.length} monetary item(s))`,
      missingRates: [],
    };
  }
  const kind = String(run.rows[0].kind);
  const entryStatus = String(run.rows[0].status || "");
  if (kind === "noop" || FX_RUN_DONE.has(entryStatus)) {
    // A run only stays valid while the balances it measured are unchanged. After a posted run the
    // bank carrying amounts include the revaluation, so they must now show no difference; open AR/AP
    // are carried at booking rates, so only a noop run can be re-checked for them.
    const items = await currentFxDiffs(db, clientId, periodEnd);
    const stale = (items || []).filter(
      (i) => i.diffAedMinor !== 0 && (kind === "noop" || i.kind === "bank"),
    );
    if (stale.length) {
      const diff = stale.reduce((s, i) => s + i.diffAedMinor, 0);
      return {
        status: "fail",
        count: stale.length,
        detail:
          kind === "noop"
            ? `Foreign balances changed since the FX run (difference ${diff} fils) — run it again`
            : `Foreign bank balances changed after the FX revaluation was posted (difference ${diff} fils) — post an adjustment or waive`,
        missingRates: [],
      };
    }
    return {
      status: "pass",
      count: 0,
      detail: kind === "noop" ? "FX revaluation noop (no differences)" : "FX revaluation posted for period",
      missingRates: [],
    };
  }
  return {
    status: "fail",
    count: 1,
    detail: "FX revaluation draft exists — approver must post",
    missingRates: [],
  };
}
