import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { fiscalYearForDate } from "@/lib/fiscal-year";
import { assertMinor } from "@/lib/money";
import { firstOfNextMonthIso, firstOfNextMonthUtc } from "@/lib/schedule-dates";
import { markPeriodChangedSinceClose } from "@/server/books/close";
import { linkBooksJournalAttachments } from "@/server/books/attachments";
import { writeBooksAudit } from "@/server/books/audit";
import { isBooksControlAccountCode, isPureVatSettlement } from "@/server/books/control-accounts";
import { requireDualControlActor } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { enqueueBooksJob } from "@/server/books/jobs";
import { expandVatCompanionLines, type BooksLineDraft } from "@/server/books/vat-lines";
import { isVoucherType, type VoucherType } from "@/server/books/vouchers";
import { assertSyntheticTenant } from "@/server/security-gate";

export type BooksLineInput = BooksLineDraft;

export type JournalListFilters = {
  periodId?: string;
  /** Comma-separated or single status */
  status?: string;
  /** Comma-separated entry types */
  entryType?: string;
  /** Comma-separated voucher types */
  voucherType?: string;
  tag?: string;
  tags?: string[];
  reference?: string;
  q?: string;
  fromDate?: string;
  toDate?: string;
  accountIds?: string[];
  amountMinMinor?: number;
  amountMaxMinor?: number;
  createdBy?: string;
  postedBy?: string;
  hasAttachment?: boolean;
};

function sumSides(lines: BooksLineInput[]) {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    const d = line.debitMinor ?? 0;
    const c = line.creditMinor ?? 0;
    assertMinor(d);
    assertMinor(c);
    if (d < 0 || c < 0) throw new BooksError("negative_amount", "invalid_money");
    if (d > 0 && c > 0) throw new BooksError("both_sides", "invalid_line");
    if (d === 0 && c === 0) throw new BooksError("empty_line", "invalid_line");
    debit += d;
    credit += c;
  }
  return { debit, credit, balanced: debit === credit && debit > 0 };
}

export function assertBooksBalanced(lines: BooksLineInput[]) {
  const result = sumSides(lines);
  if (!result.balanced) {
    throw new BooksError(`unbalanced debit=${result.debit} credit=${result.credit}`, "journal_unbalanced");
  }
  return result;
}

function hashEntry(memo: string, entryDate: string, lines: BooksLineInput[]) {
  return createHash("sha256").update(JSON.stringify({ memo, entryDate, lines })).digest("hex");
}

function isoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function dayBeforeIso(d: string): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/**
 * Period must be OPEN/REOPENED. With entryDate: the date must fall inside the period, and no
 * LOCKED period may contain that date (reports aggregate by entry_date, not period_id).
 * Only exception: an Opening voucher may be dated the day before its period starts (opening
 * balances as at the books-start cut-over); the LOCKED-containing-period check still applies.
 */
async function requireWritablePeriod(
  db: PoolClient,
  clientId: string,
  periodId: string,
  entryDate?: string,
  voucherType?: string | null,
) {
  const period = await db.query(
    `SELECT id, status, period_start::text AS period_start, period_end::text AS period_end, label
     FROM books_periods WHERE id = $1 AND client_id = $2`,
    [periodId, clientId],
  );
  if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
  if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
    throw new BooksError("period_locked", "period_closed");
  }
  if (entryDate !== undefined) {
    const d = isoDate(entryDate);
    const start = isoDate(period.rows[0].period_start);
    const end = isoDate(period.rows[0].period_end);
    const openingCutOver = voucherType === "Opening" && d === dayBeforeIso(start);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || ((d < start || d > end) && !openingCutOver)) {
      throw new BooksError("entry_date_outside_period", "invalid");
    }
    const containing = await db.query(
      `SELECT 1 FROM books_periods
       WHERE client_id = $1 AND period_start <= $2::date AND period_end >= $2::date
         AND status = 'LOCKED'
       LIMIT 1`,
      [clientId, d],
    );
    if (containing.rowCount) throw new BooksError("period_locked", "period_closed");
  }
  return period.rows[0];
}

async function loadAccountMaps(db: PoolClient, clientId: string, lines: BooksLineInput[]) {
  const ids = [...new Set(lines.map((line) => line.accountId))];
  const rows = await db.query(
    `SELECT id, code, account_type AS "accountType", is_postable
     FROM books_accounts
     WHERE client_id = $1 AND id = ANY($2::uuid[])`,
    [clientId, ids],
  );
  if (rows.rowCount !== ids.length) throw new BooksError("account_not_found", "not_found");
  const accountById = new Map<string, { id: string; code: string; accountType: string }>();
  for (const row of rows.rows) {
    if (row.is_postable !== true) {
      throw new BooksError(`account_not_postable:${row.code}`, "invalid_line");
    }
    accountById.set(String(row.id), {
      id: String(row.id),
      code: String(row.code),
      accountType: String(row.accountType),
    });
  }
  const vatRows = await db.query(
    `SELECT id, code FROM books_accounts
     WHERE client_id = $1 AND code IN ('1430','2210')`,
    [clientId],
  );
  const vatAccountByCode = new Map<string, string>();
  for (const row of vatRows.rows) {
    vatAccountByCode.set(String(row.code), String(row.id));
  }
  return { accountById, vatAccountByCode };
}

async function assignEntryNo(
  db: PoolClient,
  clientId: string,
  entryId: string,
  entryDate: string,
  voucherType: string = "Journal",
  postedBy?: string,
): Promise<string> {
  const fyRow = await db.query(
    `SELECT fiscal_year_start_month AS m FROM clients WHERE id = $1`,
    [clientId],
  );
  const year = fiscalYearForDate(entryDate, Number(fyRow.rows[0]?.m || 1));
  const vt = isVoucherType(voucherType) ? voucherType : "Journal";
  const no = await db.query(
    `SELECT books_next_voucher_no($1::uuid, $2::text, $3::int) AS entry_no`,
    [clientId, vt, year],
  );
  const entryNo = String(no.rows[0].entry_no);
  const posted = await db.query(
    `UPDATE books_journal_entries
     SET status = 'posted', posted_at = now(), entry_no = $3, voucher_type = $4,
         posted_by = COALESCE($5::uuid, posted_by)
     WHERE id = $1 AND client_id = $2 AND status IN ('draft', 'scheduled')
     RETURNING period_id`,
    [entryId, clientId, entryNo, vt, postedBy ?? null],
  );
  // A concurrent post already won: do not hand back a voucher number that was never used.
  if (!posted.rowCount) throw new BooksError("not_draft", "conflict");
  await markPeriodChangedSinceClose(db, clientId, String(posted.rows[0].period_id));
  return entryNo;
}

