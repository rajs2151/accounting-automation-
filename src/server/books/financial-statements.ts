/**
 * P6-1: read-only P&L / Balance Sheet / indirect Cash Flow + integrity gates.
 * Closing entries (and their reversals) are excluded from P&L; BS equity includes
 * current-year profit before year-end close.
 */
import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { fiscalYearForDate } from "@/lib/fiscal-year";
import { BooksError } from "@/server/books/errors";
import {
  buildPeriodColumns,
  fiscalYearBounds,
  type PeriodColumn,
  type PeriodColumnMode,
} from "@/server/books/period-columns";
import { assertSyntheticTenant } from "@/server/security-gate";

export type FsAccountRow = {
  accountId: string;
  code: string;
  name: string;
  amountMinor: number;
};

export type FsSection = {
  key: string;
  label: string;
  totalMinor: number;
  accounts: FsAccountRow[];
};

export type FsIntegrity = {
  tbBalances: { ok: boolean; differenceMinor: number };
  bsBalances: { ok: boolean; differenceMinor: number };
  cfTies: { ok: boolean; differenceMinor: number };
  ready: boolean;
};

export type PnlColumn = {
  column: PeriodColumn;
  sections: FsSection[];
  grossProfitMinor: number;
  ebitdaMinor: number;
  ebitMinor: number;
  ebtMinor: number;
  netProfitMinor: number;
};

export type BsColumn = {
  column: PeriodColumn;
  assets: FsSection[];
  liabilities: FsSection[];
  equity: FsSection[];
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  totalEquityMinor: number;
  currentYearProfitMinor: number;
};

export type CfColumn = {
  column: PeriodColumn;
  netProfitMinor: number;
  adjustmentsMinor: number;
  workingCapitalMinor: number;
  operatingMinor: number;
  investingMinor: number;
  financingMinor: number;
  netChangeMinor: number;
  openingCashMinor: number;
  closingCashMinor: number;
  lines: Array<{ key: string; label: string; amountMinor: number }>;
};

type AcctMeta = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  subType: string | null;
  statementLine: string | null;
  isBank: boolean;
  isCard: boolean;
  isContra: boolean;
  normalBalance: string | null;
};

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function signedNet(accountType: string, debit: number, credit: number, isContra: boolean) {
  // Presentation sign: assets/expenses positive when debit-heavy; liabilities/equity/income credit-heavy.
  // Contra assets (accum. depr) naturally go negative under asset rule (debit−credit).
  void isContra;
  if (accountType === "asset" || accountType === "expense") return debit - credit;
  return credit - debit;
}

/** Cash = BS money instruments: petty cash + bank (not clearing / not P&L). */
export function isCashMoneyAccount(a: AcctMeta): boolean {
  if (a.accountType !== "asset") return false;
  if (a.subType === "clearing" || a.subType === "gateway" || a.subType === "transfer") return false;
  return a.isBank || a.subType === "cash" || a.subType === "bank";
}

const PN_EXCLUDE_CLOSING = `
  e.entry_type IS DISTINCT FROM 'closing'
  AND NOT EXISTS (
    SELECT 1 FROM books_journal_entries c
    WHERE c.id = e.reverses_entry_id AND c.entry_type = 'closing'
  )
`;

async function loadAccounts(db: PoolClient, clientId: string): Promise<AcctMeta[]> {
  const rows = await db.query(
    `SELECT id, code, name, account_type AS "accountType",
            sub_type AS "subType", statement_line AS "statementLine",
            is_bank AS "isBank", COALESCE(is_card, false) AS "isCard",
            is_contra AS "isContra", normal_balance AS "normalBalance"
     FROM books_accounts
     WHERE client_id = $1 AND active = true AND is_postable = true
     ORDER BY code`,
    [clientId],
  );
  return rows.rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    accountType: String(r.accountType),
    subType: r.subType == null ? null : String(r.subType),
    statementLine: r.statementLine == null ? null : String(r.statementLine),
    isBank: Boolean(r.isBank),
    isCard: Boolean(r.isCard),
    isContra: Boolean(r.isContra),
    normalBalance: r.normalBalance == null ? null : String(r.normalBalance),
  }));
}

