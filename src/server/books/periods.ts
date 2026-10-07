import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { requireApproverOrAdmin } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(year: number, month1: number) {
  return `${MONTH_LABELS[month1 - 1]} ${year}`;
}

function lastDayOfMonth(year: number, month1: number) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
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
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const id = randomUUID();
    await db.query(
      `INSERT INTO books_periods (id, client_id, label, period_start, period_end, status)
       VALUES ($1,$2,$3,$4,$5,'OPEN')`,
      [id, clientId, body.label, body.periodStart, body.periodEnd],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_period",
      entityId: id,
      after: body,
    });
    return { id, ...body, status: "OPEN" };
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

export async function lockBooksPeriod(userId: string, clientId: string, periodId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireApproverOrAdmin(db, userId, "lock");
    const before = await db.query(`SELECT status FROM books_periods WHERE id = $1 AND client_id = $2`, [
      periodId,
      clientId,
    ]);
    if (!before.rowCount) throw new BooksError("period_not_found", "not_found");
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
