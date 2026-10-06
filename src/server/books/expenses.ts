import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { requireDualControlActor } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { assertSyntheticTenant } from "@/server/security-gate";
import type { PoolClient } from "pg";

export const EXPENSE_STATUSES = ["draft", "pending", "approved", "rejected"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const PAID_FROM_KINDS = ["bank", "card", "petty_cash", "employee_reimbursable"] as const;
export type PaidFromKind = (typeof PAID_FROM_KINDS)[number];

export type ExpenseLineInput = {
  description?: string;
  accountId: string;
  vatCode?: string | null;
  netMinor: number;
  vatMinor?: number;
};

export type ExpenseRow = {
  id: string;
  expenseNo: string;
  status: ExpenseStatus;
  expenseDate: string;
  periodId: string;
  description: string;
  vendorPartyId: string | null;
  vendorName: string;
  currency: string;
  paidFromKind: PaidFromKind | null;
  paidFromAccountId: string | null;
  paidFromAccountCode: string | null;
  bankTxnId: string | null;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  submittedBy: string | null;
  approvedBy: string | null;
  rejectionReason: string | null;
  journalEntryId: string | null;
  createdBy: string;
  /** Present after approve/post */
  entryNo?: string | null;
  lines?: ExpenseLineRow[];
};

export type ExpenseLineRow = {
  id: string;
  lineNo: number;
  description: string;
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  vatCode: string | null;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
};

function isoDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

function assertIntMinor(n: number, field: string) {
  if (!Number.isInteger(n) || n < 0) {
    throw new BooksError(`invalid_money:${field}`, "invalid_money");
  }
}

async function hasExpensesTable(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}) {
  const t = await db.query(`SELECT to_regclass('books_expenses') AS t`);
  return Boolean(t.rows[0]?.t);
}

function mapExpense(r: Record<string, unknown>): ExpenseRow {
  return {
    id: String(r.id),
    expenseNo: String(r.expense_no ?? r.expenseNo),
    status: String(r.status) as ExpenseStatus,
    expenseDate: isoDate(r.expense_date ?? r.expenseDate) || "",
    periodId: String(r.period_id ?? r.periodId),
    description: String(r.description || ""),
    vendorPartyId: r.vendor_party_id || r.vendorPartyId ? String(r.vendor_party_id ?? r.vendorPartyId) : null,
    vendorName: String(r.vendor_name ?? r.vendorName ?? ""),
    currency: String(r.currency || "AED"),
    paidFromKind: (r.paid_from_kind ?? r.paidFromKind)
      ? (String(r.paid_from_kind ?? r.paidFromKind) as PaidFromKind)
      : null,
    paidFromAccountId:
      r.paid_from_account_id || r.paidFromAccountId
        ? String(r.paid_from_account_id ?? r.paidFromAccountId)
        : null,
    paidFromAccountCode: r.paid_from_account_code
      ? String(r.paid_from_account_code)
      : r.paidFromAccountCode
        ? String(r.paidFromAccountCode)
        : null,
    bankTxnId: r.bank_txn_id || r.bankTxnId ? String(r.bank_txn_id ?? r.bankTxnId) : null,
    netMinor: Number(r.net_minor ?? r.netMinor ?? 0),
    vatMinor: Number(r.vat_minor ?? r.vatMinor ?? 0),
    grossMinor: Number(r.gross_minor ?? r.grossMinor ?? 0),
    submittedBy: r.submitted_by || r.submittedBy ? String(r.submitted_by ?? r.submittedBy) : null,
    approvedBy: r.approved_by || r.approvedBy ? String(r.approved_by ?? r.approvedBy) : null,
    rejectionReason: r.rejection_reason || r.rejectionReason
      ? String(r.rejection_reason ?? r.rejectionReason)
      : null,
    journalEntryId:
      r.journal_entry_id || r.journalEntryId ? String(r.journal_entry_id ?? r.journalEntryId) : null,
    createdBy: String(r.created_by ?? r.createdBy),
  };
}

export async function listBooksExpenses(
  userId: string,
  clientId: string,
  opts?: { status?: string; q?: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasExpensesTable(db))) return [];
    const status =
      opts?.status && opts.status !== "all" && (EXPENSE_STATUSES as readonly string[]).includes(opts.status)
        ? opts.status
        : null;
    const q = opts?.q?.trim() || null;
    const rows = await db.query(
      `SELECT e.*, a.code AS paid_from_account_code
       FROM books_expenses e
       LEFT JOIN books_accounts a ON a.id = e.paid_from_account_id
       WHERE e.client_id = $1 AND e.deleted_at IS NULL
         AND ($2::text IS NULL OR e.status = $2)
         AND (
           $3::text IS NULL
           OR e.description ILIKE '%' || $3 || '%'
           OR e.expense_no ILIKE '%' || $3 || '%'
           OR e.vendor_name ILIKE '%' || $3 || '%'
         )
       ORDER BY e.expense_date DESC, e.created_at DESC`,
      [clientId, status, q],
    );
    return rows.rows.map(mapExpense);
  });
}