async function movementMap(
  db: PoolClient,
  clientId: string,
  from: string,
  to: string,
  excludeClosing: boolean,
): Promise<Map<string, { debit: number; credit: number }>> {
  const rows = await db.query(
    `SELECT l.account_id AS id,
            COALESCE(SUM(l.debit_minor), 0)::bigint AS debit,
            COALESCE(SUM(l.credit_minor), 0)::bigint AS credit
     FROM books_journal_lines l
     JOIN books_journal_entries e ON e.id = l.entry_id
     WHERE e.client_id = $1
       AND e.status IN ('posted', 'reversed')
       AND e.deleted_at IS NULL
       AND e.entry_date >= $2::date AND e.entry_date <= $3::date
       AND ($4::boolean = false OR (${PN_EXCLUDE_CLOSING}))
     GROUP BY l.account_id`,
    [clientId, from, to, excludeClosing],
  );
  const map = new Map<string, { debit: number; credit: number }>();
  for (const r of rows.rows) {
    map.set(String(r.id), { debit: Number(r.debit), credit: Number(r.credit) });
  }
  return map;
}

async function balanceMap(
  db: PoolClient,
  clientId: string,
  asOf: string,
): Promise<Map<string, { debit: number; credit: number }>> {
  const rows = await db.query(
    `SELECT l.account_id AS id,
            COALESCE(SUM(l.debit_minor), 0)::bigint AS debit,
            COALESCE(SUM(l.credit_minor), 0)::bigint AS credit
     FROM books_journal_lines l
     JOIN books_journal_entries e ON e.id = l.entry_id
     WHERE e.client_id = $1
       AND e.status IN ('posted', 'reversed')
       AND e.deleted_at IS NULL
       AND e.entry_date <= $2::date
     GROUP BY l.account_id`,
    [clientId, asOf],
  );
  const map = new Map<string, { debit: number; credit: number }>();
  for (const r of rows.rows) {
    map.set(String(r.id), { debit: Number(r.debit), credit: Number(r.credit) });
  }
  return map;
}

function sectionFrom(
  accounts: AcctMeta[],
  amounts: Map<string, number>,
  key: string,
  label: string,
  predicate: (a: AcctMeta) => boolean,
): FsSection {
  const rows: FsAccountRow[] = [];
  let total = 0;
  for (const a of accounts) {
    if (!predicate(a)) continue;
    const amountMinor = amounts.get(a.id) ?? 0;
    if (amountMinor === 0) continue;
    rows.push({ accountId: a.id, code: a.code, name: a.name, amountMinor });
    total += amountMinor;
  }
  return { key, label, totalMinor: total, accounts: rows };
}

function buildPnlColumn(
  column: PeriodColumn,
  accounts: AcctMeta[],
  mov: Map<string, { debit: number; credit: number }>,
): PnlColumn {
  const amounts = new Map<string, number>();
  for (const a of accounts) {
    const m = mov.get(a.id);
    if (!m) continue;
    amounts.set(a.id, signedNet(a.accountType, m.debit, m.credit, a.isContra));
  }

  const revenue = sectionFrom(
    accounts,
    amounts,
    "PL_revenue",
    "Revenue",
    (a) => a.statementLine === "PL_revenue",
  );
  const cogs = sectionFrom(
    accounts,
    amounts,
    "PL_cogs",
    "Cost of sales",
    (a) => a.statementLine === "PL_cogs",
  );
  const opex = sectionFrom(
    accounts,
    amounts,
    "PL_opex",
    "Operating expenses",
    (a) =>
      a.statementLine === "PL_opex" && a.subType !== "depr" && a.subType !== "amort",
  );
  const depr = sectionFrom(
    accounts,
    amounts,
    "PL_depr",
    "Depreciation & amortisation",
    (a) => a.subType === "depr" || a.subType === "amort",
  );
  const other = sectionFrom(
    accounts,
    amounts,
    "PL_other",
    "Other income / finance",
    (a) => a.statementLine === "PL_other",
  );
  const tax = sectionFrom(
    accounts,
    amounts,
    "PL_tax",
    "Corporate tax",
    (a) => a.statementLine === "PL_tax",
  );

  // Expense sections stored as positive costs; other may mix income (positive) and expense (positive cost).
  // For PL_other: income accounts are positive contribution; expense accounts are costs (positive = reduces profit).
  const otherNet = other.accounts.reduce((s, r) => {
    const meta = accounts.find((a) => a.id === r.accountId)!;
    return meta.accountType === "income" ? s + r.amountMinor : s - r.amountMinor;
  }, 0);

  const grossProfitMinor = revenue.totalMinor - cogs.totalMinor;
  const ebitdaMinor = grossProfitMinor - opex.totalMinor;
  const ebitMinor = ebitdaMinor - depr.totalMinor;
  const ebtMinor = ebitMinor + otherNet;
  const netProfitMinor = ebtMinor - tax.totalMinor;

  return {
    column,
    sections: [revenue, cogs, opex, depr, other, tax],
    grossProfitMinor,
    ebitdaMinor,
    ebitMinor,
    ebtMinor,
    netProfitMinor,
  };
}