async function insertLines(db: PoolClient, clientId: string, entryId: string, lines: BooksLineInput[]) {
  let lastPrimaryLineId: string | null = null;
  for (const line of lines) {
    const debit = line.debitMinor ?? 0;
    const credit = line.creditMinor ?? 0;
    const aed = line.aedMinor ?? debit + credit;
    const vatAmt = line.vatAmountMinor ?? 0;
    const inserted = await db.query(
      `INSERT INTO books_journal_lines (
         entry_id, client_id, account_id, debit_minor, credit_minor, currency,
         original_minor, fx_rate_scaled, aed_minor, line_memo, vat_treatment, tags,
         vat_code, vat_amount_minor, linked_vat_line_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        entryId,
        clientId,
        line.accountId,
        debit,
        credit,
        line.currency || "AED",
        line.originalMinor ?? null,
        line.fxRateScaled ?? null,
        aed,
        line.lineMemo || "",
        line.vatTreatment ?? line.vatCode ?? null,
        line.tags || [],
        line.vatCode ?? null,
        vatAmt,
        null,
      ],
    );
    const lineId = String(inserted.rows[0].id);
    if (line.isVatCompanion && lastPrimaryLineId) {
      await db.query(`UPDATE books_journal_lines SET linked_vat_line_id = $2 WHERE id = $1`, [
        lastPrimaryLineId,
        lineId,
      ]);
    } else if (!line.isVatCompanion) {
      lastPrimaryLineId = lineId;
    }
  }
}

function applyEntryTags(lines: BooksLineInput[], entryTags: string[]) {
  if (!entryTags.length) return lines;
  return lines.map((line) => ({
    ...line,
    tags: line.tags?.length ? line.tags : entryTags,
  }));
}

function addMonths(dateStr: string, frequency: string, step: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (frequency === "monthly") d.setUTCMonth(d.getUTCMonth() + step);
  else if (frequency === "quarterly") d.setUTCMonth(d.getUTCMonth() + step * 3);
  else d.setUTCFullYear(d.getUTCFullYear() + step);
  return d.toISOString().slice(0, 10);
}

export async function listBooksJournals(
  userId: string,
  clientId: string,
  filters: JournalListFilters = {},
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const params: unknown[] = [clientId];
    let n = 2;
    const clauses = ["e.client_id = $1", "e.deleted_at IS NULL"];

    if (filters.periodId) {
      clauses.push(`e.period_id = $${n++}`);
      params.push(filters.periodId);
    }
    if (filters.status) {
      const statuses = filters.status.split(",").map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        clauses.push(`e.status = $${n++}`);
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        clauses.push(`e.status = ANY($${n++}::text[])`);
        params.push(statuses);
      }
    }
    if (filters.entryType) {
      const types = filters.entryType.split(",").map((s) => s.trim()).filter(Boolean);
      if (types.length === 1) {
        clauses.push(`e.entry_type = $${n++}`);
        params.push(types[0]);
      } else if (types.length > 1) {
        clauses.push(`e.entry_type = ANY($${n++}::text[])`);
        params.push(types);
      }
    }
    if (filters.voucherType) {
      const types = filters.voucherType.split(",").map((s) => s.trim()).filter(Boolean);
      if (types.length === 1) {
        clauses.push(`e.voucher_type = $${n++}`);
        params.push(types[0]);
      } else if (types.length > 1) {
        clauses.push(`e.voucher_type = ANY($${n++}::text[])`);
        params.push(types);
      }
    }
    if (filters.reference) {
      clauses.push(`e.reference ILIKE $${n++}`);
      params.push(`%${filters.reference}%`);
    }
    if (filters.fromDate) {
      clauses.push(`e.entry_date >= $${n++}`);
      params.push(filters.fromDate);
    }
    if (filters.toDate) {
      clauses.push(`e.entry_date <= $${n++}`);
      params.push(filters.toDate);
    }
    if (filters.tag) {
      clauses.push(
        `(
           $${n} = ANY(e.tags)
           OR EXISTS (
             SELECT 1 FROM books_journal_lines tl, unnest(tl.tags) AS t
             WHERE tl.entry_id = e.id AND t = $${n}
           )
         )`,
      );
      params.push(filters.tag);
      n += 1;
    }
    if (filters.tags?.length) {
      clauses.push(
        `(
           e.tags && $${n}::text[]
           OR EXISTS (
             SELECT 1 FROM books_journal_lines tl, unnest(tl.tags) AS t
             WHERE tl.entry_id = e.id AND t = ANY($${n}::text[])
           )
         )`,
      );
      params.push(filters.tags);
      n += 1;
    }
    if (filters.accountIds?.length) {
      clauses.push(
        `EXISTS (
           SELECT 1 FROM books_journal_lines al
           WHERE al.entry_id = e.id AND al.account_id = ANY($${n++}::uuid[])
         )`,
      );
      params.push(filters.accountIds);
    }
    if (filters.createdBy) {
      clauses.push(`e.created_by = $${n++}`);
      params.push(filters.createdBy);
    }
    if (filters.postedBy) {
      clauses.push(
        `EXISTS (
           SELECT 1 FROM books_audit_events ae
           WHERE ae.entity = 'books_journal_entry' AND ae.entity_id = e.id
             AND ae.action = 'post' AND ae.actor = $${n++}
         )`,
      );
      params.push(filters.postedBy);
    }
    if (filters.hasAttachment === true) {
      clauses.push(
        `EXISTS (SELECT 1 FROM books_journal_attachments ja WHERE ja.entry_id = e.id)`,
      );
    } else if (filters.hasAttachment === false) {
      clauses.push(
        `NOT EXISTS (SELECT 1 FROM books_journal_attachments ja WHERE ja.entry_id = e.id)`,
      );
    }
    if (filters.q) {
      const rawQ = filters.q.trim();
      const amountMatch = rawQ.replace(/,/g, "").match(/^(\d+)(?:\.(\d{1,2}))?$/);
      const amountMinor = amountMatch
        ? Number(amountMatch[1]) * 100 + Number((amountMatch[2] || "0").padEnd(2, "0"))
        : null;
      const parts = [
        `e.memo ILIKE $${n}`,
        `e.reference ILIKE $${n}`,
        `e.entry_no ILIKE $${n}`,
        `EXISTS (
           SELECT 1 FROM books_journal_lines ql
           JOIN books_accounts qa ON qa.id = ql.account_id
           WHERE ql.entry_id = e.id
             AND (qa.code ILIKE $${n} OR qa.name ILIKE $${n})
         )`,
      ];
      params.push(`%${rawQ}%`);
      n += 1;
      if (amountMinor != null && Number.isFinite(amountMinor)) {
        parts.push(
          `EXISTS (
             SELECT 1 FROM books_journal_lines ql2
             WHERE ql2.entry_id = e.id
               AND (ql2.debit_minor = $${n} OR ql2.credit_minor = $${n})
           )`,
        );
        params.push(amountMinor);
        n += 1;
      }
      clauses.push(`(${parts.join(" OR ")})`);
    }

    let havingSql = "";
    if (filters.amountMinMinor != null) {
      havingSql += ` HAVING COALESCE(SUM(l.debit_minor), 0) >= $${n++}`;
      params.push(filters.amountMinMinor);
    }
    if (filters.amountMaxMinor != null) {
      havingSql += havingSql ? " AND" : " HAVING";
      havingSql += ` COALESCE(SUM(l.debit_minor), 0) <= $${n++}`;
      params.push(filters.amountMaxMinor);
    }

    const rows = await db.query(
      `SELECT e.id, e.period_id AS "periodId", p.label AS "periodLabel",
              e.memo, e.memo AS description,
              e.reference, e.entry_date AS "entryDate", e.status, e.entry_no AS "entryNo",
              e.entry_type AS "entryType", e.voucher_type AS "voucherType",
              e.posted_at AS "postedAt",
              e.scheduled_for AS "scheduledFor", e.auto_reverse_next_period AS "autoReverseNextPeriod",
              e.template_key AS "templateKey", e.recurring_id AS "recurringId",
              (
                SELECT rt.occurrences
                FROM books_recurring_templates rt
                WHERE rt.id = e.recurring_id
              ) AS "recurringTotal",
              CASE
                WHEN e.recurring_id IS NULL THEN NULL
                ELSE (
                  SELECT count(*)::int
                  FROM books_journal_entries e2
                  WHERE e2.recurring_id = e.recurring_id
                    AND e2.client_id = e.client_id
                    AND e2.deleted_at IS NULL
                    AND (e2.entry_date, e2.created_at, e2.id) <= (e.entry_date, e.created_at, e.id)
                )
              END AS "recurringIndex",
              e.created_at AS "createdAt", e.created_by AS "createdBy",
              e.corrects_entry_id AS "correctsEntryId",
              e.reverses_entry_id AS "reversesEntryId",
              e.reversed_by_entry_id AS "reversedByEntryId",
              COALESCE(SUM(l.debit_minor), 0)::bigint AS "debitTotal",
              COALESCE(SUM(l.credit_minor), 0)::bigint AS "creditTotal",
              (
                SELECT json_build_object(
                  'code', a.code, 'name', a.name, 'vatTreatment', dl.vat_treatment
                )
                FROM books_journal_lines dl
                JOIN books_accounts a ON a.id = dl.account_id
                WHERE dl.entry_id = e.id AND dl.debit_minor > 0
                ORDER BY dl.debit_minor DESC, a.code
                LIMIT 1
              ) AS "debitAccount",
              (
                SELECT json_build_object(
                  'code', a.code, 'name', a.name, 'vatTreatment', cl.vat_treatment
                )
                FROM books_journal_lines cl
                JOIN books_accounts a ON a.id = cl.account_id
                WHERE cl.entry_id = e.id AND cl.credit_minor > 0
                ORDER BY cl.credit_minor DESC, a.code
                LIMIT 1
              ) AS "creditAccount",
              (
                SELECT count(*)::int FROM books_journal_lines dlc
                WHERE dlc.entry_id = e.id AND dlc.debit_minor > 0
              ) AS "debitLineCount",
              (
                SELECT count(*)::int FROM books_journal_lines clc
                WHERE clc.entry_id = e.id AND clc.credit_minor > 0
              ) AS "creditLineCount",
              (
                SELECT ARRAY(
                  SELECT DISTINCT t FROM (
                    SELECT unnest(e.tags) AS t
                    UNION ALL
                    SELECT unnest(tl.tags) AS t
                    FROM books_journal_lines tl WHERE tl.entry_id = e.id
                  ) u
                  WHERE t IS NOT NULL AND t <> ''
                  ORDER BY t
                )
              ) AS tags
       FROM books_journal_entries e
       LEFT JOIN books_periods p ON p.id = e.period_id
       LEFT JOIN books_journal_lines l ON l.entry_id = e.id
       WHERE ${clauses.join(" AND ")}
       GROUP BY e.id, p.label
       ${havingSql}
       ORDER BY e.entry_date DESC, e.created_at DESC
       LIMIT 500`,
      params,
    );
    return rows.rows.map((row) => ({
      ...row,
      debitTotal: Number(row.debitTotal),
      creditTotal: Number(row.creditTotal),
      amount: Number(row.debitTotal),
      debitLineCount: Number(row.debitLineCount || 0),
      creditLineCount: Number(row.creditLineCount || 0),
      recurringIndex: row.recurringIndex == null ? null : Number(row.recurringIndex),
      recurringTotal: row.recurringTotal == null ? null : Number(row.recurringTotal),
      tags: Array.isArray(row.tags) ? row.tags : [],
      debitAccount: row.debitAccount ?? null,
      creditAccount: row.creditAccount ?? null,
      autoReverseNextPeriod: Boolean(row.autoReverseNextPeriod),
    }));
  });
}

export async function getBooksJournal(userId: string, clientId: string, entryId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const entry = await db.query(
      `SELECT e.id, e.period_id AS "periodId", p.label AS "periodLabel", p.status AS "periodStatus",
              e.memo, e.reference, e.entry_date AS "entryDate",
              e.status, e.entry_no AS "entryNo", e.entry_type AS "entryType",
              e.voucher_type AS "voucherType", e.note, e.tags,
              e.reverses_entry_id AS "reversesEntryId", e.reversed_by_entry_id AS "reversedByEntryId",
              e.corrects_entry_id AS "correctsEntryId",
              e.scheduled_for AS "scheduledFor", e.auto_reverse_next_period AS "autoReverseNextPeriod",
              e.template_key AS "templateKey", e.recurring_id AS "recurringId",
              (
                SELECT rt.occurrences
                FROM books_recurring_templates rt
                WHERE rt.id = e.recurring_id
              ) AS "recurringTotal",
              CASE
                WHEN e.recurring_id IS NULL THEN NULL
                ELSE (
                  SELECT count(*)::int
                  FROM books_journal_entries e2
                  WHERE e2.recurring_id = e.recurring_id
                    AND e2.client_id = e.client_id
                    AND e2.deleted_at IS NULL
                    AND (e2.entry_date, e2.created_at, e2.id) <= (e.entry_date, e.created_at, e.id)
                )
              END AS "recurringIndex",
              e.content_hash AS "contentHash", e.created_by AS "createdBy",
              cu.name AS "createdByName",
              e.posted_by AS "postedBy",
              pu.name AS "postedByName",
              e.posted_at AS "postedAt", e.created_at AS "createdAt",
              rev.entry_no AS "reversesEntryNo",
              byrev.entry_no AS "reversedByEntryNo",
              corr.entry_no AS "correctsEntryNo"
       FROM books_journal_entries e
       LEFT JOIN books_periods p ON p.id = e.period_id
       LEFT JOIN users cu ON cu.id = e.created_by
       LEFT JOIN users pu ON pu.id = e.posted_by
       LEFT JOIN books_journal_entries rev ON rev.id = e.reverses_entry_id
       LEFT JOIN books_journal_entries byrev ON byrev.id = e.reversed_by_entry_id
       LEFT JOIN books_journal_entries corr ON corr.id = e.corrects_entry_id
       WHERE e.id = $1 AND e.client_id = $2 AND e.deleted_at IS NULL`,
      [entryId, clientId],
    );
    if (!entry.rowCount) throw new BooksError("journal_not_found", "not_found");
    const lines = await db.query(
      `SELECT l.id, l.account_id AS "accountId", a.code AS "accountCode", a.name AS "accountName",
              a.parent_id AS "parentId", p.code AS "parentCode", p.name AS "parentName",
              l.debit_minor AS "debitMinor", l.credit_minor AS "creditMinor",
              l.currency, l.original_minor AS "originalMinor", l.fx_rate_scaled AS "fxRateScaled",
              l.aed_minor AS "aedMinor", l.line_memo AS "lineMemo",
              l.vat_treatment AS "vatTreatment", l.vat_code AS "vatCode",
              l.vat_amount_minor AS "vatAmountMinor", l.linked_vat_line_id AS "linkedVatLineId",
              l.tags
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       LEFT JOIN books_accounts p ON p.id = a.parent_id
       WHERE l.entry_id = $1
       ORDER BY l.debit_minor DESC, a.code`,
      [entryId],
    );
    const attachments = await db.query(
      `SELECT a.id, f.original_name AS "originalName", f.size, a.created_at AS "createdAt"
       FROM books_journal_attachments a
       JOIN files f ON f.id = a.file_id
       WHERE a.entry_id = $1
       ORDER BY a.created_at`,
      [entryId],
    );
    return {
      ...entry.rows[0],
      autoReverseNextPeriod: Boolean(entry.rows[0].autoReverseNextPeriod),
      recurringIndex:
        entry.rows[0].recurringIndex == null ? null : Number(entry.rows[0].recurringIndex),
      recurringTotal:
        entry.rows[0].recurringTotal == null ? null : Number(entry.rows[0].recurringTotal),
      lines: lines.rows.map((line) => ({
        ...line,
        debitMinor: Number(line.debitMinor),
        creditMinor: Number(line.creditMinor),
        vatAmountMinor: Number(line.vatAmountMinor ?? 0),
        originalMinor: line.originalMinor == null ? null : Number(line.originalMinor),
        fxRateScaled: line.fxRateScaled == null ? null : Number(line.fxRateScaled),
        aedMinor: line.aedMinor == null ? null : Number(line.aedMinor),
      })),
      attachments: attachments.rows.map((a) => ({ ...a, size: Number(a.size) })),
    };
  });
}

const BOOKS_ENTRY_TYPES = new Set([
  "manual",
  "auto",
  "closing",
  "opening",
  "reversal",
  "depreciation",
  "fx_revaluation",
]);
export async function createBooksJournal(
  userId: string,
  clientId: string,
  body: {
    periodId: string;
    entryDate: string;
    memo?: string;
    reference?: string;
    tags?: string[];
    voucherType?: string;
    /** Defaults to manual. P5-2 depreciation runs use entry_type=depreciation. */
    entryType?: string;
    correctsEntryId?: string | null;
    lines: BooksLineInput[];
    post?: boolean;
    scheduledFor?: string | null;
    autoReverseNextPeriod?: boolean;
    templateKey?: string | null;
    recurring?: {
      frequency: "monthly" | "quarterly" | "yearly";
      startDate: string;
      occurrences: number;
    } | null;
    attachmentFileIds?: string[];
    /**
     * Documents / settlements / expenses may post to AR/AP/VAT controls.
     * Manual journals and bank categorisation must not (open items would drift).
     */
    allowControlAccounts?: boolean;
  },
) {
  const entryTags = body.tags ?? [];
  let lines = applyEntryTags(body.lines, entryTags);
  const voucherType: VoucherType = isVoucherType(body.voucherType || "")
    ? (body.voucherType as VoucherType)
    : "Journal";
  const entryType =
    body.entryType && BOOKS_ENTRY_TYPES.has(body.entryType) ? body.entryType : "manual";

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireWritablePeriod(db, clientId, body.periodId, body.entryDate, voucherType);
    const { accountById, vatAccountByCode } = await loadAccountMaps(db, clientId, lines);
    const lineCodes = lines.map((l) => accountById.get(l.accountId)?.code ?? "");
    const pureVatSettlement = isPureVatSettlement(lineCodes);
    if (!body.allowControlAccounts && !pureVatSettlement) {
      for (const line of lines) {
        const meta = accountById.get(line.accountId);
        if (meta && isBooksControlAccountCode(meta.code)) {
          throw new BooksError(`control_account_forbidden:${meta.code}`, "invalid");
        }
      }
    }
    const warnings: string[] = [];
    if (pureVatSettlement && !body.allowControlAccounts && entryType === "manual") {
      warnings.push("manual_vat_control_journal");
    }
    lines = expandVatCompanionLines(lines, accountById, vatAccountByCode);
    assertBooksBalanced(lines);

    const id = randomUUID();
    const memo = body.memo || "";
    const scheduleDate = body.scheduledFor || null;
    const wantSchedule = Boolean(scheduleDate && !body.post);
    const initialStatus = wantSchedule ? "scheduled" : "draft";
    let reference = (body.reference || "").trim();
    if (!reference && !body.post) {
      const kind = wantSchedule ? "SCH" : "DRAFT";
      const refRow = await db.query(`SELECT books_next_display_ref($1::uuid, $2) AS r`, [clientId, kind]);
      reference = String(refRow.rows[0].r);
    }
    const hash = hashEntry(memo, body.entryDate, lines);

    await db.query(
      `INSERT INTO books_journal_entries (
         id, client_id, period_id, memo, reference, entry_date, status, entry_type, content_hash, created_by,
         scheduled_for, auto_reverse_next_period, template_key, voucher_type, tags, corrects_entry_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16)`,
      [
        id,
        clientId,
        body.periodId,
        memo,
        reference,
        body.entryDate,
        initialStatus,
        entryType,
        hash,
        userId,
        wantSchedule ? scheduleDate : null,
        Boolean(body.autoReverseNextPeriod),
        body.templateKey ?? null,
        voucherType,
        entryTags,
        body.correctsEntryId || null,
      ],
    );
    await insertLines(db, clientId, id, lines);
    if (body.attachmentFileIds?.length) {
      await linkBooksJournalAttachments(db, clientId, id, body.attachmentFileIds);
    }

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_journal_entry",
      entityId: id,
      after: { memo, reference, entryDate: body.entryDate, lines, templateKey: body.templateKey },
    });

    let status = initialStatus;
    let entryNo: string | null = null;
    let recurringId: string | null = null;

    if (body.recurring) {
      recurringId = randomUUID();
      const freq = body.recurring.frequency;
      const start = body.recurring.startDate;
      const occ = Math.min(120, Math.max(1, body.recurring.occurrences));
      const nextDate = addMonths(start, freq, 1);
      await db.query(
        `INSERT INTO books_recurring_templates (
           id, client_id, period_id, memo, frequency, start_date, occurrences,
           next_date, remaining, line_payload, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [
          recurringId,
          clientId,
          body.periodId,
          memo,
          freq,
          start,
          occ,
          nextDate,
          occ - 1,
          JSON.stringify(lines),
          userId,
        ],
      );
      await db.query(`UPDATE books_journal_entries SET recurring_id = $3 WHERE id = $1 AND client_id = $2`, [
        id,
        clientId,
        recurringId,
      ]);
      await enqueueBooksJob(
        db,
        clientId,
        "recurring_materialize",
        { templateId: recurringId, entryId: id, actorUserId: userId },
        new Date(`${nextDate}T00:00:00Z`),
      );
    }

    if (wantSchedule && !body.post) {
      await enqueueBooksJob(
        db,
        clientId,
        "schedule_post",
        { entryId: id, actorUserId: userId },
        new Date(`${scheduleDate}T00:00:00Z`),
      );
    }

    if (body.post && !wantSchedule) {
      await requireDualControlActor(db, userId, userId, "post", { clientId });
      entryNo = await assignEntryNo(db, clientId, id, body.entryDate, voucherType, userId);
      status = "posted";
      await writeBooksAudit(db, {
        clientId,
        actor: userId,
        action: "post",
        entity: "books_journal_entry",
        entityId: id,
        after: { status: "posted", entryNo, voucherType, postedBy: userId },
      });
      if (body.autoReverseNextPeriod) {
        const reverseOn = firstOfNextMonthIso(body.entryDate);
        await enqueueBooksJob(
          db,
          clientId,
          "auto_reverse",
          { entryId: id, actorUserId: userId, reverseOn },
          firstOfNextMonthUtc(body.entryDate),
        );
      }
    }

    const linesOut = await db.query(
      `SELECT l.id, l.account_id AS "accountId", a.code AS "accountCode", a.name AS "accountName",
              l.debit_minor AS "debitMinor", l.credit_minor AS "creditMinor",
              l.vat_code AS "vatCode", l.vat_amount_minor AS "vatAmountMinor",
              l.currency, l.line_memo AS "lineMemo"
       FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1
       ORDER BY a.code`,
      [id],
    );
    return {
      id,
      periodId: body.periodId,
      memo,
      reference,
      entryDate: body.entryDate,
      status,
      entryNo,
      recurringId,
      scheduledFor: wantSchedule ? scheduleDate : null,
      warnings,
      lines: linesOut.rows.map((line) => ({
        ...line,
        debitMinor: Number(line.debitMinor),
        creditMinor: Number(line.creditMinor),
        vatAmountMinor: Number(line.vatAmountMinor ?? 0),
      })),
    };
  });
}

