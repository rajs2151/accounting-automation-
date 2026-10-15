/**
 * RPT-1: Account Ledger report (read-only) + journal entry → source document lookup.
 *
 * Opening = posted lines before the period start; lines = posted lines inside the period; Closing =
 * Opening + Current total. Same filters as booksTrialBalance (status posted|reversed, not deleted),
 * so Closing equals the TB closing for the account. (booksAccountLedger in trial-balance.ts was fixed
 * in RPT-1 to stop listing pre-period lines on top of its opening; both now agree.)
 */
import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { assertUuid, isIsoDate } from "@/server/books/periods";
import { assertSyntheticTenant } from "@/server/security-gate";

function iso(v: unknown): string {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
}

export type LedgerReportLine = {
  entryId: string;
  entryNo: string | null;
  date: string;
  memo: string;
  debitMinor: number;
  creditMinor: number;
  /** Running balance in the account's normal direction (credit accounts: credit − debit). */
  balanceMinor: number;
};

export type LedgerReport = {
  account: { id: string; code: string; name: string; normalBalance: "debit" | "credit" };
  period: { id: string; label: string; start: string; end: string };
  opening: { debitMinor: number; creditMinor: number; balanceMinor: number };
  lines: LedgerReportLine[];
  currentTotal: { debitMinor: number; creditMinor: number };
  closing: { debitMinor: number; creditMinor: number; balanceMinor: number };
};

export async function booksLedgerReport(
  userId: string,
  clientId: string,
  opts: { periodId: string; accountId: string },
): Promise<LedgerReport> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const p = await db.query(
      `SELECT id, label, period_start, period_end FROM books_periods WHERE id = $1 AND client_id = $2`,
      [opts.periodId, clientId],
    );
    if (!p.rowCount) throw new BooksError("period_not_found", "not_found");
    const a = await db.query(
      `SELECT id, code, name, normal_balance FROM books_accounts WHERE id = $1 AND client_id = $2`,
      [opts.accountId, clientId],
    );
    if (!a.rowCount) throw new BooksError("account_not_found", "not_found");
    const start = iso(p.rows[0].period_start);
    const end = iso(p.rows[0].period_end);
    const normal: "debit" | "credit" = a.rows[0].normal_balance === "credit" ? "credit" : "debit";
    const signed = (d: number, c: number) => (normal === "credit" ? c - d : d - c);

    const opening = await db.query(
      `SELECT COALESCE(SUM(l.debit_minor), 0)::bigint AS d, COALESCE(SUM(l.credit_minor), 0)::bigint AS c
       FROM books_journal_lines l JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1 AND e.client_id = $2 AND e.status IN ('posted', 'reversed')
         AND e.deleted_at IS NULL AND e.entry_date < $3::date`,
      [opts.accountId, clientId, start],
    );
    const oD = Number(opening.rows[0].d);
    const oC = Number(opening.rows[0].c);
    const rows = await db.query(
      `SELECT e.id, e.entry_no, e.entry_date, e.memo, l.debit_minor, l.credit_minor
       FROM books_journal_lines l JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1 AND e.client_id = $2 AND e.status IN ('posted', 'reversed')
         AND e.deleted_at IS NULL AND e.entry_date >= $3::date AND e.entry_date <= $4::date
       ORDER BY e.entry_date, e.created_at, l.id`,
      [opts.accountId, clientId, start, end],
    );
    let run = signed(oD, oC);
    let tD = 0;
    let tC = 0;
    const lines: LedgerReportLine[] = rows.rows.map((r) => {
      const d = Number(r.debit_minor);
      const c = Number(r.credit_minor);
      tD += d;
      tC += c;
      run += signed(d, c);
      return {
        entryId: String(r.id),
        entryNo: r.entry_no ? String(r.entry_no) : null,
        date: iso(r.entry_date),
        memo: String(r.memo || ""),
        debitMinor: d,
        creditMinor: c,
        balanceMinor: run,
      };
    });
    return {
      account: {
        id: String(a.rows[0].id),
        code: String(a.rows[0].code),
        name: String(a.rows[0].name),
        normalBalance: normal,
      },
      period: { id: String(p.rows[0].id), label: String(p.rows[0].label), start, end },
      opening: { debitMinor: oD, creditMinor: oC, balanceMinor: signed(oD, oC) },
      lines,
      currentTotal: { debitMinor: tD, creditMinor: tC },
      closing: { debitMinor: oD + tD, creditMinor: oC + tC, balanceMinor: signed(oD + tD, oC + tC) },
    };
  });
}

/**
 * Posted lines for one account in a date range (FS drill-down).
 *
 * P&L accounts (income / expense): movement in the range, closing entries and their reversals
 * excluded — the same lines the P&L cell sums.
 * Balance-sheet accounts (asset / liability / equity): the cell is a balance, so the drill also
 * returns the opening balance (everything posted before `from`) and keeps closing entries (retained
 * earnings is built from them); opening + lines = the balance-sheet cell.
 *
 * amountMinor / openingMinor are debit − credit. `sign` turns them into the statement's presentation
 * (+1 for assets / expenses, −1 for liabilities / equity / income); totalMinor is already presented.
 */
