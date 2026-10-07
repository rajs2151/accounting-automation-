/**
 * VAT 201 return helpers (P2B-6 box mapping; P2B-7 draft generation).
 * Box map lives in books_vat_codes.vat201_output_box / vat201_input_box (db/54); emirate letters for
 * Box 1 come from the document's place of supply (P2B-5).
 */
import { withUser } from "@/lib/db";
import { vatPeriodForMonth, type VatFrequency } from "@/server/books/dashboard";
import { BooksError } from "@/server/books/errors";
import {
  queryPlaceOfSupplyGaps,
  type PlaceOfSupply,
  type PlaceOfSupplyGap,
} from "@/server/books/place-of-supply";
import { assertSyntheticTenant } from "@/server/security-gate";

/** Box 1 sub-box per emirate (VAT 201 form order). */
export const EMIRATE_BOX: Record<Exclude<PlaceOfSupply, "OUTSIDE_UAE">, string> = {
  "Abu Dhabi": "1a",
  Dubai: "1b",
  Sharjah: "1c",
  Ajman: "1d",
  "Umm Al Quwain": "1e",
  "Ras Al Khaimah": "1f",
  Fujairah: "1g",
};

export type VatBoxMapRow = {
  code: string;
  vat201OutputBox: string | null;
  vat201InputBox: string | null;
};

/**
 * Box for a VAT code in a direction. Output Box 1 needs an emirate (→ 1a–1g); without one the line
 * cannot be placed and the caller must treat it as a gap. Returns null when the code reports nowhere.
 */
export function vat201Box(
  map: ReadonlyMap<string, VatBoxMapRow>,
  code: string | null | undefined,
  direction: "output" | "input",
  placeOfSupply?: PlaceOfSupply | null,
): { box: string | null; needsEmirate: boolean } {
  if (!code) return { box: null, needsEmirate: false };
  const row = map.get(code);
  if (!row) return { box: null, needsEmirate: false };
  const box = direction === "output" ? row.vat201OutputBox : row.vat201InputBox;
  if (box !== "1") return { box, needsEmirate: false };
  if (!placeOfSupply || placeOfSupply === "OUTSIDE_UAE") return { box: null, needsEmirate: true };
  return { box: EMIRATE_BOX[placeOfSupply], needsEmirate: false };
}

// ---------------------------------------------------------------------------
// P2B-7: draft VAT 201 (read-only; never posts or files)
// ---------------------------------------------------------------------------

export const VAT201_BOXES = [
  "1a", "1b", "1c", "1d", "1e", "1f", "1g", "2", "3", "4", "5", "6", "7", "9", "10",
] as const;
export type Vat201BoxId = (typeof VAT201_BOXES)[number];

export type Vat201Draft = {
  from: string;
  to: string;
  /** Per box: amount (net, AED fils) and VAT (AED fils). Boxes 2, 6, 7 are not produced yet (always 0). */
  boxes: Record<Vat201BoxId, { amountMinor: number; vatMinor: number }>;
  box8: { amountMinor: number; vatMinor: number };
  box11: { amountMinor: number; vatMinor: number };
  box12DueTaxMinor: number;
  box13RecoverableTaxMinor: number;
  box14PayableMinor: number;
  /** VAT control movement in the range from entries not linked to a document (e.g. manual JVs). */
  unlinked: { outputVatMinor: number; inputVatMinor: number; lineCount: number };
};

export class VatReturnBlockedError extends BooksError {
  readonly gaps: PlaceOfSupplyGap[];
  constructor(gaps: PlaceOfSupplyGap[]) {
    super("vat_return_blocked_place_of_supply_gaps", "conflict");
    this.gaps = gaps;
  }
}

const SALES_DOCS = new Set(["sales_invoice", "credit_note"]);

/**
 * Draft VAT 201 for a date range (or the company's VAT period containing a month). Reads posted
 * journal lines only (rule 1); each line's document supplies the place of supply. Reversals (voids)
 * follow their original document, with the opposite sign.
 *
 * Blocked (VatReturnBlockedError) while the place-of-supply gap list for the range is non-empty
 * (owner decision 2026-10-06).
 */
