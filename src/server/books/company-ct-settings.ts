/**
 * Corporate-tax company settings: Small Business Relief election and QFZP status.
 * NULL = not recorded — CT banner must not claim "no tax due" until recorded.
 */
import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export type CompanyCtSettings = {
  sbrElected: boolean | null;
  isQfzp: boolean | null;
  requireDualControl: boolean;
};

function mapRow(r: Record<string, unknown> | undefined): CompanyCtSettings {
  return {
    sbrElected: r?.sbr_elected == null ? null : Boolean(r.sbr_elected),
    isQfzp: r?.is_qfzp == null ? null : Boolean(r.is_qfzp),
    requireDualControl: r?.require_dual_control == null ? true : Boolean(r.require_dual_control),
  };
}

export async function getCompanyCtSettings(userId: string, clientId: string): Promise<CompanyCtSettings> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const r = await db.query(
      `SELECT sbr_elected, is_qfzp, require_dual_control FROM clients WHERE id = $1`,
      [clientId],
    );
    return mapRow(r.rows[0]);
  });
}

export async function setCompanyCtSettings(
  userId: string,
  clientId: string,
  body: {
    sbrElected?: boolean | null;
    isQfzp?: boolean | null;
    requireDualControl?: boolean;
  },
): Promise<CompanyCtSettings> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const role = await db.query(`SELECT role FROM users WHERE id = $1`, [userId]);
    if (String(role.rows[0]?.role) !== "admin") {
      throw new BooksError("ct_settings_require_admin", "forbidden");
    }
    const beforeRow = await db.query(
      `SELECT sbr_elected, is_qfzp, require_dual_control FROM clients WHERE id = $1 FOR UPDATE`,
      [clientId],
    );
    const before = mapRow(beforeRow.rows[0]);
    const next = { ...before };
    if (body.sbrElected !== undefined) next.sbrElected = body.sbrElected;
    if (body.isQfzp !== undefined) next.isQfzp = body.isQfzp;
    if (body.requireDualControl !== undefined) next.requireDualControl = Boolean(body.requireDualControl);

    await db.query(
      `UPDATE clients SET sbr_elected = $2, is_qfzp = $3, require_dual_control = $4 WHERE id = $1`,
      [clientId, next.sbrElected, next.isQfzp, next.requireDualControl],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "set_ct_settings",
      entity: "client",
      entityId: clientId,
      before,
      after: next,
    });
    return next;
  });
}