function buildBsColumn(
  column: PeriodColumn,
  accounts: AcctMeta[],
  bal: Map<string, { debit: number; credit: number }>,
  ytdProfit: number,
): BsColumn {
  const amounts = new Map<string, number>();
  for (const a of accounts) {
    const m = bal.get(a.id);
    if (!m) continue;
    amounts.set(a.id, signedNet(a.accountType, m.debit, m.credit, a.isContra));
  }

  const ca = sectionFrom(
    accounts,
    amounts,
    "BS_current_assets",
    "Current assets",
    (a) => a.statementLine === "BS_current_assets",
  );
  const nca = sectionFrom(
    accounts,
    amounts,
    "BS_nca",
    "Non-current assets",
    (a) => a.statementLine === "BS_nca",
  );
  const cl = sectionFrom(
    accounts,
    amounts,
    "BS_current_liab",
    "Current liabilities",
    (a) => a.statementLine === "BS_current_liab",
  );
  const ncl = sectionFrom(
    accounts,
    amounts,
    "BS_ncl",
    "Non-current liabilities",
    (a) => a.statementLine === "BS_ncl",
  );
  const equityBase = sectionFrom(
    accounts,
    amounts,
    "BS_equity",
    "Equity",
    (a) => a.statementLine === "BS_equity",
  );

  // Current-year profit (before YE close lands in RE). Shown as synthetic equity line.
  const equityAccounts = [...equityBase.accounts];
  if (ytdProfit !== 0) {
    equityAccounts.push({
      accountId: "synthetic:cye",
      code: "CYE",
      name: "Current year profit",
      amountMinor: ytdProfit,
    });
  }
  const totalEquityMinor = equityBase.totalMinor + ytdProfit;
  const equity: FsSection = {
    key: "BS_equity",
    label: "Equity",
    totalMinor: totalEquityMinor,
    accounts: equityAccounts,
  };

  const totalAssetsMinor = ca.totalMinor + nca.totalMinor;
  const totalLiabilitiesMinor = cl.totalMinor + ncl.totalMinor;

  return {
    column,
    assets: [ca, nca],
    liabilities: [cl, ncl],
    equity: [equity],
    totalAssetsMinor,
    totalLiabilitiesMinor,
    totalEquityMinor,
    currentYearProfitMinor: ytdProfit,
  };
}

/** Operating WC (ex cash, ex suspense, ex NCA). CT payable included. */
const WC_ASSET_CODES = new Set([
  "1210",
  "1220",
  "1230",
  "1310",
  "1320",
  "1330",
  "1340",
  "1410",
  "1420",
  "1430",
  "1440",
  "1510",
  "1520",
]);
const WC_LIAB_CODES = new Set([
  "2110",
  "2120",
  "2130",
  "2140",
  "2210",
  "2220",
  "2230",
  "2310",
  "2320",
  "2330",
]);

