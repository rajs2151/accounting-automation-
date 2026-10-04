import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { assertSyntheticTenant } from "@/server/security-gate";

export type BooksJobKind =
  | "schedule_post"
  | "recurring_materialize"
  | "auto_reverse"
  | "extract_document"
  | "classify_document"
  | "deferred_release";

export async function enqueueBooksJob(
  db: PoolClient,
  clientId: string,
  kind: BooksJobKind,
  payload: Record<string, unknown>,
  runAt?: Date,
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO books_jobs (id, client_id, kind, status, payload, run_at)
     VALUES ($1,$2,$3,'queued',$4::jsonb,$5)`,
    [id, clientId, kind, JSON.stringify(payload), runAt ?? new Date()],
  );
  return id;
}

export async function listBooksJobs(userId: string, clientId: string, limit = 50) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT id, kind, status, payload, run_at AS "runAt", error,
              created_at AS "createdAt", finished_at AS "finishedAt"
       FROM books_jobs
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [clientId, limit],
    );
    return rows.rows;
  });
}