export async function postBooksJournal(userId: string, clientId: string, entryId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    return postBooksJournalInTx(db, userId, clientId, entryId);
  });
}

/**
 * Post a draft/scheduled entry inside the caller's transaction (same checks as postBooksJournal:
 * dual control vs created_by, writable period + entry date, changed-since-close marking).
 * Caller must already have run assertSyntheticTenant on this connection.
 */
export async function postBooksJournalInTx(
  db: PoolClient,
  userId: string,
  clientId: string,
  entryId: string,
) {
  const entry = await db.query(
    `SELECT id, period_id, status, entry_date, auto_reverse_next_period, created_by, voucher_type
     FROM books_journal_entries
     WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
    [entryId, clientId],
  );
  if (!entry.rowCount) throw new BooksError("journal_not_found", "not_found");
  if (!["draft", "scheduled"].includes(String(entry.rows[0].status))) {
    throw new BooksError("not_draft", "conflict");
  }
  await requireDualControlActor(db, userId, String(entry.rows[0].created_by), "post", { clientId });
  // Dual control: whoever replaced the draft's lines/header is also its preparer and cannot post it.
  const dualOn = await db.query(`SELECT require_dual_control FROM clients WHERE id = $1`, [clientId]);
  const requireDual = dualOn.rows[0]?.require_dual_control !== false;
  if (requireDual) {
    const edited = await db.query(
      `SELECT 1 FROM books_audit_events
       WHERE client_id = $1 AND entity = 'books_journal_entry' AND entity_id = $2::uuid
         AND action = 'update' AND actor = $3
       LIMIT 1`,
      [clientId, entryId, userId],
    );
    if (edited.rowCount) throw new BooksError("post_preparer_cannot_approve", "forbidden");
  }
  await requireWritablePeriod(
    db,
    clientId,
    String(entry.rows[0].period_id),
    String(entry.rows[0].entry_date),
    String(entry.rows[0].voucher_type || ""),
  );
  const entryNo = await assignEntryNo(
    db,
    clientId,
    entryId,
    String(entry.rows[0].entry_date),
    String(entry.rows[0].voucher_type || "Journal"),
    userId,
  );
  await writeBooksAudit(db, {
    clientId,
    actor: userId,
    action: "post",
    entity: "books_journal_entry",
    entityId: entryId,
    before: { status: entry.rows[0].status },
    after: { status: "posted", entryNo, postedBy: userId },
  });
  if (entry.rows[0].auto_reverse_next_period) {
    const entryDate = String(entry.rows[0].entry_date).slice(0, 10);
    const reverseOn = firstOfNextMonthIso(entryDate);
    await enqueueBooksJob(
      db,
      clientId,
      "auto_reverse",
      { entryId, actorUserId: userId, reverseOn },
      firstOfNextMonthUtc(entryDate),
    );
  }
  return { id: entryId, status: "posted", entryNo };
}

export async function bulkPostBooksJournals(userId: string, clientId: string, entryIds: string[]) {
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const entryId of entryIds) {
    try {
      await postBooksJournal(userId, clientId, entryId);
      results.push({ id: entryId, ok: true });
    } catch (error) {
      results.push({
        id: entryId,
        ok: false,
        error: error instanceof Error ? error.message : "post_failed",
      });
    }
  }
  return { results };
}

export async function bulkReverseBooksJournals(
  userId: string,
  clientId: string,
  entryIds: string[],
  entryDate: string,
  reason: string,
) {
  const results: Array<{ id: string; ok: boolean; reversalId?: string; error?: string }> = [];
  for (const entryId of entryIds) {
    try {
      const rev = await reverseBooksJournal(userId, clientId, entryId, entryDate, reason);
      results.push({ id: entryId, ok: true, reversalId: rev.reversalId });
    } catch (error) {
      results.push({
        id: entryId,
        ok: false,
        error: error instanceof Error ? error.message : "reverse_failed",
      });
    }
  }
  return { results };
}

export async function bulkTagBooksJournals(
  userId: string,
  clientId: string,
  entryIds: string[],
  tags: string[],
) {
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const entryId of entryIds) {
    try {
      await updateBooksJournalTags(userId, clientId, entryId, tags);
      results.push({ id: entryId, ok: true });
    } catch (error) {
      results.push({
        id: entryId,
        ok: false,
        error: error instanceof Error ? error.message : "tag_failed",
      });
    }
  }
  return { results };
}

export async function bulkAddBooksJournalTags(
  userId: string,
  clientId: string,
  entryIds: string[],
  addTags: string[],
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const entryId of entryIds) {
      try {
        const entry = await db.query(
          `SELECT status FROM books_journal_entries WHERE id = $1 AND client_id = $2`,
          [entryId, clientId],
        );
        if (!entry.rowCount) throw new BooksError("journal_not_found", "not_found");
        if (!["draft", "scheduled", "posted"].includes(String(entry.rows[0].status))) {
          throw new BooksError("tags_not_editable", "conflict");
        }
        const before = await db.query(
          `SELECT tags FROM books_journal_entries WHERE id = $1`,
          [entryId],
        );
        const merged = [...new Set([...(before.rows[0]?.tags || []), ...addTags])];
        await db.query(`UPDATE books_journal_entries SET tags = $2::text[] WHERE id = $1`, [
          entryId,
          merged,
        ]);
        await db.query(`UPDATE books_journal_lines SET tags = $2::text[] WHERE entry_id = $1`, [
          entryId,
          merged,
        ]);
        results.push({ id: entryId, ok: true });
      } catch (error) {
        results.push({
          id: entryId,
          ok: false,
          error: error instanceof Error ? error.message : "tag_failed",
        });
      }
    }
    return { results };
  });
}

export async function bulkRemoveBooksJournalTags(
  userId: string,
  clientId: string,
  entryIds: string[],
  removeTags: string[],
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const remove = new Set(removeTags);
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const entryId of entryIds) {
      try {
        const entry = await db.query(
          `SELECT status FROM books_journal_entries WHERE id = $1 AND client_id = $2`,
          [entryId, clientId],
        );
        if (!entry.rowCount) throw new BooksError("journal_not_found", "not_found");
        if (!["draft", "scheduled", "posted"].includes(String(entry.rows[0].status))) {
          throw new BooksError("tags_not_editable", "conflict");
        }
        const before = await db.query(
          `SELECT tags FROM books_journal_entries WHERE id = $1`,
          [entryId],
        );
        const next = (before.rows[0]?.tags || []).filter((t: string) => !remove.has(t));
        await db.query(`UPDATE books_journal_entries SET tags = $2::text[] WHERE id = $1`, [
          entryId,
          next,
        ]);
        await db.query(`UPDATE books_journal_lines SET tags = $2::text[] WHERE entry_id = $1`, [
          entryId,
          next,
        ]);
        results.push({ id: entryId, ok: true });
      } catch (error) {
        results.push({
          id: entryId,
          ok: false,
          error: error instanceof Error ? error.message : "tag_failed",
        });
      }
    }
    return { results };
  });
}

export async function updateBooksJournalMemo(
  userId: string,
  clientId: string,
  entryId: string,
  memo: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT memo, status FROM books_journal_entries WHERE id = $1 AND client_id = $2`,
      [entryId, clientId],
    );
    if (!before.rowCount) throw new BooksError("journal_not_found", "not_found");
    await db.query(`UPDATE books_journal_entries SET memo = $3 WHERE id = $1 AND client_id = $2`, [
      entryId,
      clientId,
      memo,
    ]);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "edit_description",
      entity: "books_journal_entry",
      entityId: entryId,
      before: before.rows[0],
      after: { memo },
    });
    return { id: entryId, memo };
  });
}

