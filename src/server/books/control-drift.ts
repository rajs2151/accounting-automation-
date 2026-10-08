/**
 * AR/AP control (TB 1210/2110) vs open-item ageing totals.
 * Drift means postings hit the control without a matching open item (or open items without control).
 */
import { booksAgeing } from "@/server/books/ageing";
import { BooksError } from "@/server/books/errors";
import { booksTrialBalance } from "@/server/books/trial-balance";
import { withUser } from "@/lib/db";
import { assertSyntheticTenant } from "@/server/security-gate";

export type SideControlDrift = {
  controlMinor: number;
  openMinor: number;
  /** control − open (fils). 0 = matched. */
  driftMinor: number;
};

export type ControlVsOpenItemsDrift = {
  periodId: string;
  asOf: string;
  ar: SideControlDrift;
  ap: SideControlDrift;
};

function iso(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

export async function controlVsOpenItemsDrift(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<ControlVsOpenItemsDrift> {
  if (!periodId) throw new BooksError("period_required", "invalid");

  const periodEnd = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const row = await db.query(
      `SELECT period_end FROM books_periods WHERE id = $1 AND client_id = $2`,
      [periodId, clientId],
    );
    if (!row.rowCount) throw new BooksError("period_not_found", "not_found");
    return iso(row.rows[0].period_end);
  });

  const [tb, arAge, apAge] = await Promise.all([
    booksTrialBalance(userId, clientId, periodId, { includeZeroBalances: true }),
    booksAgeing(userId, clientId, { side: "AR", asOf: periodEnd }),
    booksAgeing(userId, clientId, { side: "AP", asOf: periodEnd }),
  ]);

  const arCtrl =
    (tb.accounts["1210"]?.closingDebitMinor ?? 0) - (tb.accounts["1210"]?.closingCreditMinor ?? 0);
  const apCtrl =
    (tb.accounts["2110"]?.closingCreditMinor ?? 0) - (tb.accounts["2110"]?.closingDebitMinor ?? 0);
  const arOpen = Math.max(0, arAge.totals.total);
  const apOpen = Math.max(0, apAge.totals.total);

  return {
    periodId,
    asOf: periodEnd,
    ar: {
      controlMinor: Math.trunc(arCtrl),
      openMinor: Math.trunc(arOpen),
      driftMinor: Math.trunc(arCtrl) - Math.trunc(arOpen),
    },
    ap: {
      controlMinor: Math.trunc(apCtrl),
      openMinor: Math.trunc(apOpen),
      driftMinor: Math.trunc(apCtrl) - Math.trunc(apOpen),
    },
  };
}