export async function getBooksExpense(userId: string, clientId: string, id: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasExpensesTable(db))) {
      throw new BooksError("p3_expenses_migration_required", "invalid");
    }
    const head = await db.query(
      `SELECT e.*, a.code AS paid_from_account_code
       FROM books_expenses e
       LEFT JOIN books_accounts a ON a.id = e.paid_from_account_id
       WHERE e.id = $1 AND e.client_id = $2 AND e.deleted_at IS NULL`,
      [id, clientId],
    );
    if (!head.rowCount) throw new BooksError("expense_not_found", "not_found");
    const expense = mapExpense(head.rows[0]);
    const lines = await db.query(
      `SELECT l.*, a.code AS account_code, a.name AS account_name
       FROM books_expense_lines l
       JOIN books_accounts a ON a.id = l.account_id
       WHERE l.expense_id = $1 AND l.client_id = $2
       ORDER BY l.line_no`,
      [id, clientId],
    );
    expense.lines = lines.rows.map((r) => ({
      id: String(r.id),
      lineNo: Number(r.line_no),
      description: String(r.description || ""),
      accountId: String(r.account_id),
      accountCode: r.account_code ? String(r.account_code) : null,
      accountName: r.account_name ? String(r.account_name) : null,
      vatCode: r.vat_code == null ? null : String(r.vat_code),
      netMinor: Number(r.net_minor),
      vatMinor: Number(r.vat_minor),
      grossMinor: Number(r.gross_minor),
    }));
    return expense;
  });
}

