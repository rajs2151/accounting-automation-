/**
 * P6-4 review fixes: comment threads and forecasts only accept this company's accounts / periods,
 * two first comments at once share one thread (no 500), long comments and bad ids are 400s, growth
 * percentages out of range are refused. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { postCommentMessage } from "@/server/books/comments";
import { upsertBooksForecast } from "@/server/books/forecasts";
import { createTestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";

async function withAdmin(t: test.TestContext) {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const admin = new pg.Client({
    connectionString: process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:"),
  });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return null;
  }
  const ready = await admin.query(`SELECT to_regclass('books_comment_threads') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/61 not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as Error).message;
  }
}

test("comments: another company's account or period is refused; bad input is a 400", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const a = await createTestCompany(admin, "cmt-h-a");
    const b = await createTestCompany(admin, "cmt-h-b");
    const mayA = a.periods["May 2026"]!;
    assert.equal(
      await code(postCommentMessage(OMAR, a.clientId, { accountId: b.accountIdByCode["4100"]!, periodId: mayA, text: "x" })),
      "account_not_found",
    );
    assert.equal(
      await code(postCommentMessage(OMAR, a.clientId, { accountId: a.accountIdByCode["4100"]!, periodId: b.periods["May 2026"]!, text: "x" })),
      "period_not_found",
    );
    assert.equal(
      await code(postCommentMessage(OMAR, a.clientId, { accountId: "not-a-uuid", periodId: mayA, text: "x" })),
      "invalid_account_id",
    );
    assert.equal(
      await code(postCommentMessage(OMAR, a.clientId, { accountId: a.accountIdByCode["4100"]!, periodId: mayA, text: "y".repeat(4001) })),
      "comment_too_long",
    );
  } finally {
    await admin.end();
  }
});

test("comments: two first comments at once share one thread", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const a = await createTestCompany(admin, "cmt-h-race");
    const body = { accountId: a.accountIdByCode["4100"]!, periodId: a.periods["May 2026"]! };
    const res = await Promise.allSettled([
      postCommentMessage(OMAR, a.clientId, { ...body, text: "first" }),
      postCommentMessage(OMAR, a.clientId, { ...body, text: "second" }),
    ]);
    assert.deepEqual(res.map((r) => r.status), ["fulfilled", "fulfilled"]);
    const threads = await admin.query(`SELECT count(*)::int AS n FROM books_comment_threads WHERE client_id = $1`, [a.clientId]);
    assert.equal(threads.rows[0].n, 1);
  } finally {
    await admin.end();
  }
});

test("forecasts: another company's account is refused; growth out of range is a 400", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const a = await createTestCompany(admin, "fc-h-a");
    const b = await createTestCompany(admin, "fc-h-b");
    const jun = a.periods["Jun 2026"]!;
    assert.equal(
      await code(upsertBooksForecast(OMAR, a.clientId, { accountId: b.accountIdByCode["4100"]!, periodId: jun, amountMinor: 100, method: "override" })),
      "account_not_found",
    );
    assert.equal(
      await code(upsertBooksForecast(OMAR, a.clientId, { accountId: a.accountIdByCode["4100"]!, periodId: jun, amountMinor: 100, method: "linear", growthPct: 1e9 })),
      "invalid_growth_pct",
    );
    assert.equal(
      await code(upsertBooksForecast(OMAR, a.clientId, { accountId: a.accountIdByCode["4100"]!, periodId: jun, amountMinor: 100, method: "override" })),
      "ok",
    );
  } finally {
    await admin.end();
  }
});
