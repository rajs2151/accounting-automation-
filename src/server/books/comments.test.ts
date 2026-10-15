/**
 * P6-4a: unique comment thread per account/period; @mention → notification.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  listCommentMessages,
  listCommentThreadBadges,
  parseMentionNames,
  postCommentMessage,
  resolveMentionUserIds,
} from "@/server/books/comments";
import { createTestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";

async function withAdmin(t: test.TestContext) {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const adminUrl = process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return null;
  }
  const probe = await admin.query(
    `SELECT to_regclass('public.books_comment_threads') IS NOT NULL AS ok`,
  );
  if (!probe.rows[0]?.ok) {
    await admin.end();
    t.skip("db/61 comments not migrated");
    return null;
  }
  return admin;
}

test("P6-4a: parseMentionNames extracts quoted and plain tokens", () => {
  assert.deepEqual(parseMentionNames('Hi @"Layla Hassan" and @Omar please'), [
    "Layla Hassan",
    "Omar",
  ]);
});

test("P6-4a: resolveMentionUserIds matches first name and full name", () => {
  const users = [
    { id: LAYLA, name: "Layla Hassan", email: "layla@arnibooks.test" },
    { id: OMAR, name: "Omar Faris", email: "omar@arnibooks.test" },
  ];
  assert.deepEqual(resolveMentionUserIds(["Layla"], users, OMAR), [LAYLA]);
  assert.deepEqual(resolveMentionUserIds(["Omar Faris"], users, LAYLA), [OMAR]);
  assert.deepEqual(resolveMentionUserIds(["omar"], users, LAYLA), [OMAR]);
});

test("P6-4a: unique thread per account/period + mention notification", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p6-4a-cmt");
    const periodId = company.periods["May 2026"];
    const accountId = company.accountIdByCode["4100"];
    assert.ok(periodId && accountId);

    const first = await postCommentMessage(OMAR, company.clientId, {
      accountId,
      periodId,
      text: "Check revenue @Layla",
    });
    const second = await postCommentMessage(OMAR, company.clientId, {
      accountId,
      periodId,
      text: "Follow-up",
    });
    assert.equal(first.threadId, second.threadId);
    assert.equal(first.mentionCount, 1);
    assert.deepEqual(first.mentionedUserIds, [LAYLA]);

    const threads = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_comment_threads
       WHERE client_id = $1 AND account_id = $2 AND period_id = $3`,
      [company.clientId, accountId, periodId],
    );
    assert.equal(Number(threads.rows[0].n), 1);

    const notes = await admin.query(
      `SELECT kind, user_id AS "userId", payload_json AS payload
       FROM books_notifications
       WHERE client_id = $1 AND user_id = $2 AND kind = 'comment_mention'`,
      [company.clientId, LAYLA],
    );
    assert.equal(notes.rowCount, 1);
    assert.equal(String(notes.rows[0].userId), LAYLA);

    const beforeRead = await listCommentThreadBadges(LAYLA, company.clientId, periodId);
    const unread = beforeRead.find((b) => b.accountId === accountId);
    assert.ok(unread);
    assert.equal(unread.messageCount, 2);
    // Omar authored both; Layla has not read → 2 unread.
    assert.equal(unread.unreadCount, 2);

    const listed = await listCommentMessages(LAYLA, company.clientId, first.threadId);
    assert.equal(listed.messages.length, 2);

    const badges = await listCommentThreadBadges(LAYLA, company.clientId, periodId);
    const badge = badges.find((b) => b.accountId === accountId);
    assert.ok(badge);
    assert.equal(badge.messageCount, 2);
    // Layla just read the thread → unread should be 0 for her.
    assert.equal(badge.unreadCount, 0);

    const omarBadges = await listCommentThreadBadges(OMAR, company.clientId, periodId);
    const omarBadge = omarBadges.find((b) => b.accountId === accountId);
    assert.ok(omarBadge);
    // Omar authored both; unread excludes own messages → 0.
    assert.equal(omarBadge.unreadCount, 0);
  } finally {
    await admin.end();
  }
});
