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
  /**
   * PL_other only: signed contribution to profit (income positive, expense negative).
   * amountMinor keeps its natural sign (expense cost positive) for backward compatibility.
   */
  netMinor?: number;
};

export type FsSection = {
  key: string;
  label: string;
  /** Sum of account amounts in their natural sign (for PL_other this mixes income and cost). */
  totalMinor: number;
  /** PL_other only: signed net contribution to profit (= EBT − EBIT). */
  netMinor?: number;
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
  /** Profit of earlier fiscal years still in income/expense accounts (no posted year-end close). */
  priorYearsUnclosedProfitMinor: number;
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
  /** Revaluation of foreign-currency cash: moves the cash balance without any cash flow. */
  fxEffectOnCashMinor: number;
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
  cashFlowClass: string | null;
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

const isPnl = (a: AcctMeta) => a.accountType === "income" || a.accountType === "expense";
const isDepr = (a: AcctMeta) => a.accountType === "expense" && (a.subType === "depr" || a.subType === "amort");

/** P&L line for an account; accounts without one fall back by type so nothing drops out of profit. */
function plLine(a: AcctMeta): string {
  if (a.statementLine?.startsWith("PL_")) return a.statementLine;
  return a.accountType === "income" ? "PL_revenue" : "PL_opex";
}

/** Balance-sheet line; accounts without one fall back by type so the balance sheet always balances. */
function bsLine(a: AcctMeta): string {
  if (a.statementLine?.startsWith("BS_")) return a.statementLine;
  if (a.accountType === "asset") {
    return ["fa", "ia", "fa_contra", "ia_contra"].includes(a.subType || "") ? "BS_nca" : "BS_current_assets";
  }
  if (a.accountType === "liability") return "BS_current_liab";
  return "BS_equity";
}

/** Cash-flow bucket for a non-cash balance-sheet account (configured class, else by statement line). */
function cfClass(a: AcctMeta): "operating" | "investing" | "financing" {
  const c = a.cashFlowClass;
  if (c === "operating" || c === "investing" || c === "financing") return c;
  const line = bsLine(a);
  if (line === "BS_nca") return "investing";
  if (line === "BS_ncl" || line === "BS_equity") return "financing";
  return "operating";
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
            is_contra AS "isContra", normal_balance AS "normalBalance",
            cash_flow_class AS "cashFlowClass"
     FROM books_accounts
     -- Inactive accounts stay in: a deactivated account still has history in past periods.
     WHERE client_id = $1 AND is_postable = true
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
    cashFlowClass: r.cashFlowClass == null ? null : String(r.cashFlowClass),
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
    (a) => isPnl(a) && !isDepr(a) && plLine(a) === "PL_revenue",
  );
  const cogs = sectionFrom(
    accounts,
    amounts,
    "PL_cogs",
    "Cost of sales",
    (a) => isPnl(a) && !isDepr(a) && plLine(a) === "PL_cogs",
  );
  const opex = sectionFrom(
    accounts,
    amounts,
    "PL_opex",
    "Operating expenses",
    (a) => isPnl(a) && !isDepr(a) && plLine(a) === "PL_opex",
  );
  const depr = sectionFrom(
    accounts,
    amounts,
    "PL_depr",
    "Depreciation & amortisation",
    (a) => isDepr(a),
  );
  const other = sectionFrom(
    accounts,
    amounts,
    "PL_other",
    "Other income / finance",
    (a) => isPnl(a) && !isDepr(a) && plLine(a) === "PL_other",
  );
  const tax = sectionFrom(
    accounts,
    amounts,
    "PL_tax",
    "Corporate tax",
    (a) => isPnl(a) && !isDepr(a) && plLine(a) === "PL_tax",
  );

  // Expense sections stored as positive costs; other may mix income (positive) and expense (positive cost).
  // For PL_other: income accounts are positive contribution; expense accounts are costs (positive = reduces profit).
  const otherNet = other.accounts.reduce((s, r) => {
    const meta = accounts.find((a) => a.id === r.accountId)!;
    return meta.accountType === "income" ? s + r.amountMinor : s - r.amountMinor;
  }, 0);
  // Signed presentation of the mixed section: income adds to profit, expense takes away.
  for (const r of other.accounts) {
    const meta = accounts.find((a) => a.id === r.accountId)!;
    r.netMinor = meta.accountType === "income" ? r.amountMinor : -r.amountMinor;
  }
  other.netMinor = otherNet;

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
  priorUnclosedProfit = 0,
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
    (a) => !isPnl(a) && bsLine(a) === "BS_current_assets",
  );
  const nca = sectionFrom(
    accounts,
    amounts,
    "BS_nca",
    "Non-current assets",
    (a) => !isPnl(a) && bsLine(a) === "BS_nca",
  );
  const cl = sectionFrom(
    accounts,
    amounts,
    "BS_current_liab",
    "Current liabilities",
    (a) => !isPnl(a) && bsLine(a) === "BS_current_liab",
  );
  const ncl = sectionFrom(
    accounts,
    amounts,
    "BS_ncl",
    "Non-current liabilities",
    (a) => !isPnl(a) && bsLine(a) === "BS_ncl",
  );
  const equityBase = sectionFrom(
    accounts,
    amounts,
    "BS_equity",
    "Equity",
    (a) => !isPnl(a) && bsLine(a) === "BS_equity",
  );

  // Current-year profit (before YE close lands in RE). Shown as synthetic equity line.
  const equityAccounts = [...equityBase.accounts];
  if (priorUnclosedProfit !== 0) {
    equityAccounts.push({
      accountId: "synthetic:pye",
      code: "PYE",
      name: "Prior years' profit not yet closed",
      amountMinor: priorUnclosedProfit,
    });
  }
  if (ytdProfit !== 0) {
    equityAccounts.push({
      accountId: "synthetic:cye",
      code: "CYE",
      name: "Current year profit",
      amountMinor: ytdProfit,
    });
  }
  const totalEquityMinor = equityBase.totalMinor + ytdProfit + priorUnclosedProfit;
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
    priorYearsUnclosedProfitMinor: priorUnclosedProfit,
  };
}