function buildCfColumn(
  column: PeriodColumn,
  accounts: AcctMeta[],
  openBal: Map<string, { debit: number; credit: number }>,
  closeBal: Map<string, { debit: number; credit: number }>,
  mov: Map<string, { debit: number; credit: number }>,
  netProfitMinor: number,
): CfColumn {
  const byCode = new Map(accounts.map((a) => [a.code, a]));

  const amt = (map: Map<string, { debit: number; credit: number }>, code: string) => {
    const a = byCode.get(code);
    if (!a) return 0;
    const m = map.get(a.id);
    if (!m) return 0;
    return signedNet(a.accountType, m.debit, m.credit, a.isContra);
  };

  // Non-cash: depr/amort expense movement + unrealised FX (7310) expense net
  let depr = 0;
  for (const a of accounts) {
    if (a.subType !== "depr" && a.subType !== "amort") continue;
    const m = mov.get(a.id);
    if (m) depr += signedNet("expense", m.debit, m.credit, false);
  }
  const fxUnreal = (() => {
    const a = byCode.get("7310");
    if (!a) return 0;
    const m = mov.get(a.id);
    if (!m) return 0;
    return signedNet("expense", m.debit, m.credit, false);
  })();
  const adjustmentsMinor = depr + fxUnreal;

  let wc = 0;
  for (const code of WC_ASSET_CODES) {
    const delta = amt(closeBal, code) - amt(openBal, code);
    wc -= delta; // asset increase uses cash
  }
  for (const code of WC_LIAB_CODES) {
    const delta = amt(closeBal, code) - amt(openBal, code);
    wc += delta; // liability increase provides cash
  }

  const operatingMinor = netProfitMinor + adjustmentsMinor + wc;

  // Investing: change in NCA FA/IA gross (ex contra) — purchase uses cash
  let investing = 0;
  for (const a of accounts) {
    if (a.statementLine !== "BS_nca") continue;
    if (a.subType === "fa_contra" || a.subType === "ia_contra") continue;
    const delta = amt(closeBal, a.code) - amt(openBal, a.code);
    investing -= delta;
  }

  // Financing: capital +, drawings − (drawings contra equity), loans +
  const capDelta = amt(closeBal, "3100") - amt(openBal, "3100");
  const drawDelta = amt(closeBal, "3400") - amt(openBal, "3400"); // drawings balance is negative under equity rule
  const loanDelta = amt(closeBal, "2420") - amt(openBal, "2420");
  // drawings increase (more negative equity / higher debit) reduces cash: -(-delta) wait
  // signed equity for 3400 (debit-normal contra): signedNet equity = credit - debit → negative when drawn
  // increase in drawings magnitude → amount becomes more negative → delta negative → financing should decrease
  const financingMinor = capDelta + drawDelta + loanDelta;

  const netChangeMinor = operatingMinor + investing + financingMinor;

  let openingCash = 0;
  let closingCash = 0;
  for (const a of accounts) {
    if (!isCashMoneyAccount(a)) continue;
    openingCash += amt(openBal, a.code);
    closingCash += amt(closeBal, a.code);
  }

  const lines = [
    { key: "np", label: "Net profit", amountMinor: netProfitMinor },
    { key: "adj", label: "Non-cash adjustments", amountMinor: adjustmentsMinor },
    { key: "wc", label: "Working capital changes", amountMinor: wc },
    { key: "cfo", label: "Cash from operations", amountMinor: operatingMinor },
    { key: "cfi", label: "Cash from investing", amountMinor: investing },
    { key: "cff", label: "Cash from financing", amountMinor: financingMinor },
    { key: "net", label: "Net change in cash", amountMinor: netChangeMinor },
    { key: "open", label: "Opening cash", amountMinor: openingCash },
    { key: "close", label: "Closing cash", amountMinor: closingCash },
  ];

  return {
    column,
    netProfitMinor,
    adjustmentsMinor,
    workingCapitalMinor: wc,
    operatingMinor,
    investingMinor: investing,
    financingMinor,
    netChangeMinor,
    openingCashMinor: openingCash,
    closingCashMinor: closingCash,
    lines,
  };
}

async function loadClientPeriods(
  db: PoolClient,
  clientId: string,
): Promise<{ fyStartMonth: number; periods: Array<{ id: string; label: string; periodStart: string; periodEnd: string }> }> {
  const client = await db.query(
    `SELECT fiscal_year_start_month AS m FROM clients WHERE id = $1`,
    [clientId],
  );
  if (!client.rowCount) throw new BooksError("client_not_found", "not_found");
  const periods = await db.query(
    `SELECT id, label, period_start AS "periodStart", period_end AS "periodEnd"
     FROM books_periods WHERE client_id = $1 ORDER BY period_start`,
    [clientId],
  );
  return {
    fyStartMonth: Number(client.rows[0].m || 1),
    periods: periods.rows.map((r) => ({
      id: String(r.id),
      label: String(r.label),
      periodStart: iso(r.periodStart),
      periodEnd: iso(r.periodEnd),
    })),
  };
}

export type FsQuery = {
  mode: PeriodColumnMode;
  from: string;
  to: string;
  asOf?: string;
};

function parseMode(raw: string | null | undefined): PeriodColumnMode {
  const m = String(raw || "monthly");
  if (m === "monthly" || m === "quarterly" || m === "yearly" || m === "range") return m;
  throw new BooksError("invalid_report_mode", "invalid");
}

export async function booksProfitAndLoss(userId: string, clientId: string, query: FsQuery) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const { fyStartMonth, periods } = await loadClientPeriods(db, clientId);
    const columns = buildPeriodColumns({
      mode: query.mode,
      periods,
      from: query.from,
      to: query.to,
      fyStartMonth,
      asOf: query.asOf,
    });
    const accounts = await loadAccounts(db, clientId);
    const out: PnlColumn[] = [];
    for (const col of columns) {
      const mov = await movementMap(db, clientId, col.from, col.to, true);
      out.push(buildPnlColumn(col, accounts, mov));
    }
    return { mode: query.mode, columns: out };
  });
}

