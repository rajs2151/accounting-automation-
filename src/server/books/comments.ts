/**
 * P6-4a: one comment thread per (client, account, period); @mentions → notifications.
 */
import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { assertUuid } from "@/server/books/periods";
import type { PoolClient } from "pg";
import { assertSyntheticTenant } from "@/server/security-gate";

/** Parse @Name or @"Full Name" mentions from body. */
export function parseMentionNames(body: string): string[] {
  const out: string[] = [];
  const quoted = body.matchAll(/@"([^"]+)"/g);
  for (const m of quoted) out.push(m[1].trim());
  const plain = body.matchAll(/(^|[\s(])@([A-Za-z][A-Za-z0-9._-]*)/g);
  for (const m of plain) out.push(m[2].trim());
  return [...new Set(out.filter(Boolean))];
}

/** Resolve mention tokens to user ids (full name, first name, or email local-part). */
export function resolveMentionUserIds(
  tokens: string[],
  users: Array<{ id: string; name: string; email?: string | null }>,
  excludeUserId?: string,
): string[] {
  const hits = new Set<string>();
  const lower = (s: string) => s.trim().toLowerCase();
  for (const token of tokens) {
    const t = lower(token);
    if (!t) continue;
    for (const u of users) {
      if (excludeUserId && u.id === excludeUserId) continue;
      const name = lower(u.name || "");
      const first = name.split(/\s+/)[0] || "";
      const local = lower(String(u.email || "").split("@")[0] || "");
      if (t === name || t === first || (local && t === local)) hits.add(u.id);
    }
  }
  return [...hits];
}

/** Longest comment accepted (characters). */
export const COMMENT_MAX_LENGTH = 4000;

/**
 * The account and period must belong to this company (foreign keys don't see RLS, so another
 * company's ids would otherwise be accepted), and only roles that may write can comment.
 */
async function assertCommentTarget(db: PoolClient, userId: string, clientId: string, accountId: string, periodId: string) {
  const role = await db.query(`SELECT role FROM users WHERE id = $1`, [userId]);
  if (!["admin", "accountant", "approver"].includes(String(role.rows[0]?.role || ""))) {
    throw new BooksError("comment_forbidden", "forbidden");
  }
  const acct = await db.query(`SELECT 1 FROM books_accounts WHERE id = $1 AND client_id = $2`, [accountId, clientId]);
  if (!acct.rowCount) throw new BooksError("account_not_found", "not_found");
  const per = await db.query(`SELECT 1 FROM books_periods WHERE id = $1 AND client_id = $2`, [periodId, clientId]);
  if (!per.rowCount) throw new BooksError("period_not_found", "not_found");
}

export async function getOrCreateCommentThread(
  userId: string,
  clientId: string,
  accountId: string,
  periodId: string,
) {
  assertUuid(accountId, "invalid_account_id");
  assertUuid(periodId, "invalid_period_id");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await assertCommentTarget(db, userId, clientId, accountId, periodId);
    const id = randomUUID();
    // ON CONFLICT instead of catch-and-reread: after a failed INSERT the transaction is aborted, so the
    // old retry SELECT could never run (two first comments at once gave a 500).
    const inserted = await db.query(
      `INSERT INTO books_comment_threads (id, client_id, account_id, period_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_id, account_id, period_id) DO NOTHING
       RETURNING id`,
      [id, clientId, accountId, periodId],
    );
    if (!inserted.rowCount) {
      const existing = await db.query(
        `SELECT id FROM books_comment_threads
         WHERE client_id = $1 AND account_id = $2 AND period_id = $3`,
        [clientId, accountId, periodId],
      );
      return { id: String(existing.rows[0].id), created: false };
    }
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_comment_thread",
      entityId: id,
      after: { accountId, periodId },
    });
    return { id, created: true };
  });
}

