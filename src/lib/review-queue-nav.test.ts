import assert from "node:assert/strict";
import test from "node:test";

import { needsReviewQueue, prevNextInReviewQueue } from "@/lib/review-queue-nav";

const QUEUE = [
  { id: "a", status: "needs_review", createdAt: "2026-05-15T12:00:00Z" },
  { id: "b", status: "confirmed", createdAt: "2026-05-15T11:00:00Z" },
  { id: "c", status: "needs_review", createdAt: "2026-05-15T10:00:00Z" },
  { id: "d", status: "needs_review", createdAt: "2026-05-15T09:00:00Z" },
];

test("needsReviewQueue keeps only needs_review ordered created_at DESC", () => {
  const q = needsReviewQueue(QUEUE);
  assert.deepEqual(
    q.map((i) => i.id),
    ["a", "c", "d"],
  );
});

test("prevNextInReviewQueue middle item has both neighbours", () => {
  const nav = prevNextInReviewQueue(QUEUE, "c");
  assert.equal(nav.prevId, "a");
  assert.equal(nav.nextId, "d");
  assert.equal(nav.index, 1);
});

test("prevNextInReviewQueue edges return null", () => {
  const first = prevNextInReviewQueue(QUEUE, "a");
  assert.equal(first.prevId, null);
  assert.equal(first.nextId, "c");

  const last = prevNextInReviewQueue(QUEUE, "d");
  assert.equal(last.prevId, "c");
  assert.equal(last.nextId, null);
});

test("prevNextInReviewQueue unknown id returns nulls", () => {
  const nav = prevNextInReviewQueue(QUEUE, "missing");
  assert.equal(nav.prevId, null);
  assert.equal(nav.nextId, null);
  assert.equal(nav.index, -1);
});
