import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

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
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  submittedBy: string | null;
  approvedBy: string | null;
  rejectionReason: string | null;
  journalEntryId: string | null;
  createdBy: string;
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

    let vendorPartyId: string | null = body.vendorPartyId || null;
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
      let vatCode: string | null = raw.vatCode ? String(raw.vatCode) : null;
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
    if (String(row.status) !== "draft") {
      throw new BooksError("expense_not_draft", "conflict");
    }

    const expenseDate = body.expenseDate !== undefined ? isoDate(body.expenseDate) : isoDate(row.expense_date);
    if (!expenseDate) throw new BooksError("expense_date_required", "invalid");
    const periodId = body.periodId !== undefined ? body.periodId : String(row.period_id);
    if (!periodId) throw new BooksError("period_required", "invalid");

    let vendorPartyId =
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
        let vatCode: string | null = raw.vatCode ? String(raw.vatCode) : null;
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
      after: { status: "draft", grossMinor: grossTotal },
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
