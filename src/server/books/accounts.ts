import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { writeBooksAudit } from "@/server/books/audit";
import { assertSyntheticTenant } from "@/server/security-gate";

export async function listBooksAccounts(
  userId: string,
  clientId: string,
  opts?: { postableOnly?: boolean; includeInactive?: boolean },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, code, name, account_type AS "accountType",
              parent_id AS "parentId", is_postable AS "isPostable",
              normal_balance AS "normalBalance",
              is_ar AS "isAr", is_ap AS "isAp", is_vat_control AS "isVatControl",
              is_bank AS "isBank", is_control AS "isControl",
              cash_flow_class AS "cashFlowClass",
              statement_line AS "statementLine", note_group AS "noteGroup",
              vat_class AS "vatClass", default_vat_code AS "defaultVatCode", active
       FROM books_accounts
       WHERE client_id = $1
         AND ($2::boolean IS TRUE OR active = true)
         AND ($3::boolean IS NOT TRUE OR is_postable = true)
       ORDER BY code`,
      [clientId, opts?.includeInactive ?? false, opts?.postableOnly ?? false],
    );
    return rows.rows;
  });
}

export type CoaNode = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  parentId: string | null;
  isPostable: boolean;
  normalBalance: string | null;
  statementLine: string | null;
  defaultVatCode: string | null;
  balanceMinor: number;
  active: boolean;
  children: CoaNode[];
};

async function accountBalancesForPeriod(
  db: Parameters<Parameters<typeof withUser>[1]>[0],
  clientId: string,
  periodId: string | undefined,
) {
  if (!periodId) return new Map<string, number>();
  const period = await db.query(
    `SELECT period_end FROM books_periods WHERE id = $1 AND client_id = $2`,
    [periodId, clientId],
  );
  if (!period.rowCount) return new Map<string, number>();
  const periodEnd = period.rows[0].period_end;
  const rows = await db.query(
    `SELECT l.account_id AS id,
            (COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0))::bigint AS net
     FROM books_journal_lines l
     JOIN books_journal_entries e ON e.id = l.entry_id
     WHERE e.client_id = $1 AND e.status IN ('posted', 'reversed')
       AND e.entry_date <= $2::date
     GROUP BY l.account_id`,
    [clientId, periodEnd],
  );
  return new Map(rows.rows.map((r) => [String(r.id), Number(r.net)]));
}

export async function booksCoaTree(userId: string, clientId: string, periodId?: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, code, name, account_type AS "accountType",
              parent_id AS "parentId", is_postable AS "isPostable",
              normal_balance AS "normalBalance",
              statement_line AS "statementLine", default_vat_code AS "defaultVatCode", active
       FROM books_accounts
       WHERE client_id = $1
       ORDER BY code`,
      [clientId],
    );
    const balances = await accountBalancesForPeriod(db, clientId, periodId);
    return buildCoaTree(rows.rows, balances);
  });
}

