import { withUser } from "@/lib/db";
import {
  bankRuleMatches,
  pickBankRule,
  type BankRuleDef,
  type BankRuleTxnProbe,
} from "@/lib/bank-rules";
import { BANK_TXN_TYPES } from "@/lib/bank-txn-types";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export type { BankRuleDef };

async function hasRulesTable(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}) {
  const t = await db.query(`SELECT to_regclass('books_bank_rules') AS t`);
  return Boolean(t.rows[0]?.t);
}

function mapRule(r: Record<string, unknown>): BankRuleDef {
  return {
    id: String(r.id),
    name: String(r.name),
    priority: Number(r.priority),
    active: Boolean(r.active),
    counterpartyContains: r.counterparty_contains == null ? null : String(r.counterparty_contains),
    narrationRegex: r.narration_regex == null ? null : String(r.narration_regex),
    amountMinMinor: r.amount_min_minor == null ? null : Number(r.amount_min_minor),
    amountMaxMinor: r.amount_max_minor == null ? null : Number(r.amount_max_minor),
    accountId: r.account_id == null ? null : String(r.account_id),
    direction: r.direction == null ? null : (String(r.direction) as "in" | "out"),
    setTxnType: r.set_txn_type == null ? null : String(r.set_txn_type),
    setCategoryAccountId:
      r.set_category_account_id == null ? null : String(r.set_category_account_id),
    setVatCode: r.set_vat_code == null ? null : String(r.set_vat_code),
    setTags: Array.isArray(r.set_tags) ? r.set_tags.map(String) : [],
    setCounterparty: r.set_counterparty == null ? null : String(r.set_counterparty),
  };
}

export async function listBooksBankRules(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasRulesTable(db))) return [];
    const rows = await db.query(
      `SELECT * FROM books_bank_rules WHERE client_id = $1 ORDER BY priority ASC, created_at ASC`,
      [clientId],
    );
    return rows.rows.map(mapRule);
  });
}

export async function createBooksBankRule(
  userId: string,
  clientId: string,
  body: Partial<BankRuleDef> & { name: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasRulesTable(db))) {
      throw new BooksError("p2a_bank_rules_migration_required", "invalid");
    }
    const name = String(body.name || "").trim();
    if (!name) throw new BooksError("rule_name_required", "invalid");
    if (body.setTxnType && !(BANK_TXN_TYPES as readonly string[]).includes(body.setTxnType)) {
      throw new BooksError("invalid_txn_type", "invalid");
    }
    if (body.narrationRegex) {
      try {
        void new RegExp(body.narrationRegex, "i");
      } catch {
        throw new BooksError("invalid_narration_regex", "invalid");
      }
    }
    const inserted = await db.query(
      `INSERT INTO books_bank_rules (
         client_id, name, priority, active,
         counterparty_contains, narration_regex, amount_min_minor, amount_max_minor,
         account_id, direction,
         set_txn_type, set_category_account_id, set_vat_code, set_tags, set_counterparty,
         created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text[],$15,$16
       ) RETURNING *`,
      [
        clientId,
        name,
        body.priority ?? 100,
        body.active !== false,
        body.counterpartyContains || null,
        body.narrationRegex || null,
        body.amountMinMinor ?? null,
        body.amountMaxMinor ?? null,
        body.accountId || null,
        body.direction || null,
        body.setTxnType || null,
        body.setCategoryAccountId || null,
        body.setVatCode || null,
        body.setTags || [],
        body.setCounterparty || null,
        userId,
      ],
    );
    const rule = mapRule(inserted.rows[0]);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create_bank_rule",
      entity: "books_bank_rule",
      entityId: rule.id,
      after: { name: rule.name, priority: rule.priority },
    });
    return rule;
  });
}

