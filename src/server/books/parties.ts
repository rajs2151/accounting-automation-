import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { isValidTrn } from "@/server/books/parsing";
import { assertSyntheticTenant } from "@/server/security-gate";

function normalizeTrnOrThrow(trn: string | null | undefined): string | null {
  if (trn == null || String(trn).trim() === "") return null;
  const cleaned = String(trn).replace(/\s/g, "");
  if (!isValidTrn(cleaned)) throw new BooksError("invalid_trn", "invalid");
  return cleaned;
}

export type PartyInput = {
  partyType: "customer" | "supplier";
  name: string;
  trn?: string | null;
  country?: string;
  emirate?: string | null;
  zone?: "mainland" | "free_zone" | "designated_zone" | null;
  defaultAccountId?: string | null;
  defaultVatCode?: string | null;
  paymentTermsDays?: number;
};

function normalizeName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function trgmSimilar(a: string, b: string) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const as = new Set(na.split(" "));
  const bs = new Set(nb.split(" "));
  let inter = 0;
  for (const t of as) if (bs.has(t)) inter += 1;
  const union = as.size + bs.size - inter;
  return union === 0 ? 0 : inter / union;
}

export async function listBooksParties(
  userId: string,
  clientId: string,
  opts?: { partyType?: string; q?: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT p.id, p.party_type AS "partyType", p.name, p.trn, p.country, p.emirate, p.zone,
              p.default_account_id AS "defaultAccountId", p.default_vat_code AS "defaultVatCode",
              p.payment_terms_days AS "paymentTermsDays", p.active,
              a.code AS "defaultAccountCode",
              COALESCE((
                SELECT SUM(oi.open_aed_minor)::bigint
                FROM books_open_items oi
                JOIN books_documents d ON d.id = oi.document_id
                WHERE d.client_id = p.client_id
                  AND d.party_id = p.id
                  AND d.deleted_at IS NULL
                  AND oi.status IN ('open', 'partial')
              ), 0)::bigint AS "balanceMinor"
       FROM books_parties p
       LEFT JOIN books_accounts a ON a.id = p.default_account_id
       WHERE p.client_id = $1
         AND ($2::text IS NULL OR p.party_type = $2)
         AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%' OR p.trn ILIKE '%' || $3 || '%')
       ORDER BY p.party_type, p.name`,
      [clientId, opts?.partyType || null, opts?.q?.trim() || null],
    );
    return rows.rows.map((r) => ({
      ...r,
      balanceMinor: Number(r.balanceMinor || 0),
    }));
  });
}

export async function suggestPartyDuplicates(
  userId: string,
  clientId: string,
  partyType: string,
  name: string,
  trn?: string | null,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, name, trn, party_type AS "partyType"
       FROM books_parties
       WHERE client_id = $1 AND party_type = $2 AND active = true`,
      [clientId, partyType],
    );
    const suggestions = [];
    for (const row of rows.rows) {
      const score =
        trn && row.trn && String(row.trn) === trn
          ? 1
          : trgmSimilar(name, String(row.name));
      if (score >= 0.6) {
        suggestions.push({
          id: String(row.id),
          name: String(row.name),
          trn: row.trn as string | null,
          score,
        });
      }
    }
    suggestions.sort((a, b) => b.score - a.score);
    return suggestions.slice(0, 5);
  });
}

export async function createBooksParty(
  userId: string,
  clientId: string,
  body: PartyInput & { force?: boolean },
) {
  const name = body.name?.trim();
  if (!name) throw new BooksError("name_required", "invalid");
  if (!["customer", "supplier"].includes(body.partyType)) {
    throw new BooksError("invalid_party_type", "invalid");
  }
  const trn = normalizeTrnOrThrow(body.trn);
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (!body.force) {
      const existing = await db.query(
        `SELECT id, name, trn FROM books_parties
         WHERE client_id = $1 AND party_type = $2 AND active = true`,
        [clientId, body.partyType],
      );
      const suggestions = [];
      for (const row of existing.rows) {
        const score =
          trn && row.trn && String(row.trn) === trn
            ? 1
            : trgmSimilar(name, String(row.name));
        if (score >= 0.6) {
          suggestions.push({
            id: String(row.id),
            name: String(row.name),
            trn: row.trn as string | null,
            score,
          });
        }
      }
      if (suggestions.length) {
        return { id: null as string | null, possibleDuplicate: true, suggestions };
      }
    }
    const id = randomUUID();
    await db.query(
      `INSERT INTO books_parties (
         id, client_id, party_type, name, trn, country, emirate, zone,
         default_account_id, default_vat_code, payment_terms_days
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        clientId,
        body.partyType,
        name,
        trn,
        (body.country || "AE").toUpperCase().slice(0, 2),
        body.emirate || null,
        body.zone || null,
        body.defaultAccountId || null,
        body.defaultVatCode || null,
        body.paymentTermsDays ?? 30,
      ],
    );
    const after = await db.query(`SELECT * FROM books_parties WHERE id = $1`, [id]);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_party",
      entityId: id,
      before: null,
      after: after.rows[0],
    });
    return { id, possibleDuplicate: false, suggestions: [] as unknown[] };
  });
}

export async function updateBooksParty(
  userId: string,
  clientId: string,
  partyId: string,
  body: Partial<PartyInput> & { active?: boolean },
) {
  const trn =
    body.trn === undefined ? undefined : normalizeTrnOrThrow(body.trn);
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const before = await db.query(
      `SELECT * FROM books_parties WHERE id = $1 AND client_id = $2`,
      [partyId, clientId],
    );
    if (!before.rowCount) throw new BooksError("party_not_found", "not_found");
    await db.query(
      `UPDATE books_parties SET
         name = COALESCE($3, name),
         trn = COALESCE($4, trn),
         country = COALESCE($5, country),
         emirate = COALESCE($6, emirate),
         zone = COALESCE($7, zone),
         default_account_id = COALESCE($8, default_account_id),
         default_vat_code = COALESCE($9, default_vat_code),
         payment_terms_days = COALESCE($10, payment_terms_days),
         active = COALESCE($11, active),
         updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [
        partyId,
        clientId,
        body.name?.trim() || null,
        trn === undefined ? null : trn,
        body.country?.toUpperCase().slice(0, 2) || null,
        body.emirate === undefined ? null : body.emirate,
        body.zone === undefined ? null : body.zone,
        body.defaultAccountId === undefined ? null : body.defaultAccountId,
        body.defaultVatCode === undefined ? null : body.defaultVatCode,
        body.paymentTermsDays ?? null,
        body.active ?? null,
      ],
    );
    const after = await db.query(`SELECT * FROM books_parties WHERE id = $1`, [partyId]);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "update",
      entity: "books_party",
      entityId: partyId,
      before: before.rows[0],
      after: after.rows[0],
    });
    return after.rows[0];
  });
}

export async function partyDisbursementNet(
  userId: string,
  clientId: string,
  partyId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0)::bigint AS net_minor
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_accounts a ON a.id = l.account_id
       JOIN books_documents d ON d.journal_entry_id = e.id
       WHERE e.client_id = $1 AND e.status IN ('posted', 'reversed')
         AND a.code = '1220' AND d.party_id = $2 AND d.deleted_at IS NULL`,
      [clientId, partyId],
    );
    return { partyId, accountCode: "1220", netMinor: Number(rows.rows[0].net_minor) };
  });
}