function buildCoaTree(flat: Array<Record<string, unknown>>, balances: Map<string, number>) {
  const byId = new Map<string, CoaNode>();
  for (const row of flat) {
    byId.set(String(row.id), {
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      accountType: String(row.accountType),
      parentId: row.parentId ? String(row.parentId) : null,
      isPostable: Boolean(row.isPostable),
      normalBalance: row.normalBalance == null ? null : String(row.normalBalance),
      statementLine: row.statementLine == null ? null : String(row.statementLine),
      defaultVatCode: row.defaultVatCode == null ? null : String(row.defaultVatCode),
      balanceMinor: balances.get(String(row.id)) ?? 0,
      active: Boolean(row.active),
      children: [],
    });
  }
  const roots: CoaNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const rollup = (node: CoaNode): number => {
    let childSum = 0;
    for (const child of node.children) childSum += rollup(child);
    // Header accounts: show rolled-up children only (no own balance).
    if (!node.isPostable) node.balanceMinor = childSum;
    return node.isPostable ? node.balanceMinor : childSum;
  };
  const sortRec = (nodes: CoaNode[]) => {
    nodes.sort((a, b) => a.code.localeCompare(b.code));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  for (const r of roots) rollup(r);
  return roots;
}

export async function createBooksAccount(
  userId: string,
  clientId: string,
  body: {
    code: string;
    name: string;
    accountType: string;
    parentId?: string | null;
    normalBalance?: string;
    statementLine?: string;
    defaultVatCode?: string | null;
    isPostable?: boolean;
  },
) {
  const code = body.code.trim();
  const name = body.name.trim();
  if (!code || !name) throw new BooksError("account_fields_required", "invalid_line");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const id = randomUUID();
    const parentId = body.parentId || null;
    const isPostable = body.isPostable ?? true;
    await db.query(
      `INSERT INTO books_accounts (
         id, client_id, code, name, account_type, parent_id, is_postable,
         normal_balance, statement_line, default_vat_code, active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
      [
        id,
        clientId,
        code,
        name,
        body.accountType,
        parentId,
        isPostable,
        body.normalBalance || (body.accountType === "asset" || body.accountType === "expense" ? "debit" : "credit"),
        body.statementLine || null,
        body.defaultVatCode ?? null,
      ],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create_account",
      entity: "books_account",
      entityId: id,
      after: { code, name },
    });
    return { id, code, name };
  });
}

export async function updateBooksAccount(
  userId: string,
  clientId: string,
  accountId: string,
  body: {
    name?: string;
    statementLine?: string | null;
    defaultVatCode?: string | null;
    normalBalance?: string;
  },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT id, name, statement_line, default_vat_code, normal_balance
       FROM books_accounts WHERE id = $1 AND client_id = $2`,
      [accountId, clientId],
    );
    if (!before.rowCount) throw new BooksError("account_not_found", "not_found");
    const name = body.name?.trim() || before.rows[0].name;
    const statementLine =
      body.statementLine === undefined ? before.rows[0].statement_line : body.statementLine;
    const defaultVatCode =
      body.defaultVatCode === undefined ? before.rows[0].default_vat_code : body.defaultVatCode;
    const normalBalance = body.normalBalance || before.rows[0].normal_balance;
    await db.query(
      `UPDATE books_accounts
       SET name = $3, statement_line = $4, default_vat_code = $5, normal_balance = $6
       WHERE id = $1 AND client_id = $2`,
      [accountId, clientId, name, statementLine, defaultVatCode, normalBalance],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update_account",
      entity: "books_account",
      entityId: accountId,
      before: before.rows[0],
      after: { name, statementLine, defaultVatCode, normalBalance },
    });
    return { id: accountId, name };
  });
}

export async function deactivateBooksAccount(userId: string, clientId: string, accountId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT id, code, active, is_postable AS "isPostable" FROM books_accounts WHERE id = $1 AND client_id = $2`,
      [accountId, clientId],
    );
    if (!before.rowCount) throw new BooksError("account_not_found", "not_found");
    const kids = await db.query(
      `SELECT 1 FROM books_accounts WHERE parent_id = $1 AND client_id = $2 AND active = true LIMIT 1`,
      [accountId, clientId],
    );
    if (kids.rowCount) {
      throw new BooksError("account_has_active_children", "conflict");
    }
    const bal = await db.query(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::bigint AS net
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1 AND e.client_id = $2
         AND e.status IN ('posted', 'reversed')`,
      [accountId, clientId],
    );
    if (Number(bal.rows[0]?.net || 0) !== 0) {
      throw new BooksError("account_has_balance", "conflict");
    }
    await db.query(
      `UPDATE books_accounts SET active = false WHERE id = $1 AND client_id = $2`,
      [accountId, clientId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "deactivate_account",
      entity: "books_account",
      entityId: accountId,
      before: before.rows[0],
      after: { active: false },
    });
    return { id: accountId, active: false };
  });
}

export async function getBooksCompanyProfile(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const row = await db.query(
      `SELECT id, name, trn, default_currency AS "defaultCurrency", is_synthetic AS "isSynthetic",
              fiscal_year_start_month AS "fiscalYearStartMonth",
              books_start_period_id AS "booksStartPeriodId"
       FROM clients WHERE id = $1`,
      [clientId],
    );
    if (!row.rowCount) throw new BooksError("client_not_found", "not_found");
    return row.rows[0];
  });
}

