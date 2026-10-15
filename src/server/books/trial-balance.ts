import { withUser } from "@/lib/db";
import { assertSyntheticTenant } from "@/server/security-gate";
import { BooksError } from "@/server/books/errors";
import { assertUuid } from "@/server/books/periods";

export type TbAccountRow = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string | null;
  statementLine: string | null;
  defaultVatCode: string | null;
  openingDebitMinor: number;
  openingCreditMinor: number;
  periodDebitMinor: number;
  periodCreditMinor: number;
  closingDebitMinor: number;
  closingCreditMinor: number;
};

const GROUP_ORDER = ["asset", "liability", "equity", "income", "expense"] as const;
const GROUP_LABELS: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Revenue",
  expense: "Expenses",
};

function netToSides(debit: number, credit: number) {
  const net = debit - credit;
  if (net >= 0) return { closingDebitMinor: net, closingCreditMinor: 0 };
  return { closingDebitMinor: 0, closingCreditMinor: -net };
}

export async function booksTrialBalance(
  userId: string,
  clientId: string,
  periodId: string,
  opts?: { includeZeroBalances?: boolean },
) {
  assertUuid(periodId, "invalid_period_id");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const period = await db.query(
      `SELECT id, label, period_start, period_end FROM books_periods
       WHERE id = $1 AND client_id = $2`,
      [periodId, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    const periodStart = String(period.rows[0].period_start);
    const periodEnd = String(period.rows[0].period_end);
    const includeZero = Boolean(opts?.includeZeroBalances);

    const rows = await db.query(
      `SELECT a.id, a.code, a.name, a.account_type AS "accountType",
              a.normal_balance AS "normalBalance",
              a.statement_line AS "statementLine",
              a.default_vat_code AS "defaultVatCode",
              COALESCE(SUM(CASE WHEN e.entry_date < $2::date THEN l.debit_minor ELSE 0 END), 0)::bigint AS "openingDebitMinor",
              COALESCE(SUM(CASE WHEN e.entry_date < $2::date THEN l.credit_minor ELSE 0 END), 0)::bigint AS "openingCreditMinor",
              COALESCE(SUM(CASE WHEN e.entry_date >= $2::date AND e.entry_date <= $3::date THEN l.debit_minor ELSE 0 END), 0)::bigint AS "periodDebitMinor",
              COALESCE(SUM(CASE WHEN e.entry_date >= $2::date AND e.entry_date <= $3::date THEN l.credit_minor ELSE 0 END), 0)::bigint AS "periodCreditMinor"
       FROM books_accounts a
       LEFT JOIN books_journal_lines l ON l.account_id = a.id
       LEFT JOIN books_journal_entries e ON e.id = l.entry_id
         AND e.client_id = $1
         AND e.status IN ('posted', 'reversed')
         AND e.deleted_at IS NULL
         AND e.entry_date <= $3::date
       WHERE a.client_id = $1 AND a.active = true AND a.is_postable = true
       GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance, a.statement_line, a.default_vat_code
       HAVING
         $4::boolean
         OR (
           COALESCE(SUM(l.debit_minor), 0) - COALESCE(SUM(l.credit_minor), 0)
         ) <> 0
       ORDER BY a.code`,
      [clientId, periodStart, periodEnd, includeZero],
    );

    const accounts: Record<string, TbAccountRow> = {};
    const byGroup: Record<string, TbAccountRow[]> = {};
    let totalClosingDebit = 0;
    let totalClosingCredit = 0;

    for (const row of rows.rows) {
      const openingDebitMinor = Number(row.openingDebitMinor);
      const openingCreditMinor = Number(row.openingCreditMinor);
      const periodDebitMinor = Number(row.periodDebitMinor);
      const periodCreditMinor = Number(row.periodCreditMinor);
      const closingGrossDebit = openingDebitMinor + periodDebitMinor;
      const closingGrossCredit = openingCreditMinor + periodCreditMinor;
      const closing = netToSides(closingGrossDebit, closingGrossCredit);
      totalClosingDebit += closing.closingDebitMinor;
      totalClosingCredit += closing.closingCreditMinor;

      const acct: TbAccountRow = {
        id: String(row.id),
        code: String(row.code),
        name: String(row.name),
        accountType: String(row.accountType),
        normalBalance: row.normalBalance == null ? null : String(row.normalBalance),
        statementLine: row.statementLine == null ? null : String(row.statementLine),
        defaultVatCode: row.defaultVatCode == null ? null : String(row.defaultVatCode),
        openingDebitMinor,
        openingCreditMinor,
        periodDebitMinor,
        periodCreditMinor,
        ...closing,
      };
      accounts[acct.code] = acct;
      const g = acct.accountType;
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(acct);
    }

    const groups = GROUP_ORDER.filter((g) => (byGroup[g]?.length ?? 0) > 0).map((g) => {
      const items = byGroup[g]!;
      let subDebit = 0;
      let subCredit = 0;
      for (const a of items) {
        subDebit += a.closingDebitMinor;
        subCredit += a.closingCreditMinor;
      }
      return {
        key: g,
        label: GROUP_LABELS[g] || g,
        accounts: items,
        subtotalClosingDebitMinor: subDebit,
        subtotalClosingCreditMinor: subCredit,
      };
    });

    return {
      periodId,
      periodLabel: String(period.rows[0].label),
      periodStart,
      periodEnd,
      accounts,
      groups,
      totalClosingDebit,
      totalClosingCredit,
      /** @deprecated use totalClosingDebit — kept for older clients */
      totalDebit: totalClosingDebit,
      totalCredit: totalClosingCredit,
      balanced: totalClosingDebit === totalClosingCredit,
    };
  });
}

