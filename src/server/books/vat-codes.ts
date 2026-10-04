import { withUser } from "@/lib/db";
import { assertSyntheticTenant } from "@/server/security-gate";

export type VatCodeRow = {
  code: string;
  name: string;
  rateBp: number;
  direction: string;
  recoverable: boolean;
  vat201Box: string | null;
};

export async function listBooksVatCodes(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT code, name, rate_bp AS "rateBp", direction, recoverable,
              vat201_box AS "vat201Box"
       FROM books_vat_codes WHERE active = true ORDER BY code`,
    );
    return rows.rows as VatCodeRow[];
  });
}

export function vatMinorForNet(netMinor: number, rateBp: number): number {
  if (!Number.isInteger(netMinor) || netMinor < 0) throw new Error("invalid_money");
  // round half up: (net * rateBp + 5000) / 10000
  return Math.floor((netMinor * rateBp + 5000) / 10000);
}
