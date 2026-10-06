import { withUser } from "@/lib/db";
import {
  bankInstrumentType,
  computeStatementCoverage,
  ibanLast4,
  isBankAccountSetUp,
  normalizeIban,
  type BankInstrumentType,
} from "@/lib/statement-coverage";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export type BooksBankAccountRow = {
  id: string;
  code: string;
  name: string;
  instrumentType: BankInstrumentType;
  bankName: string | null;
  iban: string | null;
  ibanLast4: string | null;
  currency: string;
  setupOk: boolean;
  coverageFrom: string | null;
  coverageTo: string | null;
  gaps: Array<{ from: string; to: string }>;
  lastClosingMinor: number | null;
  ledgerBalanceMinor: number;
  differenceMinor: number | null;
  unreviewedLineCount: number;
  statementCount: number;
};

type StmtRow = {
  id: string;
  accountId: string | null;
  iban: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  closingBalanceMinor: number | null;
  status: string;
  lineCount: number;
};

function isoDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

export async function listBooksBankAccounts(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);

    // Migration guard for older DBs mid-apply.
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'books_accounts' AND column_name IN ('is_card','iban')`,
    );
    if ((cols.rowCount || 0) < 2) {
      throw new BooksError("c2_bank_accounts_migration_required", "invalid");
    }

    const accounts = await db.query(
      `SELECT a.id, a.code, a.name, a.sub_type AS "subType",
              a.is_bank AS "isBank", a.is_card AS "isCard", a.is_gateway AS "isGateway",
              a.bank_name AS "bankName", a.iban, a.iban_last4 AS "ibanLast4",
              a.currency,
              COALESCE((
                SELECT SUM(l.debit_minor - l.credit_minor)::bigint
                FROM books_journal_lines l
                JOIN books_journal_entries e ON e.id = l.entry_id
                WHERE l.account_id = a.id AND e.client_id = a.client_id
                  AND e.status IN ('posted', 'reversed') AND e.deleted_at IS NULL
              ), 0)::bigint AS "ledgerBalanceMinor"
       FROM books_accounts a
       WHERE a.client_id = $1 AND a.active = true AND a.is_postable = true
         AND (
           a.is_bank = true OR a.is_card = true OR a.is_gateway = true
           OR COALESCE(a.sub_type, '') IN ('bank','cash','card','gateway','clearing')
         )
       ORDER BY a.code`,
      [clientId],
    );

    const stmts = await db.query(
      `SELECT s.id, s.account_id AS "accountId", s.iban,
              s.period_from AS "periodFrom", s.period_to AS "periodTo",
              s.closing_balance_minor AS "closingBalanceMinor",
              s.status,
              (SELECT count(*)::int FROM books_statement_lines sl WHERE sl.statement_id = s.id) AS "lineCount"
       FROM books_statement_extractions s
       WHERE s.client_id = $1`,
      [clientId],
    );

    const statementRows = stmts.rows as StmtRow[];
    const byAccount = new Map<string, StmtRow[]>();

    for (const acc of accounts.rows) {
      byAccount.set(String(acc.id), []);
    }

    for (const s of statementRows) {
      let linked: string | null = s.accountId ? String(s.accountId) : null;
      if (!linked) {
        const sib = normalizeIban(s.iban);
        if (sib) {
          const match = accounts.rows.find(
            (a) => normalizeIban(a.iban as string | null) === sib,
          );
          if (match) linked = String(match.id);
        }
      }
      if (!linked || !byAccount.has(linked)) continue;
      byAccount.get(linked)!.push(s);
    }

    const out: BooksBankAccountRow[] = [];
    for (const acc of accounts.rows) {
      const id = String(acc.id);
      const instrumentType = bankInstrumentType({
        isBank: Boolean(acc.isBank),
        isCard: Boolean(acc.isCard),
        isGateway: Boolean(acc.isGateway),
        subType: acc.subType as string | null,
      });
      const last4 =
        (acc.ibanLast4 as string | null) || ibanLast4(acc.iban as string | null);
      const setupOk = isBankAccountSetUp({
        instrumentType,
        bankName: acc.bankName as string | null,
        iban: acc.iban as string | null,
        ibanLast4: last4,
      });

      const linked = byAccount.get(id) || [];
      const periods = linked
        .map((s) => ({
          from: isoDate(s.periodFrom) || "",
          to: isoDate(s.periodTo) || "",
        }))
        .filter((p) => p.from && p.to);
      const coverage = computeStatementCoverage(periods);

      const withClosing = linked
        .filter((s) => s.closingBalanceMinor != null && isoDate(s.periodTo))
        .sort((a, b) => String(isoDate(b.periodTo)).localeCompare(String(isoDate(a.periodTo))));
      const lastClosingMinor =
        withClosing[0]?.closingBalanceMinor == null
          ? null
          : Number(withClosing[0].closingBalanceMinor);

      const ledgerBalanceMinor = Number(acc.ledgerBalanceMinor || 0);
      const differenceMinor =
        lastClosingMinor == null ? null : lastClosingMinor - ledgerBalanceMinor;

      const unreviewedLineCount = linked
        .filter((s) => s.status === "needs_review")
        .reduce((n, s) => n + Number(s.lineCount || 0), 0);

      out.push({
        id,
        code: String(acc.code),
        name: String(acc.name),
        instrumentType,
        bankName: (acc.bankName as string | null) || null,
        iban: (acc.iban as string | null) || null,
        ibanLast4: last4,
        currency: String(acc.currency || "AED"),
        setupOk,
        coverageFrom: coverage.coverageFrom,
        coverageTo: coverage.coverageTo,
        gaps: coverage.gaps,
        lastClosingMinor,
        ledgerBalanceMinor,
        differenceMinor,
        unreviewedLineCount,
        statementCount: linked.length,
      });
    }
    return out;
  });
}

export async function updateBooksBankAccountSetup(
  userId: string,
  clientId: string,
  accountId: string,
  body: { bankName?: string | null; iban?: string | null; ibanLast4?: string | null },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT id, bank_name, iban, iban_last4, is_bank, is_card, is_gateway, sub_type
       FROM books_accounts WHERE id = $1 AND client_id = $2`,
      [accountId, clientId],
    );
    if (!before.rowCount) throw new BooksError("account_not_found", "not_found");

    const iban =
      body.iban === undefined
        ? before.rows[0].iban
        : body.iban
          ? normalizeIban(body.iban)
          : null;
    const last4 =
      body.ibanLast4 === undefined
        ? before.rows[0].iban_last4
        : body.ibanLast4
          ? String(body.ibanLast4).replace(/\D/g, "").slice(-4)
          : ibanLast4(iban);

    await db.query(
      `UPDATE books_accounts SET
         bank_name = CASE WHEN $3::boolean THEN $4 ELSE bank_name END,
         iban = $5,
         iban_last4 = $6
       WHERE id = $1 AND client_id = $2`,
      [
        accountId,
        clientId,
        body.bankName !== undefined,
        body.bankName ?? null,
        iban,
        last4,
      ],
    );

    // Soft-link statements that match this IBAN.
    if (iban) {
      await db.query(
        `UPDATE books_statement_extractions
         SET account_id = $1, updated_at = now()
         WHERE client_id = $2
           AND account_id IS NULL
           AND REPLACE(UPPER(COALESCE(iban,'')), ' ', '') = $3`,
        [accountId, clientId, iban],
      );
    }

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update_bank_account_setup",
      entity: "books_account",
      entityId: accountId,
      before: {
        bank_name: before.rows[0].bank_name,
        iban: before.rows[0].iban,
        iban_last4: before.rows[0].iban_last4,
      },
      after: { bank_name: body.bankName ?? before.rows[0].bank_name, iban, iban_last4: last4 },
    });

    return {
      id: accountId,
      bankName: body.bankName ?? before.rows[0].bank_name,
      iban,
      ibanLast4: last4,
    };
  });
}