export async function createBooksExpense(
  userId: string,
  clientId: string,
  body: {
    expenseDate: string;
    periodId: string;
    description?: string;
    vendorPartyId?: string | null;
    vendorName?: string;
    currency?: string;
    paidFromKind?: PaidFromKind | null;
    paidFromAccountId?: string | null;
    note?: string;
    lines: ExpenseLineInput[];
  },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasExpensesTable(db))) {
      throw new BooksError("p3_expenses_migration_required", "invalid");
    }
    const expenseDate = isoDate(body.expenseDate);
    if (!expenseDate) throw new BooksError("expense_date_required", "invalid");
    if (!body.periodId) throw new BooksError("period_required", "invalid");
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      throw new BooksError("expense_lines_required", "invalid");
    }

    const period = await db.query(
      `SELECT id, status FROM books_periods WHERE id = $1 AND client_id = $2`,
      [body.periodId, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
      throw new BooksError("period_locked", "period_closed");
    }

    if (
      body.paidFromKind &&
      !(PAID_FROM_KINDS as readonly string[]).includes(body.paidFromKind)
    ) {
      throw new BooksError("invalid_paid_from_kind", "invalid");
    }

    const vendorPartyId: string | null = body.vendorPartyId || null;
    let vendorName = String(body.vendorName || "").trim();
    if (vendorPartyId) {
      const p = await db.query(
        `SELECT id, name FROM books_parties WHERE id = $1 AND client_id = $2`,
        [vendorPartyId, clientId],
      );
      if (!p.rowCount) throw new BooksError("party_not_found", "not_found");
      if (!vendorName) vendorName = String(p.rows[0].name);
    }

    if (body.paidFromAccountId) {
      const acc = await db.query(
        `SELECT id FROM books_accounts
         WHERE id = $1 AND client_id = $2 AND active = true AND is_postable = true`,
        [body.paidFromAccountId, clientId],
      );
      if (!acc.rowCount) throw new BooksError("account_not_found", "not_found");
    }

    const preparedLines: Array<{
      lineNo: number;
      description: string;
      accountId: string;
      vatCode: string | null;
      netMinor: number;
      vatMinor: number;
      grossMinor: number;
    }> = [];
    let netTotal = 0;
    let vatTotal = 0;
    let lineNo = 0;
    for (const raw of body.lines) {
      lineNo += 1;
      const netMinor = Number(raw.netMinor);
      const vatMinor = Number(raw.vatMinor ?? 0);
      assertIntMinor(netMinor, "netMinor");
      assertIntMinor(vatMinor, "vatMinor");
      if (netMinor === 0 && vatMinor === 0) throw new BooksError("zero_amount", "invalid_money");
      const acc = await db.query(
        `SELECT id FROM books_accounts
         WHERE id = $1 AND client_id = $2 AND active = true AND is_postable = true`,
        [raw.accountId, clientId],
      );
      if (!acc.rowCount) throw new BooksError("account_not_found", "not_found");
      const vatCode: string | null = raw.vatCode ? String(raw.vatCode) : null;
      if (vatCode) {
        const vc = await db.query(`SELECT code FROM books_vat_codes WHERE code = $1 AND active = true`, [
          vatCode,
        ]);
        if (!vc.rowCount) throw new BooksError("vat_code_not_found", "invalid");
      } else if (vatMinor > 0) {
        throw new BooksError("vat_code_required", "invalid");
      }
      const grossMinor = netMinor + vatMinor;
      preparedLines.push({
        lineNo,
        description: String(raw.description || ""),
        accountId: String(raw.accountId),
        vatCode,
        netMinor,
        vatMinor,
        grossMinor,
      });
      netTotal += netMinor;
      vatTotal += vatMinor;
    }
    const grossTotal = netTotal + vatTotal;

    const year = Number(expenseDate.slice(0, 4));
    const noRes = await db.query(
      `SELECT books_next_voucher_no($1::uuid, 'Expense', $2::int) AS expense_no`,
      [clientId, year],
    );
    const expenseNo = String(noRes.rows[0].expense_no);

    const inserted = await db.query(
      `INSERT INTO books_expenses (
         client_id, expense_no, status, expense_date, period_id, description,
         vendor_party_id, vendor_name, currency, paid_from_kind, paid_from_account_id,
         net_minor, vat_minor, gross_minor, note, created_by
       ) VALUES (
         $1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
       ) RETURNING *`,
      [
        clientId,
        expenseNo,
        expenseDate,
        body.periodId,
        String(body.description || "").trim(),
        vendorPartyId,
        vendorName,
        (body.currency || "AED").toUpperCase(),
        body.paidFromKind || null,
        body.paidFromAccountId || null,
        netTotal,
        vatTotal,
        grossTotal,
        String(body.note || ""),
        userId,
      ],
    );
    const expenseId = String(inserted.rows[0].id);
    for (const l of preparedLines) {
      await db.query(
        `INSERT INTO books_expense_lines (
           expense_id, client_id, line_no, description, account_id, vat_code,
           net_minor, vat_minor, gross_minor
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          expenseId,
          clientId,
          l.lineNo,
          l.description,
          l.accountId,
          l.vatCode,
          l.netMinor,
          l.vatMinor,
          l.grossMinor,
        ],
      );
    }

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create_expense",
      entity: "books_expense",
      entityId: expenseId,
      after: { expenseNo, status: "draft", grossMinor: grossTotal },
    });

    return mapExpense(inserted.rows[0]);
  });
}

export async function updateBooksExpenseDraft(
  userId: string,
  clientId: string,
  id: string,
  body: {
    expenseDate?: string;
    periodId?: string;
    description?: string;
    vendorPartyId?: string | null;
    vendorName?: string;
    paidFromKind?: PaidFromKind | null;
    paidFromAccountId?: string | null;
    note?: string;
    lines?: ExpenseLineInput[];
  },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_expenses WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [id, clientId],
    );
    if (!before.rowCount) throw new BooksError("expense_not_found", "not_found");
    const row = before.rows[0];
    if (!["draft", "rejected"].includes(String(row.status))) {
      throw new BooksError("expense_not_editable", "conflict");
    }

    const expenseDate = body.expenseDate !== undefined ? isoDate(body.expenseDate) : isoDate(row.expense_date);
    if (!expenseDate) throw new BooksError("expense_date_required", "invalid");
    const periodId = body.periodId !== undefined ? body.periodId : String(row.period_id);
    if (!periodId) throw new BooksError("period_required", "invalid");

    const vendorPartyId =
      body.vendorPartyId !== undefined ? body.vendorPartyId : row.vendor_party_id;
    let vendorName =
      body.vendorName !== undefined ? String(body.vendorName).trim() : String(row.vendor_name || "");
    if (vendorPartyId) {
      const p = await db.query(
        `SELECT id, name FROM books_parties WHERE id = $1 AND client_id = $2`,
        [vendorPartyId, clientId],
      );
      if (!p.rowCount) throw new BooksError("party_not_found", "not_found");
      if (!vendorName) vendorName = String(p.rows[0].name);
    }

    const paidFromKind =
      body.paidFromKind !== undefined ? body.paidFromKind : (row.paid_from_kind as PaidFromKind | null);
    const paidFromAccountId =
      body.paidFromAccountId !== undefined ? body.paidFromAccountId : row.paid_from_account_id;

    let netTotal = Number(row.net_minor);
    let vatTotal = Number(row.vat_minor);
    let grossTotal = Number(row.gross_minor);

    if (body.lines) {
      if (body.lines.length === 0) throw new BooksError("expense_lines_required", "invalid");
      await db.query(`DELETE FROM books_expense_lines WHERE expense_id = $1 AND client_id = $2`, [
        id,
        clientId,
      ]);
      netTotal = 0;
      vatTotal = 0;
      let lineNo = 0;
      for (const raw of body.lines) {
        lineNo += 1;
        const netMinor = Number(raw.netMinor);
        const vatMinor = Number(raw.vatMinor ?? 0);
        assertIntMinor(netMinor, "netMinor");
        assertIntMinor(vatMinor, "vatMinor");
        const acc = await db.query(
          `SELECT id FROM books_accounts
           WHERE id = $1 AND client_id = $2 AND active = true AND is_postable = true`,
          [raw.accountId, clientId],
        );
        if (!acc.rowCount) throw new BooksError("account_not_found", "not_found");
        const vatCode: string | null = raw.vatCode ? String(raw.vatCode) : null;
        if (vatCode) {
          const vc = await db.query(
            `SELECT code FROM books_vat_codes WHERE code = $1 AND active = true`,
            [vatCode],
          );
          if (!vc.rowCount) throw new BooksError("vat_code_not_found", "invalid");
        } else if (vatMinor > 0) {
          throw new BooksError("vat_code_required", "invalid");
        }
        const grossMinor = netMinor + vatMinor;
        await db.query(
          `INSERT INTO books_expense_lines (
             expense_id, client_id, line_no, description, account_id, vat_code,
             net_minor, vat_minor, gross_minor
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            clientId,
            lineNo,
            String(raw.description || ""),
            raw.accountId,
            vatCode,
            netMinor,
            vatMinor,
            grossMinor,
          ],
        );
        netTotal += netMinor;
        vatTotal += vatMinor;
      }
      grossTotal = netTotal + vatTotal;
    }

    const updated = await db.query(
      `UPDATE books_expenses SET
         expense_date = $3,
         period_id = $4,
         description = $5,
         vendor_party_id = $6,
         vendor_name = $7,
         paid_from_kind = $8,
         paid_from_account_id = $9,
         note = $10,
         net_minor = $11,
         vat_minor = $12,
         gross_minor = $13,
         updated_at = now()
       WHERE id = $1 AND client_id = $2
       RETURNING *`,
      [
        id,
        clientId,
        expenseDate,
        periodId,
        body.description !== undefined ? String(body.description).trim() : String(row.description || ""),
        vendorPartyId,
        vendorName,
        paidFromKind,
        paidFromAccountId,
        body.note !== undefined ? String(body.note) : String(row.note || ""),
        netTotal,
        vatTotal,
        grossTotal,
      ],
    );

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update_expense",
      entity: "books_expense",
      entityId: id,
      before: { status: row.status, gross_minor: row.gross_minor },
      after: { status: row.status, grossMinor: grossTotal },
    });

    return mapExpense(updated.rows[0]);
  });
}

