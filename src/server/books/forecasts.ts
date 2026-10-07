/**
 * P6-4d: projection / forecast layer — never written to journals; excluded from actuals reports.
 */
import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export type ForecastMethod = "trailing_avg_3" | "trailing_avg_6" | "linear" | "override";

/** Trailing average of the last `n` amounts (fils). Uses all available if fewer than n. */
export function trailingAverageMinor(amounts: number[], n: number): number {
  const window = Math.max(1, Math.floor(n));
  if (!amounts.length) return 0;
  const slice = amounts.slice(-window);
  const sum = slice.reduce((s, v) => s + Math.trunc(v), 0);
  return Math.floor(sum / slice.length);
}

/** Simple linear next value from last two points; falls back to last value. */
export function linearNextMinor(amounts: number[]): number {
  if (!amounts.length) return 0;
  if (amounts.length === 1) return Math.trunc(amounts[0]);
  const a = Math.trunc(amounts[amounts.length - 2]);
  const b = Math.trunc(amounts[amounts.length - 1]);
  return b + (b - a);
}

export function projectAmountMinor(
  method: ForecastMethod,
  historyMinor: number[],
  opts?: { overrideMinor?: number; growthPct?: number },
): number {
  if (method === "override") return Math.trunc(opts?.overrideMinor ?? 0);
  if (method === "trailing_avg_3") return trailingAverageMinor(historyMinor, 3);
  if (method === "trailing_avg_6") return trailingAverageMinor(historyMinor, 6);
  if (method === "linear") {
    const base = linearNextMinor(historyMinor);
    const g = Number(opts?.growthPct);
    if (!Number.isFinite(g) || g === 0) return base;
    return Math.floor((base * (10000 + Math.trunc(g * 100))) / 10000);
  }
  throw new BooksError("invalid_forecast_method", "invalid");
}

export async function listBooksForecasts(
  userId: string,
  clientId: string,
  opts?: { periodId?: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT f.id, f.account_id AS "accountId", f.period_id AS "periodId",
              f.amount_minor AS "amountMinor", f.method, f.growth_pct AS "growthPct",
              a.code AS "accountCode", a.name AS "accountName", p.label AS "periodLabel"
       FROM books_forecasts f
       JOIN books_accounts a ON a.id = f.account_id
       JOIN books_periods p ON p.id = f.period_id
       WHERE f.client_id = $1
         AND ($2::uuid IS NULL OR f.period_id = $2::uuid)
       ORDER BY p.period_start, a.code`,
      [clientId, opts?.periodId || null],
    );
    return rows.rows.map((r) => ({
      ...r,
      amountMinor: Number(r.amountMinor),
      growthPct: r.growthPct == null ? null : Number(r.growthPct),
    }));
  });
}

export async function upsertBooksForecast(
  userId: string,
  clientId: string,
  body: {
    accountId: string;
    periodId: string;
    amountMinor: number;
    method: ForecastMethod;
    growthPct?: number | null;
  },
) {
  const methods = new Set(["trailing_avg_3", "trailing_avg_6", "linear", "override"]);
  if (!methods.has(body.method)) throw new BooksError("invalid_forecast_method", "invalid");
  const amount = Math.trunc(Number(body.amountMinor));
  if (!Number.isFinite(amount)) throw new BooksError("invalid_forecast_amount", "invalid");

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const id = randomUUID();
    const row = await db.query(
      `INSERT INTO books_forecasts (
         id, client_id, account_id, period_id, amount_minor, method, growth_pct, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (client_id, account_id, period_id) DO UPDATE SET
         amount_minor = EXCLUDED.amount_minor,
         method = EXCLUDED.method,
         growth_pct = EXCLUDED.growth_pct,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING id, amount_minor AS "amountMinor", method`,
      [
        id,
        clientId,
        body.accountId,
        body.periodId,
        amount,
        body.method,
        body.growthPct == null ? null : Number(body.growthPct),
        userId,
      ],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "upsert",
      entity: "books_forecast",
      entityId: String(row.rows[0].id),
      after: body,
    });
    return {
      id: String(row.rows[0].id),
      amountMinor: Number(row.rows[0].amountMinor),
      method: String(row.rows[0].method),
    };
  });
}