export async function booksAccountLedger(
  userId: string,
  clientId: string,
  periodId: string,
  accountId: string,
) {
  assertUuid(periodId, "invalid_period_id");
  assertUuid(accountId, "invalid_account_id");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const period = await db.query(
      `SELECT period_start, period_end, label FROM books_periods WHERE id = $1 AND client_id = $2`,
      [periodId, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    const periodEnd = String(period.rows[0].period_end);

    const acct = await db.query(
      `SELECT id, code, name, normal_balance AS "normalBalance"
       FROM books_accounts WHERE id = $1 AND client_id = $2`,
      [accountId, clientId],
    );
    if (!acct.rowCount) throw new BooksError("account_not_found", "not_found");

    const opening = await db.query(
      `SELECT COALESCE(SUM(l.debit_minor), 0)::bigint AS d, COALESCE(SUM(l.credit_minor), 0)::bigint AS c
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1 AND e.client_id = $2
         AND e.status IN ('posted', 'reversed')
         AND e.entry_date < $3::date`,
      [accountId, clientId, period.rows[0].period_start],
    );
    let runDebit = Number(opening.rows[0].d);
    let runCredit = Number(opening.rows[0].c);

    const lines = await db.query(
      `SELECT e.id AS "entryId", e.entry_no AS "entryNo", e.entry_date AS "entryDate",
              e.memo, l.debit_minor AS "debitMinor", l.credit_minor AS "creditMinor"
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1 AND e.client_id = $2
         AND e.status IN ('posted', 'reversed')
         AND e.entry_date >= $4::date
         AND e.entry_date <= $3::date
       ORDER BY e.entry_date ASC, e.created_at ASC, l.id ASC`,
      // Lines before the period are already in the opening — start the list at period start
      // (they were counted twice before; RPT-1 owner fix).
      [accountId, clientId, periodEnd, period.rows[0].period_start],
    );

    const normal = String(acct.rows[0].normalBalance || "debit");
    const mapped = lines.rows.map((row) => {
      runDebit += Number(row.debitMinor);
      runCredit += Number(row.creditMinor);
      const net = runDebit - runCredit;
      const balanceMinor =
        normal === "credit" ? runCredit - runDebit : runDebit - runCredit;
      return {
        entryId: String(row.entryId),
        entryNo: row.entryNo == null ? null : String(row.entryNo),
        entryDate: String(row.entryDate),
        memo: String(row.memo),
        debitMinor: Number(row.debitMinor),
        creditMinor: Number(row.creditMinor),
        balanceMinor,
        netDebitMinor: net >= 0 ? net : 0,
        netCreditMinor: net < 0 ? -net : 0,
      };
    });

    return {
      periodId,
      periodLabel: String(period.rows[0].label),
      account: {
        id: String(acct.rows[0].id),
        code: String(acct.rows[0].code),
        name: String(acct.rows[0].name),
        normalBalance: normal,
      },
      lines: mapped,
    };
  });
}