export async function updateBooksJournalNote(
  userId: string,
  clientId: string,
  entryId: string,
  note: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT note, status FROM books_journal_entries WHERE id = $1 AND client_id = $2`,
      [entryId, clientId],
    );
    if (!before.rowCount) throw new BooksError("journal_not_found", "not_found");
    await db.query(`UPDATE books_journal_entries SET note = $3 WHERE id = $1 AND client_id = $2`, [
      entryId,
      clientId,
      note,
    ]);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "edit_note",
      entity: "books_journal_entry",
      entityId: entryId,
      before: before.rows[0],
      after: { note },
    });
    return { id: entryId, note };
  });
}

export async function updateBooksJournalTags(
  userId: string,
  clientId: string,
  entryId: string,
  tags: string[],
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const entry = await db.query(
      `SELECT id, status, tags, period_id FROM books_journal_entries
       WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [entryId, clientId],
    );
    if (!entry.rowCount) throw new BooksError("journal_not_found", "not_found");
    if (!["draft", "scheduled", "posted"].includes(String(entry.rows[0].status))) {
      throw new BooksError("tags_not_editable", "conflict");
    }
    if (entry.rows[0].status === "posted") {
      await requireWritablePeriod(db, clientId, String(entry.rows[0].period_id));
    }
    const beforeTags = entry.rows[0].tags || [];
    await db.query(`UPDATE books_journal_entries SET tags = $3::text[] WHERE id = $1 AND client_id = $2`, [
      entryId,
      clientId,
      tags,
    ]);
    await db.query(`UPDATE books_journal_lines SET tags = $2::text[] WHERE entry_id = $1`, [
      entryId,
      tags,
    ]);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "tag",
      entity: "books_journal_entry",
      entityId: entryId,
      before: { tags: beforeTags },
      after: { tags },
    });
    return { id: entryId, tags };
  });
}