/** Build a rule draft from an existing bank txn (create-from-this). */
export async function createBooksBankRuleFromTxn(
  userId: string,
  clientId: string,
  txnId: string,
  opts?: { name?: string; priority?: number },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const txn = await db.query(
      `SELECT * FROM books_bank_transactions WHERE id = $1 AND client_id = $2`,
      [txnId, clientId],
    );
    if (!txn.rowCount) throw new BooksError("bank_txn_not_found", "not_found");
    const row = txn.rows[0];
    const desc = String(row.description || "").trim();
    const direction: "in" | "out" | null =
      Number(row.credit_minor || 0) > 0 ? "in" : Number(row.debit_minor || 0) > 0 ? "out" : null;
    const name =
      opts?.name?.trim() ||
      (desc ? `Rule: ${desc.slice(0, 40)}` : `Rule from ${String(txnId).slice(0, 8)}`);
    const draft: Partial<BankRuleDef> & { name: string } = {
      name,
      priority: opts?.priority ?? 50,
      counterpartyContains: desc.split(/\s+/).slice(0, 3).join(" ") || null,
      accountId: String(row.account_id),
      direction,
      setTxnType: row.txn_type ? String(row.txn_type) : null,
      setCategoryAccountId: row.category_account_id ? String(row.category_account_id) : null,
    };
    return draft;
  }).then((draft) => createBooksBankRule(userId, clientId, draft));
}

export async function previewBooksBankRule(
  userId: string,
  clientId: string,
  ruleId: string,
  limit = 50,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasRulesTable(db))) {
      throw new BooksError("p2a_bank_rules_migration_required", "invalid");
    }
    const ruleRow = await db.query(
      `SELECT * FROM books_bank_rules WHERE id = $1 AND client_id = $2`,
      [ruleId, clientId],
    );
    if (!ruleRow.rowCount) throw new BooksError("bank_rule_not_found", "not_found");
    const rule = mapRule(ruleRow.rows[0]);
    const txns = await db.query(
      `SELECT id, account_id, description, reference, debit_minor, credit_minor, txn_type,
              category_account_id, review_status
       FROM books_bank_transactions
       WHERE client_id = $1 AND review_status IN ('needs_review','ready')
       ORDER BY txn_date DESC NULLS LAST
       LIMIT 500`,
      [clientId],
    );
    const hits: Array<{ id: string; description: string; amountMinor: number }> = [];
    for (const t of txns.rows) {
      const probe: BankRuleTxnProbe = {
        accountId: String(t.account_id),
        description: String(t.description || ""),
        reference: t.reference == null ? null : String(t.reference),
        debitMinor: Number(t.debit_minor || 0),
        creditMinor: Number(t.credit_minor || 0),
      };
      if (bankRuleMatches(rule, probe)) {
        hits.push({
          id: String(t.id),
          description: probe.description,
          amountMinor: Math.max(probe.debitMinor, probe.creditMinor),
        });
        if (hits.length >= limit) break;
      }
    }
    return { ruleId, name: rule.name, matchCount: hits.length, sample: hits };
  });
}

/** Apply highest-priority matching rule suggestions onto Needs Review rows (non-destructive). */
export async function applyBooksBankRuleSuggestions(
  userId: string,
  clientId: string,
  opts?: { accountId?: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasRulesTable(db))) return { updated: 0 };
    const rules = (
      await db.query(
        `SELECT * FROM books_bank_rules WHERE client_id = $1 AND active = true
         ORDER BY priority ASC, created_at ASC`,
        [clientId],
      )
    ).rows.map(mapRule);
    if (rules.length === 0) return { updated: 0 };

    const txns = await db.query(
      `SELECT * FROM books_bank_transactions
       WHERE client_id = $1 AND review_status = 'needs_review'
         AND ($2::uuid IS NULL OR account_id = $2)
         AND txn_type IS NULL`,
      [clientId, opts?.accountId || null],
    );
    let updated = 0;
    for (const row of txns.rows) {
      const probe: BankRuleTxnProbe = {
        accountId: String(row.account_id),
        description: String(row.description || ""),
        reference: row.reference == null ? null : String(row.reference),
        debitMinor: Number(row.debit_minor || 0),
        creditMinor: Number(row.credit_minor || 0),
      };
      const rule = pickBankRule(rules, probe);
      if (!rule) continue;
      await db.query(
        `UPDATE books_bank_transactions SET
           txn_type = COALESCE(txn_type, $3),
           category_account_id = COALESCE(category_account_id, $4),
           suggestion_rule_id = $5,
           suggestion_source = $6,
           updated_at = now()
         WHERE id = $1 AND client_id = $2`,
        [
          row.id,
          clientId,
          rule.setTxnType,
          rule.setCategoryAccountId,
          rule.id,
          `Rule: ${rule.name}`,
        ],
      );
      updated += 1;
    }
    if (updated > 0) {
      await writeBooksAudit(db, {
        clientId,
        actor: userId,
        action: "apply_bank_rule_suggestions",
        entity: "books_bank_transactions",
        entityId: clientId,
        after: { updated },
      });
    }
    return { updated };
  });
}