export async function booksAccountLinesInRange(
  userId: string,
  clientId: string,
  opts: { accountId: string; from: string; to: string },
): Promise<{
  account: { id: string; code: string; name: string; accountType: string };
  statement: "pnl" | "bs";
  from: string;
  to: string;
  sign: 1 | -1;
  /** BS only: balance (debit − credit) at the day before `from`; 0 for P&L. */
  openingMinor: number;
  /** Presented total of the drill (BS: opening + lines = the balance-sheet cell). */
  totalMinor: number;
  lines: Array<{
    entryId: string;
    entryNo: string | null;
    date: string;
    memo: string;
    debitMinor: number;
    creditMinor: number;
    amountMinor: number;
  }>;
}> {
  // Synthetic presentation lines ("synthetic:pye") and junk never reach Postgres as a uuid.
  assertUuid(opts.accountId, "invalid_account_id");
  if (!isIsoDate(opts.from) || !isIsoDate(opts.to)) throw new BooksError("invalid_date", "invalid");
  if (opts.from > opts.to) throw new BooksError("invalid_date_range", "invalid");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const a = await db.query(
      `SELECT id, code, name, account_type FROM books_accounts WHERE id = $1 AND client_id = $2`,
      [opts.accountId, clientId],
    );
    if (!a.rowCount) throw new BooksError("account_not_found", "not_found");
    const accountType = String(a.rows[0].account_type);
    const statement: "pnl" | "bs" =
      accountType === "income" || accountType === "expense" ? "pnl" : "bs";
    const sign: 1 | -1 = accountType === "asset" || accountType === "expense" ? 1 : -1;
    const excludeClosing = statement === "pnl";
    const rows = await db.query(
      `SELECT e.id, e.entry_no, e.entry_date, e.memo, l.debit_minor, l.credit_minor
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1 AND e.client_id = $2
         AND e.status IN ('posted', 'reversed')
         AND e.deleted_at IS NULL
         AND e.entry_date >= $3::date AND e.entry_date <= $4::date
         AND ($5::boolean = false OR (
           e.entry_type IS DISTINCT FROM 'closing'
           AND NOT EXISTS (
             SELECT 1 FROM books_journal_entries c
             WHERE c.id = e.reverses_entry_id AND c.entry_type = 'closing'
           )
         ))
       ORDER BY e.entry_date, e.created_at, l.id`,
      [opts.accountId, clientId, opts.from, opts.to, excludeClosing],
    );
    let openingMinor = 0;
    if (statement === "bs") {
      const o = await db.query(
        `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::bigint AS net
         FROM books_journal_lines l
         JOIN books_journal_entries e ON e.id = l.entry_id
         WHERE l.account_id = $1 AND e.client_id = $2
           AND e.status IN ('posted', 'reversed')
           AND e.deleted_at IS NULL
           AND e.entry_date < $3::date`,
        [opts.accountId, clientId, opts.from],
      );
      openingMinor = Number(o.rows[0].net);
    }
    const lines = rows.rows.map((r) => {
      const debitMinor = Number(r.debit_minor);
      const creditMinor = Number(r.credit_minor);
      return {
        entryId: String(r.id),
        entryNo: r.entry_no ? String(r.entry_no) : null,
        date: iso(r.entry_date),
        memo: String(r.memo || ""),
        debitMinor,
        creditMinor,
        amountMinor: debitMinor - creditMinor,
      };
    });
    const net = openingMinor + lines.reduce((s, l) => s + l.amountMinor, 0);
    return {
      account: {
        id: String(a.rows[0].id),
        code: String(a.rows[0].code),
        name: String(a.rows[0].name),
        accountType,
      },
      statement,
      from: opts.from,
      to: opts.to,
      sign,
      openingMinor,
      totalMinor: sign * net,
      lines,
    };
  });
}

export type EntrySource = {
  documentId: string;
  docType: string;
  documentNumber: string | null;
  partyName: string | null;
  issueDate: string | null;
  grossMinor: number;
  status: string;
  /** Inbox review page id when the document came from an upload (highlights live there). */
  inboxItemId: string | null;
};

/** Source document of a posted entry (a reversal resolves to the document it reverses), or null. */
export async function booksEntrySource(
  userId: string,
  clientId: string,
  entryId: string,
): Promise<{ entryId: string; source: EntrySource | null }> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const e = await db.query(
      `SELECT id, reverses_entry_id FROM books_journal_entries WHERE id = $1 AND client_id = $2`,
      [entryId, clientId],
    );
    if (!e.rowCount) throw new BooksError("journal_not_found", "not_found");
    const base = String(e.rows[0].reverses_entry_id || e.rows[0].id);
    const d = await db.query(
      `SELECT d.id, d.doc_type, d.document_number, d.issue_date, d.gross_minor, d.status,
              p.name AS party_name, x.inbox_item_id
       FROM books_documents d
       LEFT JOIN books_parties p ON p.id = d.party_id
       LEFT JOIN books_extractions x ON x.id = d.extraction_id
       WHERE d.journal_entry_id = $1 AND d.client_id = $2 AND d.deleted_at IS NULL
       ORDER BY d.created_at LIMIT 1`,
      [base, clientId],
    );
    if (!d.rowCount) return { entryId, source: null };
    const r = d.rows[0];
    return {
      entryId,
      source: {
        documentId: String(r.id),
        docType: String(r.doc_type),
        documentNumber: r.document_number ? String(r.document_number) : null,
        partyName: r.party_name ? String(r.party_name) : null,
        issueDate: r.issue_date ? iso(r.issue_date) : null,
        grossMinor: Number(r.gross_minor),
        status: String(r.status),
        inboxItemId: r.inbox_item_id ? String(r.inbox_item_id) : null,
      },
    };
  });
}