/** Reverse a posted entry: bidirectional links + opposite lines + voucher# on reversal. */
export async function reverseBooksJournal(
  userId: string,
  clientId: string,
  entryId: string,
  entryDate: string,
  reason: string,
) {
  const reasonTrim = String(reason || "").trim();
  if (!reasonTrim) throw new BooksError("reversal_reason_required", "invalid");

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const original = await db.query(
      `SELECT id, period_id, memo, status, entry_no, created_by, voucher_type
       FROM books_journal_entries
       WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [entryId, clientId],
    );
    if (!original.rowCount) throw new BooksError("journal_not_found", "not_found");
    if (original.rows[0].status !== "posted") throw new BooksError("not_posted", "conflict");
    await requireDualControlActor(db, userId, String(original.rows[0].created_by), "reverse", {
    clientId,
  });

    const periodRow = await db.query(
      `SELECT id FROM books_periods
       WHERE client_id = $1
         AND period_start <= $2::date
         AND period_end >= $2::date
       ORDER BY period_start DESC
       LIMIT 1`,
      [clientId, entryDate],
    );
    if (!periodRow.rowCount) throw new BooksError("period_not_found", "not_found");
    const periodId = String(periodRow.rows[0].id);
    // Period resolved from the reversal's own date (not the original's period_id); refuses a
    // LOCKED period containing that date.
    await requireWritablePeriod(db, clientId, periodId, entryDate);

    const lines = await db.query(
      `SELECT account_id, debit_minor, credit_minor, currency, original_minor, fx_rate_scaled,
              line_memo, vat_treatment, vat_code, tags
       FROM books_journal_lines WHERE entry_id = $1 ORDER BY id`,
      [entryId],
    );
    // Same foreign-currency amount and rate on the opposite side, so FC balances net to zero.
    const opposite: BooksLineInput[] = lines.rows.map((line) => ({
      accountId: String(line.account_id),
      debitMinor: Number(line.credit_minor),
      creditMinor: Number(line.debit_minor),
      currency: String(line.currency),
      originalMinor: line.original_minor == null ? null : Number(line.original_minor),
      fxRateScaled: line.fx_rate_scaled == null ? null : Number(line.fx_rate_scaled),
      lineMemo: `Reversal: ${line.line_memo || ""}`.trim(),
      vatTreatment: line.vat_treatment,
      vatCode: line.vat_code,
      tags: line.tags || [],
    }));
    assertBooksBalanced(opposite);

    const reversalId = randomUUID();
    const memo = `Reversal of ${original.rows[0].entry_no || original.rows[0].memo || entryId}`;
    await db.query(
      `INSERT INTO books_journal_entries (
         id, client_id, period_id, memo, entry_date, status, reverses_entry_id,
         entry_type, voucher_type, content_hash, created_by
       ) VALUES ($1,$2,$3,$4,$5,'draft',$6,'reversal','Journal',$7,$8)`,
      [
        reversalId,
        clientId,
        periodId,
        memo,
        entryDate,
        entryId,
        hashEntry(memo, entryDate, opposite),
        userId,
      ],
    );
    await insertLines(db, clientId, reversalId, opposite);
    // Reversal is posted by the approver who initiated it; preparer is original creator.
    // Dual-control already checked against original.created_by; reversal posts immediately.
    const reversalNo = await assignEntryNo(db, clientId, reversalId, entryDate, "Journal");
    await db.query(
      `UPDATE books_journal_entries
       SET status = 'reversed', reversed_by_entry_id = $3
       WHERE id = $1 AND client_id = $2`,
      [entryId, clientId, reversalId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "reverse",
      entity: "books_journal_entry",
      entityId: entryId,
      after: {
        reversalId,
        reversedByEntryId: reversalId,
        reversesEntryId: entryId,
        status: "reversed",
        reversalNo,
        reason: reasonTrim,
        reversalDate: entryDate,
      },
    });
    return {
      originalId: entryId,
      reversalId,
      status: "reversed",
      reversesEntryId: entryId,
      reversedByEntryId: reversalId,
      entryNo: reversalNo,
    };
  });
}

/** Full replace of draft/scheduled entry header + lines. */
export async function replaceBooksJournalDraft(
  userId: string,
  clientId: string,
  entryId: string,
  body: {
    periodId?: string;
    entryDate: string;
    memo?: string;
    note?: string;
    reference?: string;
    tags?: string[];
    voucherType?: string;
    scheduledFor?: string | null;
    autoReverseNextPeriod?: boolean;
    templateKey?: string | null;
    lines: BooksLineInput[];
  },
) {
  const entryTags = body.tags ?? [];
  let lines = applyEntryTags(body.lines, entryTags);
  const voucherType: VoucherType = isVoucherType(body.voucherType || "")
    ? (body.voucherType as VoucherType)
    : "Journal";

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_journal_entries
       WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [entryId, clientId],
    );
    if (!before.rowCount) throw new BooksError("journal_not_found", "not_found");
    if (!["draft", "scheduled"].includes(String(before.rows[0].status))) {
      throw new BooksError("not_editable", "conflict");
    }
    const periodId = body.periodId || String(before.rows[0].period_id);
    await requireWritablePeriod(db, clientId, periodId, body.entryDate, voucherType);
    const { accountById, vatAccountByCode } = await loadAccountMaps(db, clientId, lines);
    lines = expandVatCompanionLines(lines, accountById, vatAccountByCode);
    assertBooksBalanced(lines);
    const memo = body.memo ?? String(before.rows[0].memo || "");
    const hash = hashEntry(memo, body.entryDate, lines);
    const scheduleDate =
      body.scheduledFor === undefined
        ? before.rows[0].scheduled_for
        : body.scheduledFor;
    const nextStatus = scheduleDate ? "scheduled" : "draft";
    const autoReverse =
      body.autoReverseNextPeriod !== undefined
        ? Boolean(body.autoReverseNextPeriod)
        : Boolean(before.rows[0].auto_reverse_next_period);
    const templateKey =
      body.templateKey !== undefined ? body.templateKey : before.rows[0].template_key;

    await db.query(
      `UPDATE books_journal_entries SET
         period_id = $3, memo = $4, note = COALESCE($5, note), reference = COALESCE($6, reference),
         entry_date = $7, content_hash = $8, voucher_type = $9, tags = $10::text[],
         scheduled_for = $11, status = $12, auto_reverse_next_period = $13, template_key = $14
       WHERE id = $1 AND client_id = $2`,
      [
        entryId,
        clientId,
        periodId,
        memo,
        body.note ?? null,
        // A blank reference keeps the draft's own (e.g. DRAFT-0010) instead of wiping it.
        body.reference?.trim() ? body.reference.trim() : null,
        body.entryDate,
        hash,
        voucherType,
        entryTags,
        scheduleDate,
        nextStatus,
        autoReverse,
        templateKey,
      ],
    );
    await db.query(`DELETE FROM books_journal_lines WHERE entry_id = $1`, [entryId]);
    await insertLines(db, clientId, entryId, lines);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update",
      entity: "books_journal_entry",
      entityId: entryId,
      before: {
        memo: before.rows[0].memo,
        entryDate: before.rows[0].entry_date,
        status: before.rows[0].status,
      },
      after: { memo, entryDate: body.entryDate, status: nextStatus, voucherType, tags: entryTags },
    });
    return {
      id: entryId,
      periodId,
      memo,
      entryDate: body.entryDate,
      status: nextStatus,
      voucherType,
      tags: entryTags,
      autoReverseNextPeriod: autoReverse,
      lines,
    };
  });
}

/** Soft-delete draft/scheduled only. */
export async function softDeleteBooksJournalDraft(
  userId: string,
  clientId: string,
  entryId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT id, status FROM books_journal_entries
       WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [entryId, clientId],
    );
    if (!before.rowCount) throw new BooksError("journal_not_found", "not_found");
    if (!["draft", "scheduled"].includes(String(before.rows[0].status))) {
      throw new BooksError("delete_requires_draft", "conflict");
    }
    await db.query(
      `UPDATE books_journal_entries SET deleted_at = now() WHERE id = $1 AND client_id = $2`,
      [entryId, clientId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "soft_delete",
      entity: "books_journal_entry",
      entityId: entryId,
      before: before.rows[0],
    });
    return { id: entryId, deleted: true };
  });
}

/**
 * Posted amount/date/account edit: reverse original + return prefill for corrected copy.
 * Caller creates the correction via createBooksJournal with correctsEntryId.
 */
export async function beginBooksJournalCorrection(
  userId: string,
  clientId: string,
  entryId: string,
  entryDate: string,
) {
  const original = await getBooksJournal(userId, clientId, entryId);
  if (original.status !== "posted") throw new BooksError("not_posted", "conflict");
  if (String(original.periodStatus) === "LOCKED") {
    throw new BooksError("period_locked", "period_closed");
  }
  const rev = await reverseBooksJournal(
    userId,
    clientId,
    entryId,
    entryDate,
    "Correction: reverse original before new entry",
  );
  const prefillLines = (original.lines as Array<Record<string, unknown>>).map((line) => ({
    accountId: String(line.accountId),
    debitMinor: Number(line.debitMinor),
    creditMinor: Number(line.creditMinor),
    currency: String(line.currency || "AED"),
    lineMemo: String(line.lineMemo || ""),
    vatCode: line.vatCode == null ? null : String(line.vatCode),
    vatAmountMinor: Number(line.vatAmountMinor ?? 0),
    tags: Array.isArray(line.tags) ? line.tags.map(String) : [],
  }));
  return {
    ...rev,
    correctsEntryId: entryId,
    prefill: {
      periodId: String(original.periodId),
      entryDate: String(original.entryDate),
      memo: String(original.memo || ""),
      note: String(original.note || ""),
      reference: "",
      voucherType: String(original.voucherType || "Journal"),
      tags: Array.isArray(original.tags) ? original.tags.map(String) : [],
      lines: prefillLines,
    },
  };
}