async function loadExpenseLines(db: PoolClient, clientId: string, expenseId: string) {
  const lines = await db.query(
    `SELECT l.*, a.code AS account_code
     FROM books_expense_lines l
     JOIN books_accounts a ON a.id = l.account_id
     WHERE l.expense_id = $1 AND l.client_id = $2
     ORDER BY l.line_no`,
    [expenseId, clientId],
  );
  return lines.rows;
}

async function assertReceiptIfRequired(
  db: PoolClient,
  clientId: string,
  expenseId: string,
  grossMinor: number,
) {
  const thr = await db.query(
    `SELECT expense_receipt_threshold_minor AS t FROM clients WHERE id = $1`,
    [clientId],
  );
  const threshold = thr.rows[0]?.t;
  if (threshold == null) return;
  if (grossMinor <= Number(threshold)) return;
  const files = await db.query(
    `SELECT 1 FROM books_expense_files WHERE expense_id = $1 AND client_id = $2 LIMIT 1`,
    [expenseId, clientId],
  );
  if (!files.rowCount) {
    throw new BooksError("receipt_required", "invalid");
  }
}

/** draft → pending (preparer submit). */
export async function submitBooksExpense(userId: string, clientId: string, id: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_expenses WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [id, clientId],
    );
    if (!before.rowCount) throw new BooksError("expense_not_found", "not_found");
    const row = before.rows[0];
    if (String(row.status) !== "draft") {
      throw new BooksError("expense_not_draft", "conflict");
    }
    if (!row.paid_from_account_id || !row.paid_from_kind) {
      throw new BooksError("paid_from_required", "invalid");
    }
    const lines = await loadExpenseLines(db, clientId, id);
    if (!lines.length) throw new BooksError("expense_lines_required", "invalid");
    await assertReceiptIfRequired(db, clientId, id, Number(row.gross_minor));

    const period = await db.query(
      `SELECT status FROM books_periods WHERE id = $1 AND client_id = $2`,
      [row.period_id, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
      throw new BooksError("period_locked", "period_closed");
    }

    const updated = await db.query(
      `UPDATE books_expenses SET
         status = 'pending',
         submitted_by = $3,
         submitted_at = now(),
         rejected_by = NULL,
         rejected_at = NULL,
         rejection_reason = NULL,
         updated_at = now()
       WHERE id = $1 AND client_id = $2
       RETURNING *`,
      [id, clientId, userId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "submit_expense",
      entity: "books_expense",
      entityId: id,
      before: { status: "draft" },
      after: { status: "pending", submittedBy: userId },
    });
    return mapExpense(updated.rows[0]);
  });
}

