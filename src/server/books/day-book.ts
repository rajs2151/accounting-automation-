/**
 * RPT-1: Day Book — every posted voucher in a date range (read-only).
 * Particulars = the party when the entry belongs to a document with a party (a reversal belongs to the
 * document it reverses), else the first line's account; the amount sits in Debit or Credit by that
 * line's side (Tally convention). Entries in date then creation order.
 */
import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export const DAY_BOOK_TYPES = [
  "Sales",
  "Purchase",
  "Receipt",
  "Payment",
  "Contra",
  "Journal",
  "Credit Note",
  "Debit Note",
  "Opening",
  "Closing",
  "Reversal",
] as const;
export type DayBookType = (typeof DAY_BOOK_TYPES)[number];

/** Voucher type label for a journal entry (reversals are their own type). */
export function dayBookType(voucherType: string | null | undefined, entryType?: string | null): DayBookType {
  if (entryType === "reversal") return "Reversal";
  const v = String(voucherType || "").trim();
  return (DAY_BOOK_TYPES as readonly string[]).includes(v) ? (v as DayBookType) : "Journal";
}

export type DayBookRow = {
  entryId: string;
  date: string;
  particulars: string;
  type: DayBookType;
  number: string | null;
  debitMinor: number;
  creditMinor: number;
  documentId: string | null;
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.from) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.to) || opts.from > opts.to) {
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
    type LineRow = { entry_id: string; debit_minor: string; credit_minor: string; name: string; is_ar: boolean; is_ap: boolean };
    const lines: { rows: LineRow[] } = ids.length
      ? await db.query<LineRow>(
          `SELECT l.entry_id, l.debit_minor, l.credit_minor, a.name, a.is_ar, a.is_ap
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
      const amount = ls.reduce((s, l) => s + Number(l.debit_minor), 0);
      // The party's own line (AR/AP control) decides the side when a party exists.
      const partyLine = e.party_name ? ls.find((l) => l.is_ar || l.is_ap) : undefined;
      const lead = partyLine || ls[0];
      const isDebit = lead ? Number(lead.debit_minor) > 0 : true;
      const row: DayBookRow = {
        entryId: String(e.id),
        date: iso(e.entry_date),
        particulars: String(e.party_name || lead?.name || e.memo || ""),
        type,
        number: e.entry_no ? String(e.entry_no) : null,
        debitMinor: isDebit ? amount : 0,
        creditMinor: isDebit ? 0 : amount,
        documentId: e.document_id ? String(e.document_id) : null,
      };
      totalDebitMinor += row.debitMinor;
      totalCreditMinor += row.creditMinor;
      rows.push(row);
    }
    return { from: opts.from, to: opts.to, rows, totalDebitMinor, totalCreditMinor };
  });
}