export async function updateBooksBankRule(
  userId: string,
  clientId: string,
  ruleId: string,
  body: Partial<BankRuleDef> & { active?: boolean; priority?: number; name?: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!(await hasRulesTable(db))) {
      throw new BooksError("p2a_bank_rules_migration_required", "invalid");
    }
    const before = await db.query(
      `SELECT * FROM books_bank_rules WHERE id = $1 AND client_id = $2`,
      [ruleId, clientId],
    );
    if (!before.rowCount) throw new BooksError("bank_rule_not_found", "not_found");
    const cur = mapRule(before.rows[0]);
    const name = body.name !== undefined ? String(body.name).trim() : cur.name;
    if (!name) throw new BooksError("rule_name_required", "invalid");
    if (body.narrationRegex) {
      try {
        void new RegExp(body.narrationRegex, "i");
      } catch {
        throw new BooksError("invalid_narration_regex", "invalid");
      }
    }
    const updated = await db.query(
      `UPDATE books_bank_rules SET
         name = $3,
         priority = $4,
         active = $5,
         counterparty_contains = $6,
         narration_regex = $7,
         amount_min_minor = $8,
         amount_max_minor = $9,
         account_id = $10,
         direction = $11,
         set_txn_type = $12,
         set_category_account_id = $13,
         set_vat_code = $14,
         set_tags = $15::text[],
         set_counterparty = $16,
         updated_at = now()
       WHERE id = $1 AND client_id = $2
       RETURNING *`,
      [
        ruleId,
        clientId,
        name,
        body.priority ?? cur.priority,
        body.active !== undefined ? Boolean(body.active) : cur.active,
        body.counterpartyContains !== undefined
          ? body.counterpartyContains || null
          : cur.counterpartyContains,
        body.narrationRegex !== undefined ? body.narrationRegex || null : cur.narrationRegex,
        body.amountMinMinor !== undefined ? body.amountMinMinor : cur.amountMinMinor,
        body.amountMaxMinor !== undefined ? body.amountMaxMinor : cur.amountMaxMinor,
        body.accountId !== undefined ? body.accountId || null : cur.accountId,
        body.direction !== undefined ? body.direction || null : cur.direction,
        body.setTxnType !== undefined ? body.setTxnType || null : cur.setTxnType,
        body.setCategoryAccountId !== undefined
          ? body.setCategoryAccountId || null
          : cur.setCategoryAccountId,
        body.setVatCode !== undefined ? body.setVatCode || null : cur.setVatCode,
        body.setTags !== undefined ? body.setTags : cur.setTags,
        body.setCounterparty !== undefined
          ? body.setCounterparty || null
          : cur.setCounterparty,
      ],
    );
    const rule = mapRule(updated.rows[0]);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update_bank_rule",
      entity: "books_bank_rule",
      entityId: ruleId,
      before: { name: cur.name, priority: cur.priority, active: cur.active },
      after: { name: rule.name, priority: rule.priority, active: rule.active },
    });
    return rule;
  });
}