/** pending → rejected (approver ≠ submitter). No journal. */
export async function rejectBooksExpense(
  userId: string,
  clientId: string,
  id: string,
  reason: string,
) {
  const trimmed = String(reason || "").trim();
  if (!trimmed) throw new BooksError("rejection_reason_required", "invalid");

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_expenses WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [id, clientId],
    );
    if (!before.rowCount) throw new BooksError("expense_not_found", "not_found");
    const row = before.rows[0];
    if (String(row.status) !== "pending") {
      throw new BooksError("expense_not_pending", "conflict");
    }
    await requireDualControlActor(db, userId, String(row.submitted_by), "post");

    const updated = await db.query(
      `UPDATE books_expenses SET
         status = 'rejected',
         rejected_by = $3,
         rejected_at = now(),
         rejection_reason = $4,
         updated_at = now()
       WHERE id = $1 AND client_id = $2
       RETURNING *`,
      [id, clientId, userId, trimmed],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "reject_expense",
      entity: "books_expense",
      entityId: id,
      before: { status: "pending" },
      after: { status: "rejected", reason: trimmed },
    });
    return mapExpense(updated.rows[0]);
  });
}

/** rejected → pending (same EXP no). */
export async function resubmitBooksExpense(userId: string, clientId: string, id: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_expenses WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [id, clientId],
    );
    if (!before.rowCount) throw new BooksError("expense_not_found", "not_found");
    const row = before.rows[0];
    if (String(row.status) !== "rejected") {
      throw new BooksError("expense_not_rejected", "conflict");
    }
    if (!row.paid_from_account_id || !row.paid_from_kind) {
      throw new BooksError("paid_from_required", "invalid");
    }
    const lines = await loadExpenseLines(db, clientId, id);
    if (!lines.length) throw new BooksError("expense_lines_required", "invalid");
    await assertReceiptIfRequired(db, clientId, id, Number(row.gross_minor));

    const updated = await db.query(
      `UPDATE books_expenses SET
         status = 'pending',
         submitted_by = $3,
         submitted_at = now(),
         rejected_by = NULL,
         rejected_at = NULL,
         rejection_reason = NULL,
         updated_at = now()
       WHERE id = $1 AND client_id = $2
       RETURNING *`,
      [id, clientId, userId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "resubmit_expense",
      entity: "books_expense",
      entityId: id,
      before: { status: "rejected" },
      after: { status: "pending", submittedBy: userId },
    });
    return mapExpense(updated.rows[0]);
  });
}

type BuiltExpenseLine = {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  lineMemo: string;
  vatTreatment: string | null;
};

async function buildExpenseJournalLines(
  db: PoolClient,
  clientId: string,
  expense: Record<string, unknown>,
  lines: Array<Record<string, unknown>>,
): Promise<BuiltExpenseLine[]> {
  const paidFromId = String(expense.paid_from_account_id);
  const vatIn = await db.query(
    `SELECT id FROM books_accounts WHERE client_id = $1 AND code = '1430' AND active = true`,
    [clientId],
  );
  if (!vatIn.rowCount) throw new BooksError("vat_input_account_missing", "invalid");
  const vatInId = String(vatIn.rows[0].id);

  let supplierTrn: string | null = null;
  if (expense.vendor_party_id) {
    const p = await db.query(`SELECT trn FROM books_parties WHERE id = $1 AND client_id = $2`, [
      expense.vendor_party_id,
      clientId,
    ]);
    supplierTrn = p.rows[0]?.trn ? String(p.rows[0].trn).trim() : null;
    if (!supplierTrn) supplierTrn = null;
  }

  const out: BuiltExpenseLine[] = [];
  let recoverableVat = 0;
  let creditGross = 0;

  for (const line of lines) {
    const net = Number(line.net_minor);
    const vat = Number(line.vat_minor);
    const vatCode = line.vat_code == null ? null : String(line.vat_code);
    let recoverable = false;
    if (vat > 0 && vatCode && vatCode !== "NR" && supplierTrn) {
      const meta = await db.query(
        `SELECT recoverable FROM books_vat_codes WHERE code = $1 AND active = true`,
        [vatCode],
      );
      recoverable = Boolean(meta.rows[0]?.recoverable);
    }
    const debitAmt = recoverable ? net : net + vat;
    if (recoverable) recoverableVat += vat;
    creditGross += net + vat;
    out.push({
      accountId: String(line.account_id),
      debitMinor: debitAmt,
      creditMinor: 0,
      lineMemo: String(line.description || expense.description || "Expense"),
      vatTreatment: vatCode,
    });
  }

  if (recoverableVat > 0) {
    out.push({
      accountId: vatInId,
      debitMinor: recoverableVat,
      creditMinor: 0,
      lineMemo: "Input VAT",
      vatTreatment: "SR",
    });
  }

  out.push({
    accountId: paidFromId,
    debitMinor: 0,
    creditMinor: creditGross,
    lineMemo: `Paid from ${String(expense.paid_from_kind || "")}`,
    vatTreatment: null,
  });

  const dr = out.reduce((s, l) => s + l.debitMinor, 0);
  const cr = out.reduce((s, l) => s + l.creditMinor, 0);
  if (dr !== cr) throw new BooksError("expense_journal_unbalanced", "invalid_money");
  return out;
}

