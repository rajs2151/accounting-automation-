import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { fiscalYearForDate } from "@/lib/fiscal-year";
import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { requireApproverOrAdmin } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { fiscalYearBounds } from "@/server/books/period-columns";
import { assertSyntheticTenant } from "@/server/security-gate";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(year: number, month1: number) {
  return `${MONTH_LABELS[month1 - 1]} ${year}`;
}

function lastDayOfMonth(year: number, month1: number) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical uuid string; ids from URLs/bodies are checked before they reach a uuid column. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Throws a 400 BooksError (`message`, e.g. "invalid_period_id") unless `value` is a uuid. */
export function assertUuid(value: unknown, message: string): asserts value is string {
  if (!isUuid(value)) throw new BooksError(message, "invalid");
}

/** True for a real calendar date written YYYY-MM-DD (rejects 2026-02-30, 2026-13-01, "abc"). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export async function listBooksPeriods(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, label, period_start AS "periodStart", period_end AS "periodEnd", status
       FROM books_periods
       WHERE client_id = $1
       ORDER BY period_start DESC`,
      [clientId],
    );
    return rows.rows;
  });
}

export async function createBooksPeriod(
  userId: string,
  clientId: string,
  body: { label: string; periodStart: string; periodEnd: string },
) {
  const label = String(body.label || "").trim();
  const periodStart = String(body.periodStart || "").trim();
  const periodEnd = String(body.periodEnd || "").trim();
  if (!label) throw new BooksError("period_label_required", "invalid");
  if (!isIsoDate(periodStart) || !isIsoDate(periodEnd)) throw new BooksError("invalid_date", "invalid");
  if (periodStart > periodEnd) throw new BooksError("invalid_date_range", "invalid");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    // Serialise period creation per client so two concurrent requests can't both pass the overlap check.
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('books_periods:' || $1::text))`, [clientId]);
    const overlap = await db.query(
      `SELECT label FROM books_periods
       WHERE client_id = $1 AND period_start <= $3::date AND period_end >= $2::date
       ORDER BY period_start LIMIT 1`,
      [clientId, periodStart, periodEnd],
    );
    if (overlap.rowCount) {
      throw new BooksError(`period_overlaps:${String(overlap.rows[0].label)}`, "conflict");
    }
    const sameLabel = await db.query(
      `SELECT 1 FROM books_periods WHERE client_id = $1 AND label = $2`,
      [clientId, label],
    );
    if (sameLabel.rowCount) throw new BooksError("period_label_exists", "conflict");
    const id = randomUUID();
    await db.query(
      `INSERT INTO books_periods (id, client_id, label, period_start, period_end, status)
       VALUES ($1,$2,$3,$4,$5,'OPEN')`,
      [id, clientId, label, periodStart, periodEnd],
    );
    const created = { label, periodStart, periodEnd };
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_period",
      entityId: id,
      after: created,
    });
    return { id, ...created, status: "OPEN" };
  });
}

export async function ensureBooksMonths(
  userId: string,
  clientId: string,
  opts: { year: number; fromMonth?: number; toMonth?: number },
) {
  const fromMonth = opts.fromMonth ?? 1;
  const toMonth = opts.toMonth ?? 12;
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const created: string[] = [];
    for (let m = fromMonth; m <= toMonth; m++) {
      const label = monthLabel(opts.year, m);
      const start = `${opts.year}-${String(m).padStart(2, "0")}-01`;
      const end = `${opts.year}-${String(m).padStart(2, "0")}-${String(lastDayOfMonth(opts.year, m)).padStart(2, "0")}`;
      const existing = await db.query(
        `SELECT id FROM books_periods WHERE client_id = $1 AND label = $2`,
        [clientId, label],
      );
      if (existing.rowCount) continue;
      const id = randomUUID();
      await db.query(
        `INSERT INTO books_periods (id, client_id, label, period_start, period_end, status)
         VALUES ($1,$2,$3,$4,$5,'OPEN')`,
        [id, clientId, label, start, end],
      );
      created.push(id);
    }
    return { created };
  });
}

/**
 * D2: within a fiscal year, month N may lock only if month N−1 is LOCKED
 * (or N is the books-start month / first period of the FY that exists).
 */
