/**
 * Prev/next through the company needs-review inbox queue.
 * List order matches the inbox API: created_at DESC (newest first).
 */

export type ReviewQueueItem = {
  id: string;
  status: string;
  createdAt?: string;
};

/**
 * Filter to needs_review and keep created_at DESC order.
 * If createdAt is present on every item, sort DESC; otherwise preserve input order
 * (callers should pass the inbox list as returned by the API).
 */
export function needsReviewQueue(items: ReviewQueueItem[]): ReviewQueueItem[] {
  const filtered = items.filter((i) => i.status === "needs_review");
  const allHaveDates = filtered.every((i) => i.createdAt);
  if (!allHaveDates) return filtered;
  return [...filtered].sort((a, b) => {
    const ta = Date.parse(a.createdAt!);
    const tb = Date.parse(b.createdAt!);
    return tb - ta;
  });
}

export function prevNextInReviewQueue(
  items: ReviewQueueItem[],
  currentId: string,
): { prevId: string | null; nextId: string | null; index: number } {
  const queue = needsReviewQueue(items);
  const index = queue.findIndex((i) => i.id === currentId);
  if (index < 0) {
    return { prevId: null, nextId: null, index: -1 };
  }
  return {
    index,
    // Prev = newer (earlier in DESC list); next = older (later in DESC list).
    prevId: index > 0 ? queue[index - 1]!.id : null,
    nextId: index < queue.length - 1 ? queue[index + 1]!.id : null,
  };
}