/** pending → approved + posted journal (approver ≠ submitter). */
export async function approveAndPostBooksExpense(
  userId: string,
  clientId: string,
  id: string,
) {
  const prepared = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_expenses WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [id, clientId],
    );
    if (!before.rowCount) throw new BooksError("expense_not_found", "not_found");
    const row = before.rows[0];
    if (String(row.status) !== "pending") {
      throw new BooksError("expense_not_pending", "conflict");
    }
    if (row.journal_entry_id) throw new BooksError("expense_already_posted", "conflict");
    await requireDualControlActor(db, userId, String(row.submitted_by), "post");
    if (!row.paid_from_account_id) throw new BooksError("paid_from_required", "invalid");

    const period = await db.query(
      `SELECT id, status FROM books_periods WHERE id = $1 AND client_id = $2`,
      [row.period_id, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
      throw new BooksError("period_locked", "period_closed");
    }

    await assertReceiptIfRequired(db, clientId, id, Number(row.gross_minor));
    const lines = await loadExpenseLines(db, clientId, id);
    if (!lines.length) throw new BooksError("expense_lines_required", "invalid");
    const bankTxnId = row.bank_txn_id ? String(row.bank_txn_id) : null;
    if (bankTxnId) {
      await assertBankTxnMatchesExpense(db, {
        clientId,
        bankTxnId,
        expenseId: id,
        paidFromAccountId: String(row.paid_from_account_id),
        paidFromKind: String(row.paid_from_kind || ""),
        grossMinor: Number(row.gross_minor),
      });
    }
    const journalLines = await buildExpenseJournalLines(db, clientId, row, lines);
    return {
      row,
      journalLines,
      preparerId: String(row.submitted_by),
    };
  });

  const created = await createBooksJournal(prepared.preparerId, clientId, {
    periodId: String(prepared.row.period_id),
    entryDate: isoDate(prepared.row.expense_date) || "",
    memo: String(prepared.row.description || prepared.row.expense_no || "Expense"),
    reference: String(prepared.row.expense_no),
    voucherType: "Expense",
    lines: prepared.journalLines.map((l) => ({
      accountId: l.accountId,
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
      currency: String(prepared.row.currency || "AED"),
      originalMinor: l.debitMinor || l.creditMinor,
      fxRateScaled: 100_000_000,
      aedMinor: l.debitMinor || l.creditMinor,
      lineMemo: l.lineMemo,
      vatCode: null,
      vatTreatment: l.vatTreatment,
      isVatCompanion: true,
    })),
    post: false,
  });

  const posted = await postBooksJournal(userId, clientId, created.id);

  const expense = await withUser(userId, async (db) => {
    const bankTxnId = prepared.row.bank_txn_id
      ? String(prepared.row.bank_txn_id)
      : null;
    if (bankTxnId) {
      await assertAndMarkBankTxnPosted(db, {
        clientId,
        bankTxnId,
        expenseId: id,
        journalEntryId: created.id,
        paidFromAccountId: String(prepared.row.paid_from_account_id),
        paidFromKind: String(prepared.row.paid_from_kind || ""),
        grossMinor: Number(prepared.row.gross_minor),
        actor: userId,
      });
    }
    const updated = await db.query(
      `UPDATE books_expenses SET
         status = 'approved',
         approved_by = $3,
         approved_at = now(),
         journal_entry_id = $4,
         updated_at = now()
       WHERE id = $1 AND client_id = $2
       RETURNING *`,
      [id, clientId, userId, created.id],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "approve_expense",
      entity: "books_expense",
      entityId: id,
      before: { status: "pending" },
      after: {
        status: "approved",
        journalEntryId: created.id,
        entryNo: posted.entryNo,
        bankTxnId,
      },
    });
    return mapExpense(updated.rows[0]);
  });

  return { ...expense, journalEntryId: created.id, entryNo: posted.entryNo };
}

