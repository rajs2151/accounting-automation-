/**
 * Company VAT settings (admin only, audited): establishment emirate (place-of-supply rule for
 * services, P2B-5) and VAT return stagger (dashboard due date, P2B-4).
 */
import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { normalizeEmirate, type Emirate } from "@/server/books/place-of-supply";
import { assertSyntheticTenant } from "@/server/security-gate";

export type VatFrequency = "monthly" | "quarterly";

export type CompanyVatSettings = {
  establishmentEmirate: Emirate | null;
  vatReturnFrequency: VatFrequency | null;
  vatPeriodEndMonth: number | null;
};

function mapRow(r: Record<string, unknown> | undefined): CompanyVatSettings {
  return {
    establishmentEmirate: (r?.establishment_emirate as Emirate | null) ?? null,
    vatReturnFrequency: (r?.vat_return_frequency as VatFrequency | null) ?? null,
    vatPeriodEndMonth: r?.vat_period_end_month == null ? null : Number(r.vat_period_end_month),
  };
}

export async function getCompanyVatSettings(userId: string, clientId: string): Promise<CompanyVatSettings> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const r = await db.query(
      `SELECT establishment_emirate, vat_return_frequency, vat_period_end_month FROM clients WHERE id = $1`,
      [clientId],
    );
    return mapRow(r.rows[0]);
  });
}

/**
 * Update any subset of the VAT settings. Fields left undefined are kept; null clears.
 * Quarterly needs the month (1–12) in which one of the company's quarters ends.
 */
export async function setCompanyVatSettings(
  userId: string,
  clientId: string,
  body: {
    establishmentEmirate?: string | null;
    vatReturnFrequency?: VatFrequency | null;
    vatPeriodEndMonth?: number | null;
  },
): Promise<CompanyVatSettings> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const role = await db.query(`SELECT role FROM users WHERE id = $1`, [userId]);
    if (String(role.rows[0]?.role) !== "admin") {
      throw new BooksError("vat_settings_require_admin", "forbidden");
    }
    const beforeRow = await db.query(
      `SELECT establishment_emirate, vat_return_frequency, vat_period_end_month
       FROM clients WHERE id = $1 FOR UPDATE`,
      [clientId],
    );
    const before = mapRow(beforeRow.rows[0]);
    const next = { ...before };

    if (body.establishmentEmirate !== undefined) {
      if (body.establishmentEmirate === null || body.establishmentEmirate === "") {
        next.establishmentEmirate = null;
      } else {
        const e = normalizeEmirate(body.establishmentEmirate);
        if (!e) throw new BooksError("invalid_place_of_supply", "invalid");
        next.establishmentEmirate = e;
      }
    }
    if (body.vatReturnFrequency !== undefined) {
      const f = body.vatReturnFrequency;
      if (f !== null && f !== "monthly" && f !== "quarterly") {
        throw new BooksError("vat_stagger_invalid", "invalid");
      }
      next.vatReturnFrequency = f;
      if (f !== "quarterly") next.vatPeriodEndMonth = null;
    }
    if (body.vatPeriodEndMonth !== undefined && next.vatReturnFrequency === "quarterly") {
      next.vatPeriodEndMonth = body.vatPeriodEndMonth == null ? null : Number(body.vatPeriodEndMonth);
    }
    if (
      next.vatReturnFrequency === "quarterly" &&
      !(Number.isInteger(next.vatPeriodEndMonth) && next.vatPeriodEndMonth! >= 1 && next.vatPeriodEndMonth! <= 12)
    ) {
      throw new BooksError("vat_stagger_invalid", "invalid");
    }

    await db.query(
      `UPDATE clients SET establishment_emirate = $2, vat_return_frequency = $3, vat_period_end_month = $4
       WHERE id = $1`,
      [clientId, next.establishmentEmirate, next.vatReturnFrequency, next.vatPeriodEndMonth],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "set_vat_settings",
      entity: "client",
      entityId: clientId,
      before,
      after: next,
    });
    return next;
  });
}
