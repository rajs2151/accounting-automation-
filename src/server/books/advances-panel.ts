/**
 * Phase 3 rank 6: read-only customer advances (2320) + deferred revenue schedules panel.
 */
import { withUser } from "@/lib/db";
import { assertSyntheticTenant } from "@/server/security-gate";

export type AdvanceRow = {
  partyId: string;
  partyName: string;
  currency: string;
  /** Net remaining (matches GL 2320). */
  balanceOriginalMinor: number;
  balanceAedMinor: number;
  vatOriginalMinor: number;
  vatAedMinor: number;
};

export type DeferredRow = {
  id: string;
  documentId: string;
  documentNumber: string | null;
  partyName: string | null;
  releaseDate: string;
  amountAedMinor: number;
  revenueAccountCode: string;
  revenueAccountName: string;
  status: string;
};

export type AdvancesPanel = {
  advances: AdvanceRow[];
  advancesTotalAedMinor: number;
  deferred: DeferredRow[];
  deferredPendingTotalMinor: number;
  gl2320CreditMinor: number;
  subledgerAedMinor: number;
  driftMinor: number;
  drift: boolean;
};

export async function booksAdvancesPanel(
  userId: string,
  clientId: string,
): Promise<AdvancesPanel> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);

    const advances = await db.query(
      `SELECT a.party_id AS "partyId", p.name AS "partyName", a.currency,
              a.balance_original_minor AS "balanceOriginalMinor",
              a.balance_aed_minor AS "balanceAedMinor",
              COALESCE(a.vat_original_minor, 0) AS "vatOriginalMinor",
              COALESCE(a.vat_aed_minor, 0) AS "vatAedMinor"
       FROM books_party_advances a
       JOIN books_parties p ON p.id = a.party_id
       WHERE a.client_id = $1
         AND (a.balance_aed_minor <> 0 OR COALESCE(a.vat_aed_minor, 0) <> 0)
       ORDER BY p.name, a.currency`,
      [clientId],
    );

    const deferred = await db.query(
      `SELECT s.id, s.document_id AS "documentId",
              d.document_number AS "documentNumber",
              p.name AS "partyName",
              s.release_date::text AS "releaseDate",
              s.amount_aed_minor AS "amountAedMinor",
              acc.code AS "revenueAccountCode",
              acc.name AS "revenueAccountName",
              s.status
       FROM books_deferred_schedules s
       JOIN books_documents d ON d.id = s.document_id
       LEFT JOIN books_parties p ON p.id = d.party_id
       JOIN books_accounts acc ON acc.id = s.revenue_account_id
       WHERE s.client_id = $1 AND s.status IN ('pending', 'blocked')
       ORDER BY s.release_date, s.created_at`,
      [clientId],
    );

    const gl = await db.query(
      `SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0)::bigint AS bal
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_accounts a ON a.id = l.account_id
       WHERE e.client_id = $1
         AND e.status IN ('posted', 'reversed')
         AND e.deleted_at IS NULL
         AND a.client_id = $1
         AND a.code = '2320'`,
      [clientId],
    );

    const advanceRows: AdvanceRow[] = advances.rows.map((r) => ({
      partyId: String(r.partyId),
      partyName: String(r.partyName),
      currency: String(r.currency),
      balanceOriginalMinor: Number(r.balanceOriginalMinor),
      balanceAedMinor: Number(r.balanceAedMinor),
      vatOriginalMinor: Number(r.vatOriginalMinor),
      vatAedMinor: Number(r.vatAedMinor),
    }));
    const deferredRows: DeferredRow[] = deferred.rows.map((r) => ({
      id: String(r.id),
      documentId: String(r.documentId),
      documentNumber: r.documentNumber == null ? null : String(r.documentNumber),
      partyName: r.partyName == null ? null : String(r.partyName),
      releaseDate: String(r.releaseDate).slice(0, 10),
      amountAedMinor: Number(r.amountAedMinor),
      revenueAccountCode: String(r.revenueAccountCode),
      revenueAccountName: String(r.revenueAccountName),
      status: String(r.status),
    }));

    const advancesTotalAedMinor = advanceRows.reduce((s, r) => s + r.balanceAedMinor, 0);
    const deferredPendingTotalMinor = deferredRows.reduce((s, r) => s + r.amountAedMinor, 0);
    const gl2320CreditMinor = Number(gl.rows[0].bal);
    const subledgerAedMinor = advancesTotalAedMinor;
    const driftMinor = gl2320CreditMinor - subledgerAedMinor;

    return {
      advances: advanceRows,
      advancesTotalAedMinor,
      deferred: deferredRows,
      deferredPendingTotalMinor,
      gl2320CreditMinor,
      subledgerAedMinor,
      driftMinor,
      drift: driftMinor !== 0,
    };
  });
}
