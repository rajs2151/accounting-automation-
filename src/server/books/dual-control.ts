import type { PoolClient } from "pg";

import { BooksError } from "@/server/books/errors";

/** Post / reverse / lock: actor must be admin or approver, and (when dual control is on) not the preparer. */
export async function requireDualControlActor(
  db: PoolClient,
  actorUserId: string,
  preparerUserId: string | null | undefined,
  action: "post" | "reverse" | "lock",
  opts?: { clientId?: string },
) {
  const roleRow = await db.query(`SELECT role FROM users WHERE id = $1`, [actorUserId]);
  if (!roleRow.rowCount) throw new BooksError("user_not_found", "forbidden");
  const role = String(roleRow.rows[0].role);
  if (!["admin", "approver"].includes(role)) {
    throw new BooksError(`${action}_requires_approver`, "forbidden");
  }
  if (!preparerUserId || preparerUserId !== actorUserId) return;

  let requireDual = true;
  if (opts?.clientId) {
    const c = await db.query(`SELECT require_dual_control FROM clients WHERE id = $1`, [opts.clientId]);
    if (c.rowCount && c.rows[0].require_dual_control === false) {
      requireDual = false;
    }
  }
  if (requireDual) {
    throw new BooksError(`${action}_preparer_cannot_approve`, "forbidden");
  }
}

export async function requireApproverOrAdmin(db: PoolClient, actorUserId: string, action: string) {
  const roleRow = await db.query(`SELECT role FROM users WHERE id = $1`, [actorUserId]);
  if (!roleRow.rowCount) throw new BooksError("user_not_found", "forbidden");
  const role = String(roleRow.rows[0].role);
  if (!["admin", "approver"].includes(role)) {
    throw new BooksError(`${action}_requires_approver`, "forbidden");
  }
}
