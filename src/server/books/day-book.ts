/**
 * RPT-1: Day Book — every posted voucher in a date range (read-only).
 * Each voucher row carries its own debit and credit totals (equal for a balanced voucher), so the
 * column totals of the book agree; the voucher's lines come along for expanding the row.
 * Particulars = the party when the entry belongs to a document with a party (a reversal belongs to
 * the document it reverses), else the first line's account. `partySide` says whether the party was
 * debited or credited: its AR/AP control line, else its advance line (2320 customer / 1410 supplier
 * advances). Entries in date then creation order.
 */
import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { isIsoDate } from "@/server/books/periods";
import { VOUCHER_TYPES } from "@/server/books/vouchers";
import { assertSyntheticTenant } from "@/server/security-gate";

/** Every voucher type a journal can carry (vouchers.ts), plus reversals as their own type. */
export const DAY_BOOK_TYPES = [...VOUCHER_TYPES, "Reversal"] as const;
export type DayBookType = (typeof DAY_BOOK_TYPES)[number];

/** Voucher type label for a journal entry (reversals are their own type). */
export function dayBookType(voucherType: string | null | undefined, entryType?: string | null): DayBookType {
  if (entryType === "reversal") return "Reversal";
  const v = String(voucherType || "").trim();
  return (DAY_BOOK_TYPES as readonly string[]).includes(v) ? (v as DayBookType) : "Journal";
}

/** Party advance accounts (settlements.ts): customer advances received / supplier advances paid. */
const PARTY_ADVANCE_CODES = new Set(["2320", "1410"]);

export type DayBookLine = {
  accountCode: string;
  accountName: string;
  debitMinor: number;
  creditMinor: number;
};

export type DayBookRow = {
  entryId: string;
  date: string;
  particulars: string;
  /** The document's party, when there is one. */
  party: string | null;
  /** Whether the party was debited ("Dr") or credited ("Cr"); null without a party line. */
  partySide: "Dr" | "Cr" | null;
  type: DayBookType;
  number: string | null;
  /** Voucher totals: sum of the debit lines and of the credit lines (equal when balanced). */
  debitMinor: number;
  creditMinor: number;
  documentId: string | null;
  lines: DayBookLine[];
};

function iso(v: unknown): string {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
}

export async function booksDayBook(
  userId: string,
  clientId: string,
  opts: { from: string; to: string; type?: string | null },
): Promise<{ from: string; to: string; rows: DayBookRow[]; totalDebitMinor: number; totalCreditMinor: number }> {
  if (!isIsoDate(opts.from) || !isIsoDate(opts.to) || opts.from > opts.to) {
    throw new BooksError("invalid_date_range", "invalid");
  }
  if (opts.type && !(DAY_BOOK_TYPES as readonly string[]).includes(opts.type)) {
    throw new BooksError("invalid_day_book_type", "invalid");
  }
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const entries = await db.query(
      `SELECT e.id, e.entry_date, e.entry_no, e.voucher_type, e.entry_type, e.memo,
              d.id AS document_id, p.name AS party_name
       FROM books_journal_entries e
       LEFT JOIN LATERAL (
         SELECT id, party_id FROM books_documents
         -- A reversal (void) belongs to the document of the entry it reverses.
         WHERE journal_entry_id = COALESCE(e.reverses_entry_id, e.id) AND client_id = e.client_id
           AND deleted_at IS NULL
         ORDER BY created_at LIMIT 1
       ) d ON true
       LEFT JOIN books_parties p ON p.id = d.party_id
       WHERE e.client_id = $1 AND e.status IN ('posted', 'reversed') AND e.deleted_at IS NULL
         AND e.entry_date BETWEEN $2::date AND $3::date
       ORDER BY e.entry_date, e.created_at, e.entry_no`,
      [clientId, opts.from, opts.to],
    );
    const ids = entries.rows.map((r) => String(r.id));
    type LineRow = {
      entry_id: string;
      debit_minor: string;
      credit_minor: string;
      code: string;
      name: string;
      is_ar: boolean;
      is_ap: boolean;
    };
    const lines: { rows: LineRow[] } = ids.length
      ? await db.query<LineRow>(
          `SELECT l.entry_id, l.debit_minor, l.credit_minor, a.code, a.name, a.is_ar, a.is_ap
           FROM books_journal_lines l JOIN books_accounts a ON a.id = l.account_id
           WHERE l.entry_id = ANY($1::uuid[])
           ORDER BY l.entry_id, l.debit_minor DESC, l.id`,
          [ids],
        )
      : { rows: [] };
    const byEntry = new Map<string, LineRow[]>();
    for (const l of lines.rows) {
      const k = String(l.entry_id);
      if (!byEntry.has(k)) byEntry.set(k, []);
      byEntry.get(k)!.push(l);
    }

    const rows: DayBookRow[] = [];
    let totalDebitMinor = 0;
    let totalCreditMinor = 0;
    for (const e of entries.rows) {
      const type = dayBookType(e.voucher_type as string | null, e.entry_type as string | null);
      if (opts.type && type !== opts.type) continue;
      const ls = byEntry.get(String(e.id)) || [];
      const debitMinor = ls.reduce((sum, l) => sum + Number(l.debit_minor), 0);
      const creditMinor = ls.reduce((sum, l) => sum + Number(l.credit_minor), 0);
      // The party's own line decides its side: AR/AP control first, else its advance account.
      const partyLine = e.party_name
        ? ls.find((l) => l.is_ar || l.is_ap) || ls.find((l) => PARTY_ADVANCE_CODES.has(String(l.code)))
        : undefined;
      const lead = ls[0];
      const memo = e.memo ? String(e.memo).trim() : "";
      const entryNo = e.entry_no ? String(e.entry_no) : "";
      // Prefer memo, then party, then lead account; voucher number last.
      const particulars =
        memo ||
        (e.party_name ? String(e.party_name) : "") ||
        (lead?.name ? String(lead.name) : "") ||
        entryNo ||
        "";
      const row: DayBookRow = {
        entryId: String(e.id),
        date: iso(e.entry_date),
        particulars,
        party: e.party_name ? String(e.party_name) : null,
        partySide: partyLine ? (Number(partyLine.debit_minor) > 0 ? "Dr" : "Cr") : null,
        type,
        number: entryNo || null,
        debitMinor,
        creditMinor,
        documentId: e.document_id ? String(e.document_id) : null,
        lines: ls.map((l) => ({
          accountCode: String(l.code),
          accountName: String(l.name),
          debitMinor: Number(l.debit_minor),
          creditMinor: Number(l.credit_minor),
        })),
      };
      totalDebitMinor += row.debitMinor;
      totalCreditMinor += row.creditMinor;
      rows.push(row);
    }
    return { from: opts.from, to: opts.to, rows, totalDebitMinor, totalCreditMinor };
  });
}
