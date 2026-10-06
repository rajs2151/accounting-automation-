/**
 * RPT-1: AP / AR ageing as of a date (read-only).
 *
 * Items: posted sales invoices (AR) / purchase bills (AP) from books_open_items, with the pending amount
 * rebuilt as of the date — original AED less allocations and credit/debit notes dated on or before it —
 * so a back-dated report is right even after later payments.
 * Credits: unapplied on-account / advance money shown as its own negative rows — read from posted
 * receipt / payment journals (customer: credit on 2320 Customer advances; supplier: debit on 1410 Prepaid),
 * so receipts posted from a bank line (stream A, db/38) and receipts keyed in directly are both covered,
 * each once. Kind comes from the line memo stream A writes ("On account …" vs advance). Customer credits
 * are reduced oldest-first by "Advance allocation" applications dated on or before the as-of date;
 * supplier credits have no apply flow yet. No VAT logic (VAT on advances: owner decision pending).
 * Due date: the document's, else issue date + the party's payment terms.
 */
import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export const AGEING_BUCKETS = ["not_due", "0-30", "31-60", "61-90", "90+"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

function dayNumber(isoDate: string) {
  return Math.round(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / 86400000);
}

/** Days past due as of a date (negative = not yet due). */
export function overdueDays(asOf: string, dueDate: string) {
  return dayNumber(asOf) - dayNumber(dueDate);
}

/** Not due (due later than as-of) · 0-30 (due today up to 30 days late) · 31-60 · 61-90 · 90+. */
export function ageingBucket(days: number): AgeingBucket {
  if (days < 0) return "not_due";
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export type AgeingRow = {
  kind: "item" | "on_account" | "advance";
  date: string;
  ref: string;
  partyId: string;
  partyName: string;
  /** AED fils; items positive, unapplied credits negative. */
  pendingMinor: number;
  dueDate: string | null;
  overdueDays: number;
  bucket: AgeingBucket;
  documentId: string | null;
  journalEntryId: string | null;
};

type BucketTotals = Record<AgeingBucket, number> & { total: number };

function emptyTotals(): BucketTotals {
  return { not_due: 0, "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0, total: 0 };
}

export type AgeingReport = {
  side: "AR" | "AP";
  asOf: string;
  rows: AgeingRow[];
  parties: Array<{ partyId: string; partyName: string; totals: BucketTotals }>;
  totals: BucketTotals;
};

function iso(v: unknown): string {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
}

export async function booksAgeing(
  userId: string,
  clientId: string,
  opts: { side: "AR" | "AP"; asOf: string },
): Promise<AgeingReport> {
  const side = opts.side;
  if (side !== "AR" && side !== "AP") throw new BooksError("invalid_side", "invalid");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.asOf)) throw new BooksError("invalid_date", "invalid");
  const asOf = opts.asOf;

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows: AgeingRow[] = [];

    const items = await db.query(
      `SELECT oi.id, oi.party_id, p.name AS party_name, oi.aed_original_minor,
              d.id AS document_id, d.document_number, d.issue_date, d.journal_entry_id,
              COALESCE(d.due_date, d.issue_date + p.payment_terms_days) AS due_date,
              e.entry_no,
              COALESCE((
                SELECT SUM(a.allocated_aed_minor) FROM books_allocations a
                JOIN books_documents s ON s.id = a.settlement_document_id
                WHERE a.open_item_id = oi.id AND s.status = 'posted' AND s.deleted_at IS NULL
                  AND s.issue_date <= $3::date
              ), 0)::bigint AS allocated,
              COALESCE((
                SELECT SUM(n.aed_total_minor) FROM books_documents n
                WHERE n.original_document_id = d.id AND n.client_id = $1 AND n.status = 'posted'
                  AND n.deleted_at IS NULL AND n.doc_type IN ('credit_note', 'debit_note')
                  AND n.issue_date <= $3::date
              ), 0)::bigint AS noted
       FROM books_open_items oi
       JOIN books_documents d ON d.id = oi.document_id
       JOIN books_parties p ON p.id = oi.party_id
       JOIN books_journal_entries e ON e.id = d.journal_entry_id
       WHERE oi.client_id = $1 AND oi.side = $2 AND d.status = 'posted' AND d.deleted_at IS NULL
         AND e.status = 'posted' AND d.issue_date <= $3::date`,
      [clientId, side, asOf],
    );
    for (const r of items.rows) {
      const pending = Number(r.aed_original_minor) - Number(r.allocated) - Number(r.noted);
      if (pending <= 0) continue;
      const date = iso(r.issue_date);
      const due = r.due_date ? iso(r.due_date) : date;
      const days = overdueDays(asOf, due);
      rows.push({
        kind: "item",
        date,
        ref: String(r.document_number || r.entry_no || String(r.document_id).slice(0, 8)),
        partyId: String(r.party_id),
        partyName: String(r.party_name),
        pendingMinor: pending,
        dueDate: due,
        overdueDays: days,
        bucket: ageingBucket(days),
        documentId: String(r.document_id),
        journalEntryId: String(r.journal_entry_id),
      });
    }

    // Unapplied on-account / advance money from posted receipt (AR) / payment (AP) journals.
    const credits = await db.query(
      `SELECT l.id, d.party_id, p.name AS party_name, e.entry_date, e.entry_no, e.id AS journal_entry_id,
              d.id AS settlement_document_id, l.line_memo,
              (CASE WHEN $2 = 'AR' THEN l.credit_minor - l.debit_minor
                    ELSE l.debit_minor - l.credit_minor END)::bigint AS aed
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_accounts a ON a.id = l.account_id
       JOIN books_documents d ON d.journal_entry_id = e.id AND d.client_id = e.client_id
       JOIN books_parties p ON p.id = d.party_id
       WHERE e.client_id = $1 AND e.status = 'posted' AND e.deleted_at IS NULL
         AND e.entry_date <= $3::date
         AND d.status = 'posted' AND d.deleted_at IS NULL
         AND d.doc_type = CASE WHEN $2 = 'AR' THEN 'receipt' ELSE 'payment' END
         AND COALESCE(d.memo, '') <> 'Advance allocation'
         AND a.code = CASE WHEN $2 = 'AR' THEN '2320' ELSE '1410' END
       ORDER BY e.entry_date, e.created_at, l.id`,
      [clientId, side, asOf],
    );
    const creditRows = credits.rows
      .map((r) => ({ r, aed: Number(r.aed) }))
      .filter((c) => c.aed > 0);

    if (side === "AR" && creditRows.length) {
      // Customer advances applied to invoices later (allocatePartyAdvance) — consume oldest first.
      const applied = await db.query(
        `SELECT s.party_id, COALESCE(SUM(a.allocated_aed_minor), 0)::bigint AS n
         FROM books_allocations a
         JOIN books_documents s ON s.id = a.settlement_document_id
         WHERE a.client_id = $1 AND s.memo = 'Advance allocation' AND s.status = 'posted'
           AND s.issue_date <= $2::date
         GROUP BY s.party_id`,
        [clientId, asOf],
      );
      const left = new Map(applied.rows.map((r) => [String(r.party_id), Number(r.n)]));
      for (const c of creditRows) {
        const pid = String(c.r.party_id);
        const use = Math.min(left.get(pid) ?? 0, c.aed);
        if (use > 0) {
          c.aed -= use;
          left.set(pid, (left.get(pid) ?? 0) - use);
        }
      }
    }

    for (const c of creditRows) {
      if (c.aed <= 0) continue;
      const date = iso(c.r.entry_date);
      const days = overdueDays(asOf, date);
      rows.push({
        kind: /^on account/i.test(String(c.r.line_memo || "")) ? "on_account" : "advance",
        date,
        ref: String(c.r.entry_no || String(c.r.id).slice(0, 8)),
        partyId: String(c.r.party_id),
        partyName: String(c.r.party_name),
        pendingMinor: -c.aed,
        dueDate: null,
        overdueDays: days,
        bucket: ageingBucket(days),
        documentId: c.r.settlement_document_id ? String(c.r.settlement_document_id) : null,
        journalEntryId: c.r.journal_entry_id ? String(c.r.journal_entry_id) : null,
      });
    }

    rows.sort(
      (a, b) =>
        a.partyName.localeCompare(b.partyName) || a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref),
    );
    const totals = emptyTotals();
    const byParty = new Map<string, { partyId: string; partyName: string; totals: BucketTotals }>();
    for (const r of rows) {
      let p = byParty.get(r.partyId);
      if (!p) {
        p = { partyId: r.partyId, partyName: r.partyName, totals: emptyTotals() };
        byParty.set(r.partyId, p);
      }
      p.totals[r.bucket] += r.pendingMinor;
      p.totals.total += r.pendingMinor;
      totals[r.bucket] += r.pendingMinor;
      totals.total += r.pendingMinor;
    }
    return { side, asOf, rows, parties: [...byParty.values()], totals };
  });
}
