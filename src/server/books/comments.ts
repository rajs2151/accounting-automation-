/**
 * P6-4a: one comment thread per (client, account, period); @mentions → notifications.
 */
import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
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

export async function getOrCreateCommentThread(
  userId: string,
  clientId: string,
  accountId: string,
  periodId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const existing = await db.query(
      `SELECT id FROM books_comment_threads
       WHERE client_id = $1 AND account_id = $2 AND period_id = $3`,
      [clientId, accountId, periodId],
    );
    if (existing.rowCount) return { id: String(existing.rows[0].id), created: false };
    const id = randomUUID();
    try {
      await db.query(
        `INSERT INTO books_comment_threads (id, client_id, account_id, period_id)
         VALUES ($1,$2,$3,$4)`,
        [id, clientId, accountId, periodId],
      );
    } catch (e: unknown) {
      // Unique race — re-read.
      const again = await db.query(
        `SELECT id FROM books_comment_threads
         WHERE client_id = $1 AND account_id = $2 AND period_id = $3`,
        [clientId, accountId, periodId],
      );
      if (again.rowCount) return { id: String(again.rows[0].id), created: false };
      throw e;
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