/**
 * Indirect cash flow that ties by construction. Every non-cash balance-sheet account belongs to exactly
 * one bucket (operating / investing / financing — its cash_flow_class, else by statement line), and all
 * movements come from the same journal lines as net profit (closing entries excluded on both sides), so
 * net change + FX effect = closing − opening cash. Presentation adjustments:
 *  - depreciation / amortisation and loss on disposal (7500) are added back in operating and taken out
 *    of investing (they are the non-cash part of the fixed-asset movement);
 *  - FX revaluation posted against cash accounts is shown as "effect of exchange rates on cash" and its
 *    7310 gain/loss removed from operating; revaluation of receivables/payables nets out in working capital.
 */
function buildCfColumn(
  column: PeriodColumn,
  accounts: AcctMeta[],
  openBal: Map<string, { debit: number; credit: number }>,
  closeBal: Map<string, { debit: number; credit: number }>,
  mov: Map<string, { debit: number; credit: number }>,
  netProfitMinor: number,
  fxEffectOnCashMinor: number,
): CfColumn {
  const drCr = (map: Map<string, { debit: number; credit: number }>, a: AcctMeta) => {
    const m = map.get(a.id);
    return m ? m.debit - m.credit : 0;
  };

  let depr = 0;
  let disposalLoss = 0;
  const bucket = { operating: 0, investing: 0, financing: 0 };
  let openingCash = 0;
  let closingCash = 0;
  for (const a of accounts) {
    if (isPnl(a)) {
      if (isDepr(a)) depr += drCr(mov, a);
      if (a.code === "7500") disposalLoss += drCr(mov, a);
      continue;
    }
    if (isCashMoneyAccount(a)) {
      openingCash += drCr(openBal, a);
      closingCash += drCr(closeBal, a);
      continue;
    }
    // An increase in a non-cash asset (debit) uses cash; an increase in a liability/equity provides it.
    bucket[cfClass(a)] -= drCr(mov, a);
  }

  const adjustmentsMinor = depr + disposalLoss - fxEffectOnCashMinor;
  const wc = bucket.operating;
  const operatingMinor = netProfitMinor + adjustmentsMinor + wc;
  const investing = bucket.investing - depr - disposalLoss;
  const financingMinor = bucket.financing;
  const netChangeMinor = operatingMinor + investing + financingMinor;

  const lines = [
    { key: "np", label: "Net profit", amountMinor: netProfitMinor },
    { key: "adj", label: "Non-cash adjustments", amountMinor: adjustmentsMinor },
    { key: "wc", label: "Working capital changes", amountMinor: wc },
    { key: "cfo", label: "Cash from operations", amountMinor: operatingMinor },
    { key: "cfi", label: "Cash from investing", amountMinor: investing },
    { key: "cff", label: "Cash from financing", amountMinor: financingMinor },
    { key: "net", label: "Net change in cash", amountMinor: netChangeMinor },
    { key: "fx", label: "Effect of exchange rates on cash", amountMinor: fxEffectOnCashMinor },
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
    fxEffectOnCashMinor,
    openingCashMinor: openingCash,
    closingCashMinor: closingCash,
    lines,
  };
}