export async function generateVat201Draft(
  userId: string,
  clientId: string,
  opts: { from?: string; to?: string; monthEnd?: string },
): Promise<Vat201Draft> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    let from = opts.from;
    let to = opts.to;
    if (!from || !to) {
      if (!opts.monthEnd) throw new BooksError("vat_return_range_required", "invalid");
      const c = await db.query(
        `SELECT vat_return_frequency, vat_period_end_month FROM clients WHERE id = $1`,
        [clientId],
      );
      const freq = c.rows[0]?.vat_return_frequency as VatFrequency | null;
      if (!freq) throw new BooksError("vat_stagger_not_set", "invalid");
      const p = vatPeriodForMonth(opts.monthEnd, freq, c.rows[0].vat_period_end_month as number | null);
      from = p.periodStart;
      to = p.periodEnd;
    }

    const gaps = await queryPlaceOfSupplyGaps(db, clientId, { from, to });
    if (gaps.length) throw new VatReturnBlockedError(gaps);

    const mapRows = await db.query(
      `SELECT code, vat201_output_box AS "vat201OutputBox", vat201_input_box AS "vat201InputBox"
       FROM books_vat_codes`,
    );
    const map = new Map<string, VatBoxMapRow>(mapRows.rows.map((r) => [String(r.code), r as VatBoxMapRow]));

    // Expense vouchers post recoverable input VAT without a books_documents row.
    // Treat them (and their reversals) as purchases so box 9 / 13 include them.
    const lines = await db.query(
      `SELECT a.code AS account, l.vat_treatment AS treatment, l.debit_minor, l.credit_minor,
              COALESCE(
                d.doc_type,
                CASE
                  WHEN e.voucher_type = 'Expense' OR orig.voucher_type = 'Expense'
                  THEN 'purchase_bill'
                END
              ) AS doc_type,
              d.place_of_supply,
              COALESCE(e.reverses_entry_id, e.id) AS base_entry,
              (d.id IS NOT NULL
                OR e.voucher_type = 'Expense'
                OR orig.voucher_type = 'Expense') AS linked
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_accounts a ON a.id = l.account_id
       LEFT JOIN books_journal_entries orig ON orig.id = e.reverses_entry_id
       LEFT JOIN books_documents d
         ON d.journal_entry_id = COALESCE(e.reverses_entry_id, e.id) AND d.client_id = e.client_id
            AND d.doc_type IN ('sales_invoice', 'purchase_bill', 'credit_note', 'debit_note')
       WHERE e.client_id = $1 AND e.status IN ('posted', 'reversed') AND e.deleted_at IS NULL
         AND e.entry_date BETWEEN $2::date AND $3::date`,
      [clientId, from, to],
    );

    // Purchase entries whose SR VAT was recovered (has a 1430 SR line) — only those report in Box 9.
    const recovered = new Set<string>();
    for (const r of lines.rows) {
      if (r.linked && !SALES_DOCS.has(String(r.doc_type)) && r.account === "1430" && r.treatment === "SR") {
        recovered.add(String(r.base_entry));
      }
    }

    const boxes = Object.fromEntries(VAT201_BOXES.map((b) => [b, { amountMinor: 0, vatMinor: 0 }])) as Vat201Draft["boxes"];
    const add = (box: string | null, field: "amountMinor" | "vatMinor", v: number) => {
      if (!box || v === 0) return;
      boxes[box as Vat201BoxId][field] += v;
    };
    const unlinked = { outputVatMinor: 0, inputVatMinor: 0, lineCount: 0 };

    for (const r of lines.rows) {
      const account = String(r.account);
      const dr = Number(r.debit_minor);
      const cr = Number(r.credit_minor);
      const treatment = r.treatment ? String(r.treatment) : null;
      if (!r.linked) {
        // Only orphan *charges* (output credited / input debited). VAT settlements
        // (Dr 2210 / Cr 1430) must not cancel the warning to zero.
        if (account === "2210") {
          const netOut = cr - dr;
          if (netOut > 0) {
            unlinked.lineCount += 1;
            unlinked.outputVatMinor += netOut;
          }
        } else if (account === "1430") {
          const netIn = dr - cr;
          if (netIn > 0) {
            unlinked.lineCount += 1;
            unlinked.inputVatMinor += netIn;
          }
        }
        continue;
      }
      const pos = (r.place_of_supply as PlaceOfSupply | null) ?? null;
      if (SALES_DOCS.has(String(r.doc_type))) {
        if (account === "1210" || account === "1220") continue;
        const { box } = vat201Box(map, treatment, "output", pos);
        add(box, account === "2210" ? "vatMinor" : "amountMinor", cr - dr);
        continue;
      }
      // Purchases / debit notes.
      if (account === "2110" || account === "1220") continue;
      if (account === "2210") {
        if (treatment === "RC_OUT") add("3", "vatMinor", cr - dr);
        continue;
      }
      if (account === "1430") {
        add(vat201Box(map, treatment, "input").box, "vatMinor", dr - cr);
        continue;
      }
      if (treatment === "RC_IN") {
        // Reverse-charge supply: reported on both sides (Box 3 output, Box 10 input).
        add("3", "amountMinor", dr - cr);
        add("10", "amountMinor", dr - cr);
      } else if (treatment === "SR" && recovered.has(String(r.base_entry))) {
        add("9", "amountMinor", dr - cr);
      }
    }

    const sum = (ids: readonly string[]) =>
      ids.reduce(
        (acc, b) => ({
          amountMinor: acc.amountMinor + boxes[b as Vat201BoxId].amountMinor,
          vatMinor: acc.vatMinor + boxes[b as Vat201BoxId].vatMinor,
        }),
        { amountMinor: 0, vatMinor: 0 },
      );
    const box8 = sum(["1a", "1b", "1c", "1d", "1e", "1f", "1g", "2", "3", "4", "5", "6", "7"]);
    const box11 = sum(["9", "10"]);
    return {
      from: from!,
      to: to!,
      boxes,
      box8,
      box11,
      box12DueTaxMinor: box8.vatMinor,
      box13RecoverableTaxMinor: box11.vatMinor,
      box14PayableMinor: box8.vatMinor - box11.vatMinor,
      unlinked,
    };
  });
}
