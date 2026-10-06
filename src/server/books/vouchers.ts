import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { fiscalYearForDate } from "@/lib/fiscal-year";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

async function clientFiscalYear(db: PoolClient, clientId: string, asOfIso?: string) {
  const row = await db.query(
    `SELECT fiscal_year_start_month AS m FROM clients WHERE id = $1`,
    [clientId],
  );
  const fyStart = Number(row.rows[0]?.m || 1);
  const asOf = asOfIso || new Date().toISOString().slice(0, 10);
  return { fyStart, year: fiscalYearForDate(asOf, fyStart) };
}

export const VOUCHER_TYPES = [
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
  "Expense",
] as const;

export type VoucherType = (typeof VOUCHER_TYPES)[number];

export function isVoucherType(value: string): value is VoucherType {
  return (VOUCHER_TYPES as readonly string[]).includes(value);
}

export async function listBooksVoucherSequences(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const { year, fyStart } = await clientFiscalYear(db, clientId);
    const rows = await db.query(
      `SELECT voucher_type AS "voucherType", year, prefix, last_n AS "lastN"
       FROM books_voucher_sequences
       WHERE client_id = $1 AND year = $2
       ORDER BY voucher_type`,
      [clientId, year],
    );
    if (rows.rowCount) {
      return rows.rows.map((r) => ({ ...r, fiscalYearStartMonth: fyStart }));
    }
    for (const vt of VOUCHER_TYPES) {
      await db.query(
        `INSERT INTO books_voucher_sequences (client_id, voucher_type, year, prefix, last_n)
         VALUES ($1, $2, $3, books_voucher_prefix($2), 0)
         ON CONFLICT DO NOTHING`,
        [clientId, vt, year],
      );
    }
    const again = await db.query(
      `SELECT voucher_type AS "voucherType", year, prefix, last_n AS "lastN"
       FROM books_voucher_sequences
       WHERE client_id = $1 AND year = $2
       ORDER BY voucher_type`,
      [clientId, year],
    );
    return again.rows.map((r) => ({ ...r, fiscalYearStartMonth: fyStart }));
  });
}

export async function updateBooksVoucherSequence(
  userId: string,
  clientId: string,
  body: { voucherType: string; year?: number; prefix?: string; lastN?: number },
) {
  if (!isVoucherType(body.voucherType)) {
    throw new BooksError("invalid_voucher_type", "invalid");
  }
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const { year: defaultYear } = await clientFiscalYear(db, clientId);
    const year = body.year ?? defaultYear;
    const before = await db.query(
      `SELECT prefix, last_n AS "lastN" FROM books_voucher_sequences
       WHERE client_id = $1 AND voucher_type = $2 AND year = $3`,
      [clientId, body.voucherType, year],
    );
    await db.query(
      `INSERT INTO books_voucher_sequences (client_id, voucher_type, year, prefix, last_n)
       VALUES ($1, $2, $3, COALESCE($4, books_voucher_prefix($2)), COALESCE($5, 0))
       ON CONFLICT (client_id, voucher_type, year) DO UPDATE SET
         prefix = COALESCE($4, books_voucher_sequences.prefix),
         last_n = COALESCE($5, books_voucher_sequences.last_n)`,
      [
        clientId,
        body.voucherType,
        year,
        body.prefix?.trim() || null,
        body.lastN == null ? null : Math.max(0, Math.floor(body.lastN)),
      ],
    );
    const after = await db.query(
      `SELECT voucher_type AS "voucherType", year, prefix, last_n AS "lastN"
       FROM books_voucher_sequences
       WHERE client_id = $1 AND voucher_type = $2 AND year = $3`,
      [clientId, body.voucherType, year],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update_numbering",
      entity: "books_voucher_sequence",
      entityId: clientId,
      before: before.rows[0] || null,
      after: after.rows[0],
    });
    return after.rows[0];
  });
}