const MATCH_DATE_WINDOW_DAYS = 14;

export type ExpenseBankCandidate = {
  id: string;
  txnDate: string | null;
  description: string;
  debitMinor: number;
  accountId: string;
  accountCode: string | null;
  reviewStatus: string;
};

async function assertBankTxnMatchesExpense(
  db: PoolClient,
  opts: {
    clientId: string;
    bankTxnId: string;
    expenseId: string;
    paidFromAccountId: string;
    paidFromKind: string;
    grossMinor: number;
  },
) {
  if (!["bank", "card"].includes(opts.paidFromKind)) {
    throw new BooksError("bank_match_only_for_bank_or_card", "invalid");
  }
  const txn = await db.query(
    `SELECT t.*, a.code AS account_code
     FROM books_bank_transactions t
     JOIN books_accounts a ON a.id = t.account_id
     WHERE t.id = $1 AND t.client_id = $2`,
    [opts.bankTxnId, opts.clientId],
  );
  if (!txn.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
  const row = txn.rows[0];
  if (String(row.review_status) === "posted") {
    throw new BooksError("bank_txn_already_posted", "conflict");
  }
  if (String(row.review_status) === "excluded") {
    throw new BooksError("bank_txn_excluded", "conflict");
  }
  if (String(row.account_id) !== opts.paidFromAccountId) {
    throw new BooksError("bank_txn_account_mismatch", "invalid");
  }
  const debit = Number(row.debit_minor || 0);
  if (debit <= 0) throw new BooksError("bank_txn_not_outflow", "invalid");
  if (debit !== opts.grossMinor) throw new BooksError("bank_txn_amount_mismatch", "invalid");
  if (row.journal_entry_id) throw new BooksError("bank_txn_already_posted", "conflict");

  const taken = await db.query(
    `SELECT id FROM books_expenses
     WHERE client_id = $1 AND bank_txn_id = $2 AND deleted_at IS NULL AND id <> $3`,
    [opts.clientId, opts.bankTxnId, opts.expenseId],
  );
  if (taken.rowCount) throw new BooksError("bank_txn_already_linked", "conflict");

  return row;
}

async function assertAndMarkBankTxnPosted(
  db: PoolClient,
  opts: {
    clientId: string;
    bankTxnId: string;
    expenseId: string;
    journalEntryId: string;
    paidFromAccountId: string;
    paidFromKind: string;
    grossMinor: number;
    actor: string;
  },
) {
  await assertBankTxnMatchesExpense(db, opts);
  await db.query(
    `UPDATE books_bank_transactions SET
       review_status = 'posted',
       journal_entry_id = $3,
       posted_by = $4,
       posted_at = now(),
       updated_at = now()
     WHERE id = $1 AND client_id = $2
       AND review_status IN ('needs_review', 'ready')`,
    [opts.bankTxnId, opts.clientId, opts.journalEntryId, opts.actor],
  );
  await writeBooksAudit(db, {
    clientId: opts.clientId,
    actor: opts.actor,
    action: "link_expense_bank_txn",
    entity: "books_bank_transaction",
    entityId: opts.bankTxnId,
    after: {
      review_status: "posted",
      journalEntryId: opts.journalEntryId,
      expenseId: opts.expenseId,
    },
  });
}

/** Link (or clear) a bank/card outflow on a draft/pending expense. */
export async function linkBooksExpenseBankTxn(
  userId: string,
  clientId: string,
  id: string,
  bankTxnId: string | null,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_expenses WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [id, clientId],
    );
    if (!before.rowCount) throw new BooksError("expense_not_found", "not_found");
    const row = before.rows[0];
    if (!["draft", "pending", "rejected"].includes(String(row.status))) {
      throw new BooksError("expense_not_linkable", "conflict");
    }
    const kind = String(row.paid_from_kind || "");
    if (bankTxnId) {
      if (!row.paid_from_account_id) throw new BooksError("paid_from_required", "invalid");
      await assertBankTxnMatchesExpense(db, {
        clientId,
        bankTxnId,
        expenseId: id,
        paidFromAccountId: String(row.paid_from_account_id),
        paidFromKind: kind,
        grossMinor: Number(row.gross_minor),
      });
    }
    const updated = await db.query(
      `UPDATE books_expenses SET bank_txn_id = $3, updated_at = now()
       WHERE id = $1 AND client_id = $2
       RETURNING *`,
      [id, clientId, bankTxnId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: bankTxnId ? "set_expense_bank_txn" : "clear_expense_bank_txn",
      entity: "books_expense",
      entityId: id,
      before: { bank_txn_id: row.bank_txn_id },
      after: { bankTxnId },
    });
    return mapExpense(updated.rows[0]);
  });
}

