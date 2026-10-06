/**
 * Test-only helper: fresh synthetic company so parallel writers do not pollute DESERT.
 * Uses admin/super connections only — not imported by production routes.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

const DESERT = "e1000001-0000-4000-8000-000000000001";
const FIRM = "11111111-1111-4111-8111-111111111111";
const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";

export type TestCompany = {
  clientId: string;
  /** Period label → id (e.g. "May 2026") */
  periods: Record<string, string>;
  accountIdByCode: Record<string, string>;
};

export type CreateTestCompanyOptions = {
  /** Period labels to leave LOCKED after create (default: all OPEN). */
  lockPeriodLabels?: string[];
};

/**
 * Creates a new synthetic client with DESERT's COA (via template), VAT codes (global),
 * monthly periods (all OPEN unless lockPeriodLabels), voucher sequences, and Omar/Layla access.
 */
export async function createTestCompany(
  admin: pg.Client,
  label: string,
  options: CreateTestCompanyOptions = {},
): Promise<TestCompany> {
  const clientId = randomUUID();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = `Test Co ${label} ${stamp}`;
  // 15-digit synthetic TRN unique per call (UAE-shaped, not a real client).
  const trn = `9${String(Math.floor(Math.random() * 1e14)).padStart(14, "0")}`.slice(0, 15);

  await admin.query(
    `INSERT INTO clients (
       id, firm_id, name, trn, default_currency, is_synthetic, fiscal_year_start_month
     ) VALUES ($1, $2, $3, $4, 'AED', true, 1)`,
    [clientId, FIRM, name, trn],
  );

  // Same COA DESERT received (books_copy_coa_template after COA v2).
  await admin.query(`SELECT books_copy_coa_template($1::uuid)`, [clientId]);

  // Copy DESERT's monthly period calendar; force all OPEN so writers can post.
  await admin.query(
    `INSERT INTO books_periods (id, client_id, label, period_start, period_end, status)
     SELECT gen_random_uuid(), $1, label, period_start, period_end, 'OPEN'
     FROM books_periods
     WHERE client_id = $2`,
    [clientId, DESERT],
  );

  const may = await admin.query(
    `SELECT id FROM books_periods WHERE client_id = $1 AND label = 'May 2026'`,
    [clientId],
  );
  if (may.rows[0]?.id) {
    await admin.query(`UPDATE clients SET books_start_period_id = $1 WHERE id = $2`, [
      may.rows[0].id,
      clientId,
    ]);
  }

  // Voucher number series (same seed as synthetic clients in db/22).
  await admin.query(
    `INSERT INTO books_voucher_sequences (client_id, voucher_type, year, prefix, last_n)
     SELECT $1, v.voucher_type, 2026, books_voucher_prefix(v.voucher_type), 0
     FROM (VALUES
       ('Sales'), ('Purchase'), ('Receipt'), ('Payment'), ('Contra'),
       ('Journal'), ('Credit Note'), ('Debit Note'), ('Opening'), ('Closing'),
       ('Expense')
     ) AS v(voucher_type)
     ON CONFLICT DO NOTHING`,
    [clientId],
  );

  // Omar (preparer) + Layla (approver) — same access pattern as DESERT.
  await admin.query(
    `INSERT INTO user_client_access (user_id, client_id) VALUES
       ($1, $3),
       ($2, $3)
     ON CONFLICT DO NOTHING`,
    [OMAR, LAYLA, clientId],
  );

  const periodRows = await admin.query(
    `SELECT id, label FROM books_periods WHERE client_id = $1`,
    [clientId],
  );
  const periods: Record<string, string> = {};
  for (const r of periodRows.rows) {
    periods[String(r.label)] = String(r.id);
  }

  for (const labelToLock of options.lockPeriodLabels ?? []) {
    const pid = periods[labelToLock];
    if (pid) {
      await admin.query(`UPDATE books_periods SET status = 'LOCKED' WHERE id = $1`, [pid]);
    }
  }

  const accountRows = await admin.query(
    `SELECT id, code FROM books_accounts WHERE client_id = $1 AND active = true`,
    [clientId],
  );
  const accountIdByCode: Record<string, string> = {};
  for (const r of accountRows.rows) {
    accountIdByCode[String(r.code)] = String(r.id);
  }

  return { clientId, periods, accountIdByCode };
}