/** Cash-account movement from FX revaluation entries (and their reversals, and manual 7310 entries) in the range. */
async function fxEffectOnCash(db: PoolClient, clientId: string, from: string, to: string, cashIds: string[]) {
  if (!cashIds.length) return 0;
  const r = await db.query(
    `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::bigint AS net
     FROM books_journal_lines l
     JOIN books_journal_entries e ON e.id = l.entry_id
     JOIN books_journal_entries be ON be.id = COALESCE(e.reverses_entry_id, e.id)
     WHERE e.client_id = $1 AND e.status IN ('posted', 'reversed') AND e.deleted_at IS NULL
       AND e.entry_date >= $2::date AND e.entry_date <= $3::date
       -- Revaluation runs, and any manual entry booking unrealised FX (7310) against cash.
       AND (be.entry_type = 'fx_revaluation' OR EXISTS (
             SELECT 1 FROM books_journal_lines x JOIN books_accounts xa ON xa.id = x.account_id
             WHERE x.entry_id = e.id AND xa.code = '7310'))
       AND l.account_id = ANY($4::uuid[])`,
    [clientId, from, to, cashIds],
  );
  return Number(r.rows[0].net);
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
      // Unclosed profit = what still sits in income/expense accounts as of the column end (a posted
      // year-end close has moved it to retained earnings; a draft, deleted or reversed one has not).
      // Split for presentation: this fiscal year's part, and older years never closed.
      const pnlNet = (m: Map<string, { debit: number; credit: number }>) =>
        accounts.filter(isPnl).reduce((sum, acct) => {
          const x = m.get(acct.id);
          return x ? sum + (x.credit - x.debit) : sum;
        }, 0);
      const unclosedTotal = pnlNet(bal);
      const ytdProfit = pnlNet(await movementMap(db, clientId, start, col.to, false));
      const priorUnclosed = unclosedTotal - ytdProfit;
      out.push(buildBsColumn(col, accounts, bal, ytdProfit, priorUnclosed));
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
      const fx = await fxEffectOnCash(
        db,
        clientId,
        col.from,
        col.to,
        accounts.filter(isCashMoneyAccount).map((a) => a.id),
      );
      out.push(buildCfColumn(col, accounts, openBal, closeBal, mov, pnl.netProfitMinor, fx));
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

  // Every column must be right on its own: add absolute differences so errors can't cancel out.
  let bsDiff = 0;
  let cfDiff = 0;
  for (let i = 0; i < bs.columns.length; i++) {
    const b = bs.columns[i];
    const c = cf.columns[i];
    bsDiff += Math.abs(b.totalAssetsMinor - (b.totalLiabilitiesMinor + b.totalEquityMinor));
    cfDiff += Math.abs(c.openingCashMinor + c.netChangeMinor + c.fxEffectOnCashMinor - c.closingCashMinor);
  }
  // Trial balance: total debits = total credits of everything posted up to the last column end.
  const lastTo = bs.columns.reduce((m, c) => (c.column.to > m ? c.column.to : m), q.to);
  const tbDiff = await withUser(userId, async (db) => {
    const r = await db.query(
      `SELECT COALESCE(SUM(l.debit_minor), 0)::bigint - COALESCE(SUM(l.credit_minor), 0)::bigint AS diff
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE e.client_id = $1 AND e.status IN ('posted', 'reversed') AND e.deleted_at IS NULL
         AND e.entry_date <= $2::date`,
      [clientId, lastTo],
    );
    return Math.abs(Number(r.rows[0].diff));
  });

  const integrity: FsIntegrity = {
    tbBalances: { ok: tbDiff === 0, differenceMinor: tbDiff },
    bsBalances: { ok: bsDiff === 0, differenceMinor: bsDiff },
    cfTies: { ok: cfDiff === 0, differenceMinor: cfDiff },
    ready: tbDiff === 0 && bsDiff === 0 && cfDiff === 0,
  };

  return { pnl, balanceSheet: bs, cashFlow: cf, integrity };
}

export { parseMode };