export async function priorPeriodLockState(
  db: PoolClient,
  clientId: string,
  periodId: string,
): Promise<{
  ok: boolean;
  isBooksStart: boolean;
  priorPeriodId: string | null;
  priorLabel: string | null;
  priorStatus: string | null;
  detail: string;
}> {
  const period = await db.query(
    `SELECT id, label, period_start, period_end, status
     FROM books_periods WHERE id = $1 AND client_id = $2`,
    [periodId, clientId],
  );
  if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
  const start = String(period.rows[0].period_start).slice(0, 10);

  const client = await db.query(
    `SELECT fiscal_year_start_month AS m, books_start_period_id FROM clients WHERE id = $1`,
    [clientId],
  );
  const fyStartMonth = Number(client.rows[0]?.m || 1);
  const booksStartId = client.rows[0]?.books_start_period_id
    ? String(client.rows[0].books_start_period_id)
    : null;

  if (booksStartId && booksStartId === periodId) {
    return {
      ok: true,
      isBooksStart: true,
      priorPeriodId: null,
      priorLabel: null,
      priorStatus: null,
      detail: "Books-start month — no prior lock required",
    };
  }

  const fy = fiscalYearForDate(start, fyStartMonth);
  const bounds = fiscalYearBounds(fy, fyStartMonth);
  // First month of the fiscal year that exists in books: no prior in-FY period.
  if (start === bounds.start) {
    return {
      ok: true,
      isBooksStart: false,
      priorPeriodId: null,
      priorLabel: null,
      priorStatus: null,
      detail: "First month of the fiscal year",
    };
  }

  const prior = await db.query(
    `SELECT id, label, status, period_end
     FROM books_periods
     WHERE client_id = $1
       AND period_end < $2::date
       AND period_start >= $3::date
     ORDER BY period_end DESC
     LIMIT 1`,
    [clientId, start, bounds.start],
  );
  if (!prior.rowCount) {
    // No earlier FY period in the DB (e.g. books started mid-year without books_start set).
    return {
      ok: true,
      isBooksStart: false,
      priorPeriodId: null,
      priorLabel: null,
      priorStatus: null,
      detail: "No prior period in this fiscal year",
    };
  }
  const priorStatus = String(prior.rows[0].status);
  const priorLabel = String(prior.rows[0].label);
  const priorPeriodId = String(prior.rows[0].id);
  if (priorStatus === "LOCKED") {
    return {
      ok: true,
      isBooksStart: false,
      priorPeriodId,
      priorLabel,
      priorStatus,
      detail: `Prior month ${priorLabel} is locked`,
    };
  }
  return {
    ok: false,
    isBooksStart: false,
    priorPeriodId,
    priorLabel,
    priorStatus,
    detail: `Lock ${priorLabel} before locking this month (sequential period lock)`,
  };
}

export async function lockBooksPeriod(userId: string, clientId: string, periodId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireApproverOrAdmin(db, userId, "lock");
    const before = await db.query(`SELECT status FROM books_periods WHERE id = $1 AND client_id = $2`, [
      periodId,
      clientId,
    ]);
    if (!before.rowCount) throw new BooksError("period_not_found", "not_found");
    const seq = await priorPeriodLockState(db, clientId, periodId);
    if (!seq.ok) throw new BooksError("prior_period_not_locked", "conflict");
    await db.query(`UPDATE books_periods SET status = 'LOCKED' WHERE id = $1 AND client_id = $2`, [
      periodId,
      clientId,
    ]);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "lock",
      entity: "books_period",
      entityId: periodId,
      before: before.rows[0],
      after: { status: "LOCKED" },
    });
    return { id: periodId, status: "LOCKED" };
  });
}

export async function reopenBooksPeriod(
  userId: string,
  clientId: string,
  periodId: string,
  reason: string,
) {
  if (!reason?.trim()) throw new BooksError("reopen_reason_required", "invalid");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireApproverOrAdmin(db, userId, "unlock");
    const before = await db.query(`SELECT status FROM books_periods WHERE id = $1 AND client_id = $2`, [
      periodId,
      clientId,
    ]);
    if (!before.rowCount) throw new BooksError("period_not_found", "not_found");
    if (String(before.rows[0].status) !== "LOCKED") {
      throw new BooksError("period_not_locked", "conflict");
    }
    const updated = await db.query(
      `UPDATE books_periods SET status = 'REOPENED', reopen_reason = $3
       WHERE id = $1 AND client_id = $2 AND status = 'LOCKED'`,
      [periodId, clientId, reason.trim()],
    );
    if (!updated.rowCount) throw new BooksError("period_not_locked", "conflict");
    // Close-gate waivers do not survive a reopen: loadWaivers (close.ts) ignores any waiver
    // dated at or before the latest 'unlock' audit event, so the next lock re-evaluates them.
    const waivers = await db.query(
      `SELECT gate_key, reason FROM books_close_waivers
       WHERE client_id = $1 AND period_id = $2
       ORDER BY gate_key`,
      [clientId, periodId],
    );
    const invalidatedWaivers = waivers.rows.map((r) => ({
      gate: String(r.gate_key),
      reason: String(r.reason),
    }));
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "unlock",
      entity: "books_period",
      entityId: periodId,
      before: before.rows[0],
      after: { status: "REOPENED", reason: reason.trim(), invalidatedWaivers },
    });
    return { id: periodId, status: "REOPENED", reason: reason.trim(), invalidatedWaivers };
  });
}