export async function listCommentThreadBadges(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<Array<{ accountId: string; threadId: string; messageCount: number; unreadCount: number }>> {
  assertUuid(periodId, "invalid_period_id");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT t.id AS "threadId", t.account_id AS "accountId",
              COUNT(m.id)::int AS "messageCount",
              COUNT(m.id) FILTER (
                WHERE m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
                  AND m.author_id IS DISTINCT FROM $3
              )::int AS "unreadCount"
       FROM books_comment_threads t
       LEFT JOIN books_comment_messages m ON m.thread_id = t.id
       LEFT JOIN books_comment_reads r ON r.thread_id = t.id AND r.user_id = $3
       WHERE t.client_id = $1 AND t.period_id = $2
       GROUP BY t.id, t.account_id`,
      [clientId, periodId, userId],
    );
    return rows.rows.map((r) => ({
      accountId: String(r.accountId),
      threadId: String(r.threadId),
      messageCount: Number(r.messageCount),
      unreadCount: Number(r.unreadCount),
    }));
  });
}

export async function listCommentMessages(
  userId: string,
  clientId: string,
  threadId: string,
) {
  assertUuid(threadId, "invalid_thread_id");
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const t = await db.query(
      `SELECT id, account_id AS "accountId", period_id AS "periodId"
       FROM books_comment_threads WHERE id = $1 AND client_id = $2`,
      [threadId, clientId],
    );
    if (!t.rowCount) throw new BooksError("thread_not_found", "not_found");
    const rows = await db.query(
      `SELECT m.id, m.body, m.created_at AS "createdAt", m.author_id AS "authorId",
              u.name AS "authorName", u.email AS "authorEmail"
       FROM books_comment_messages m
       JOIN users u ON u.id = m.author_id
       WHERE m.thread_id = $1 AND m.client_id = $2
       ORDER BY m.created_at`,
      [threadId, clientId],
    );
    await db.query(
      `INSERT INTO books_comment_reads (thread_id, user_id, client_id, last_read_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = now()`,
      [threadId, userId, clientId],
    );
    return {
      thread: {
        id: String(t.rows[0].id),
        accountId: String(t.rows[0].accountId),
        periodId: String(t.rows[0].periodId),
      },
      messages: rows.rows,
    };
  });
}

export async function postCommentMessage(
  userId: string,
  clientId: string,
  body: { accountId: string; periodId: string; text: string },
) {
  const text = String(body.text || "").trim();
  if (!text) throw new BooksError("comment_body_required", "invalid");
  if (text.length > COMMENT_MAX_LENGTH) throw new BooksError("comment_too_long", "invalid");
  if (!body.accountId || !body.periodId) throw new BooksError("comment_fields_required", "invalid");

  const thread = await getOrCreateCommentThread(userId, clientId, body.accountId, body.periodId);

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const msgId = randomUUID();
    await db.query(
      `INSERT INTO books_comment_messages (id, client_id, thread_id, author_id, body)
       VALUES ($1,$2,$3,$4,$5)`,
      [msgId, clientId, thread.id, userId, text],
    );

    // user_client_access RLS only shows the caller's own rows — resolve mentions via firm users.
    const users = await db.query(
      `SELECT u.id, u.name, u.email
       FROM users u
       JOIN clients c ON c.firm_id = u.firm_id
       WHERE c.id = $1`,
      [clientId],
    );
    const mentioned = new Set(
      resolveMentionUserIds(
        parseMentionNames(text),
        users.rows.map((u) => ({
          id: String(u.id),
          name: String(u.name || ""),
          email: u.email == null ? null : String(u.email),
        })),
        userId,
      ),
    );
    for (const mentionUserId of mentioned) {
      await db.query(
        `INSERT INTO books_notifications (id, client_id, user_id, kind, payload_json)
         VALUES ($1,$2,$3,'comment_mention',$4::jsonb)`,
        [
          randomUUID(),
          clientId,
          mentionUserId,
          JSON.stringify({
            threadId: thread.id,
            messageId: msgId,
            accountId: body.accountId,
            periodId: body.periodId,
            fromUserId: userId,
            preview: text.slice(0, 200),
          }),
        ],
      );
    }

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "create",
      entity: "books_comment_message",
      entityId: msgId,
      after: { threadId: thread.id, mentionCount: mentioned.size },
    });

    return {
      id: msgId,
      threadId: thread.id,
      mentionCount: mentioned.size,
      mentionedUserIds: [...mentioned],
    };
  });
}