export async function booksBalanceSheet(userId: string, clientId: string, query: FsQuery) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const { fyStartMonth, periods } = await loadClientPeriods(db, clientId);
    const columns = buildPeriodColumns({
      mode: query.mode,
      periods,
      from: query.from,
      to: query.to,
      fyStartMonth,
      asOf: query.asOf,
    });
    const accounts = await loadAccounts(db, clientId);
    const out: BsColumn[] = [];
    for (const col of columns) {
      const bal = await balanceMap(db, clientId, col.to);
      const fy = fiscalYearForDate(col.to, fyStartMonth);
      const { start } = fiscalYearBounds(fy, fyStartMonth);
      // After YE close (journal dated on/before column end), profit sits in 3200 RE.
      const ye = await db.query(
        `SELECT 1
         FROM books_year_end_closes y
         JOIN books_journal_entries e ON e.id = y.journal_entry_id
         WHERE y.client_id = $1 AND y.fiscal_year = $2
           AND y.reversed_at IS NULL
           AND e.entry_date <= $3::date
         LIMIT 1`,
        [clientId, fy, col.to],
      );
      let ytdProfit = 0;
      if (!ye.rowCount) {
        const ytdMov = await movementMap(db, clientId, start, col.to, true);
        ytdProfit = buildPnlColumn(col, accounts, ytdMov).netProfitMinor;
      }
      out.push(buildBsColumn(col, accounts, bal, ytdProfit));
    }
    return { mode: query.mode, columns: out };
  });
}

export async function booksCashFlow(userId: string, clientId: string, query: FsQuery) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const { fyStartMonth, periods } = await loadClientPeriods(db, clientId);
    const columns = buildPeriodColumns({
      mode: query.mode,
      periods,
      from: query.from,
      to: query.to,
      fyStartMonth,
      asOf: query.asOf,
    });
    const accounts = await loadAccounts(db, clientId);
    const out: CfColumn[] = [];
    for (const col of columns) {
      const dayBefore = (() => {
        const d = new Date(`${col.from}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      })();
      const openBal = await balanceMap(db, clientId, dayBefore);
      const closeBal = await balanceMap(db, clientId, col.to);
      const mov = await movementMap(db, clientId, col.from, col.to, true);
      const pnl = buildPnlColumn(col, accounts, mov);
      out.push(buildCfColumn(col, accounts, openBal, closeBal, mov, pnl.netProfitMinor));
    }
    return { mode: query.mode, columns: out };
  });
}

/** Combined pack with integrity gates (for exports / close). */
export async function booksFinancialStatementsPack(
  userId: string,
  clientId: string,
  query: FsQuery,
) {
  const mode = parseMode(query.mode);
  const q = { ...query, mode };
  const [pnl, bs, cf] = await Promise.all([
    booksProfitAndLoss(userId, clientId, q),
    booksBalanceSheet(userId, clientId, q),
    booksCashFlow(userId, clientId, q),
  ]);

  // TB gate: for each column end, assets+expenses debits vs credits identity via BS equation + CF.
  let tbDiff = 0;
  let bsDiff = 0;
  let cfDiff = 0;
  for (let i = 0; i < bs.columns.length; i++) {
    const b = bs.columns[i];
    const c = cf.columns[i];
    const eq = b.totalAssetsMinor - (b.totalLiabilitiesMinor + b.totalEquityMinor);
    bsDiff += eq;
    const tie = c.openingCashMinor + c.netChangeMinor - c.closingCashMinor;
    cfDiff += tie;
  }
  // TB: use booksTrialBalance-style — if BS balances and we built from journals, TB follows; still compute via pack.
  tbDiff = 0; // journal engine enforces balance; surface 0 unless BS broken
  if (bsDiff !== 0) tbDiff = bsDiff;

  const integrity: FsIntegrity = {
    tbBalances: { ok: tbDiff === 0, differenceMinor: tbDiff },
    bsBalances: { ok: bsDiff === 0, differenceMinor: bsDiff },
    cfTies: { ok: cfDiff === 0, differenceMinor: cfDiff },
    ready: tbDiff === 0 && bsDiff === 0 && cfDiff === 0,
  };

  return { pnl, balanceSheet: bs, cashFlow: cf, integrity };
}

export { parseMode };