export async function updateBooksCompanyProfile(
  userId: string,
  clientId: string,
  body: {
    name?: string;
    trn?: string | null;
    defaultCurrency?: string;
    fiscalYearStartMonth?: number;
  },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT name, trn, default_currency, fiscal_year_start_month FROM clients WHERE id = $1`,
      [clientId],
    );
    if (!before.rowCount) throw new BooksError("client_not_found", "not_found");
    const name = body.name?.trim() || before.rows[0].name;
    const trn = body.trn === undefined ? before.rows[0].trn : body.trn;
    const currency = body.defaultCurrency || before.rows[0].default_currency;
    let fy = Number(before.rows[0].fiscal_year_start_month || 1);
    if (body.fiscalYearStartMonth != null) {
      fy = Math.min(12, Math.max(1, Math.floor(body.fiscalYearStartMonth)));
    }
    await db.query(
      `UPDATE clients SET name = $2, trn = $3, default_currency = $4, fiscal_year_start_month = $5 WHERE id = $1`,
      [clientId, name, trn, currency, fy],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update_profile",
      entity: "client",
      entityId: clientId,
      before: before.rows[0],
      after: { name, trn, defaultCurrency: currency, fiscalYearStartMonth: fy },
    });
    return { id: clientId, name, trn, defaultCurrency: currency, fiscalYearStartMonth: fy };
  });
}

export async function listBooksUsers(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT u.id, u.name, u.email, u.role
       FROM users u
       JOIN user_client_access a ON a.user_id = u.id
       WHERE a.client_id = $1
       ORDER BY u.name`,
      [clientId],
    );
    return rows.rows;
  });
}

const BOOKS_ROLES = new Set(["admin", "accountant", "approver", "viewer"]);

export async function updateBooksUserRole(
  userId: string,
  clientId: string,
  targetUserId: string,
  role: string,
) {
  if (!BOOKS_ROLES.has(role)) throw new BooksError("invalid_role", "invalid");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const actor = await db.query(`SELECT role FROM users WHERE id = $1`, [userId]);
    if (!actor.rowCount || !["admin", "approver"].includes(String(actor.rows[0].role))) {
      throw new BooksError("role_change_forbidden", "forbidden");
    }
    const access = await db.query(
      `SELECT 1 FROM user_client_access WHERE user_id = $1 AND client_id = $2`,
      [targetUserId, clientId],
    );
    if (!access.rowCount) throw new BooksError("user_not_on_client", "not_found");
    const before = await db.query(`SELECT id, role FROM users WHERE id = $1`, [targetUserId]);
    await db.query(`UPDATE users SET role = $2 WHERE id = $1`, [targetUserId, role]);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "role_change",
      entity: "user",
      entityId: targetUserId,
      before: before.rows[0],
      after: { role },
    });
    return { id: targetUserId, role };
  });
}

export async function inviteBooksUser(
  userId: string,
  clientId: string,
  body: { email: string; role: string },
) {
  const email = body.email.trim().toLowerCase();
  const role = body.role || "accountant";
  if (!email || !BOOKS_ROLES.has(role)) throw new BooksError("invalid_invite", "invalid");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const actor = await db.query(`SELECT role, firm_id FROM users WHERE id = $1`, [userId]);
    if (!actor.rowCount || !["admin", "approver"].includes(String(actor.rows[0].role))) {
      throw new BooksError("invite_forbidden", "forbidden");
    }
    const id = randomUUID();
    await db.query(
      `INSERT INTO books_user_invites (id, firm_id, client_id, email, role, invited_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [id, actor.rows[0].firm_id, clientId, email, role, userId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "invite",
      entity: "books_user_invite",
      entityId: id,
      after: { email, role, status: "pending" },
    });
    return { id, email, role, status: "pending", delivery: "stub" };
  });
}

export async function listBooksInvites(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, email, role, status, created_at AS "createdAt"
       FROM books_user_invites WHERE client_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [clientId],
    );
    return rows.rows;
  });
}