/** Candidate outflows on the paid-from account (±14 days, amount = gross). */
export async function listBooksExpenseBankCandidates(
  userId: string,
  clientId: string,
  id: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasExpensesTable(db))) return [];
    const exp = await db.query(
      `SELECT * FROM books_expenses WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [id, clientId],
    );
    if (!exp.rowCount) throw new BooksError("expense_not_found", "not_found");
    const row = exp.rows[0];
    const kind = String(row.paid_from_kind || "");
    if (!["bank", "card"].includes(kind) || !row.paid_from_account_id) return [];

    const rows = await db.query(
      `SELECT t.id, t.txn_date, t.description, t.debit_minor, t.account_id, t.review_status,
              a.code AS account_code
       FROM books_bank_transactions t
       JOIN books_accounts a ON a.id = t.account_id
       WHERE t.client_id = $1
         AND t.account_id = $2
         AND t.debit_minor = $3
         AND t.credit_minor = 0
         AND t.review_status IN ('needs_review', 'ready')
         AND t.journal_entry_id IS NULL
         AND t.txn_date BETWEEN ($4::date - $5::int) AND ($4::date + $5::int)
         AND NOT EXISTS (
           SELECT 1 FROM books_expenses e
           WHERE e.bank_txn_id = t.id AND e.deleted_at IS NULL AND e.id <> $6
         )
       ORDER BY abs(t.txn_date - $4::date), t.txn_date DESC
       LIMIT 25`,
      [
        clientId,
        row.paid_from_account_id,
        Number(row.gross_minor),
        row.expense_date,
        MATCH_DATE_WINDOW_DAYS,
        id,
      ],
    );
    return rows.rows.map(
      (r): ExpenseBankCandidate => ({
        id: String(r.id),
        txnDate: isoDate(r.txn_date),
        description: String(r.description || ""),
        debitMinor: Number(r.debit_minor),
        accountId: String(r.account_id),
        accountCode: r.account_code ? String(r.account_code) : null,
        reviewStatus: String(r.review_status),
      }),
    );
  });
}

/**
 * After approve with no bank line yet: match a later statement outflow to the expense journal
 * (marks the bank txn posted — does not create a second journal).
 */
export async function matchApprovedExpenseToBankTxn(
  userId: string,
  clientId: string,
  id: string,
  bankTxnId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_expenses WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [id, clientId],
    );
    if (!before.rowCount) throw new BooksError("expense_not_found", "not_found");
    const row = before.rows[0];
    if (String(row.status) !== "approved") {
      throw new BooksError("expense_not_approved", "conflict");
    }
    if (!row.journal_entry_id) throw new BooksError("expense_missing_journal", "conflict");
    if (row.bank_txn_id) throw new BooksError("expense_already_matched", "conflict");
    if (!row.paid_from_account_id) throw new BooksError("paid_from_required", "invalid");

    await assertAndMarkBankTxnPosted(db, {
      clientId,
      bankTxnId,
      expenseId: id,
      journalEntryId: String(row.journal_entry_id),
      paidFromAccountId: String(row.paid_from_account_id),
      paidFromKind: String(row.paid_from_kind || ""),
      grossMinor: Number(row.gross_minor),
      actor: userId,
    });

    const updated = await db.query(
      `UPDATE books_expenses SET bank_txn_id = $3, updated_at = now()
       WHERE id = $1 AND client_id = $2
       RETURNING *`,
      [id, clientId, bankTxnId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "match_expense_bank_txn",
      entity: "books_expense",
      entityId: id,
      after: { bankTxnId, journalEntryId: row.journal_entry_id },
    });
    return mapExpense(updated.rows[0]);
  });
}

/** Soft-delete draft only. */
export async function softDeleteBooksExpenseDraft(
  userId: string,
  clientId: string,
  id: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT id, status, expense_no, deleted_at FROM books_expenses
       WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!before.rowCount || before.rows[0].deleted_at) {
      throw new BooksError("expense_not_found", "not_found");
    }
    if (String(before.rows[0].status) !== "draft") {
      throw new BooksError("expense_not_draft", "conflict");
    }
    await db.query(
      `UPDATE books_expenses SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "soft_delete_expense_draft",
      entity: "books_expense",
      entityId: id,
      before: { status: "draft", expense_no: before.rows[0].expense_no },
      after: { deleted: true },
    });
    return { id, deleted: true };
  });
}
