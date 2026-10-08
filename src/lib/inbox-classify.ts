/** Shared inbox/document queue classification for dashboard + Sales/Purchases/Inbox. */

export type InboxQueueBucket = "sales" | "purchase" | "statement" | "other";

/**
 * Classify an inbox intended/detected type into a dashboard queue bucket.
 * Matches dashboard SoT: statements excluded from sales/purchase counts;
 * expense receipts and unknown types land on Purchases; credit/debit notes on Sales.
 */
export function inboxQueueBucket(type: string | null | undefined): InboxQueueBucket {
  const t = String(type || "").toLowerCase();
  if (t.includes("bank") || t.includes("statement") || t.includes("card") || t.includes("gateway")) {
    return "statement";
  }
  if (t.includes("purchase") || t.includes("bill") || t === "payment" || t === "receipt" || !t) {
    return "purchase";
  }
  if (t.includes("sales") || t.includes("invoice") || t.includes("credit") || t.includes("debit")) {
    return "sales";
  }
  return "other";
}

/** Deep-link for a documents-to-review bucket (draft docs + inbox needs_review). */
export function documentsToReviewHref(bucket: "purchase" | "sales" | "notes" | "statement"): string {
  switch (bucket) {
    case "purchase":
      return "/books/purchases?tab=needs_review";
    case "sales":
      return "/books/sales?tab=needs_review";
    case "notes":
      return "/books/sales?tab=needs_review&docType=note";
    case "statement":
      return "/books/statements?status=needs_review";
  }
}

/**
 * Filename near-duplicate heuristic: same stem ignoring trailing (N), copy, final, spaces.
 * e.g. "invoice.pdf" ≈ "invoice (1).pdf" ≈ "invoice-copy.pdf"
 */
export function filenameNearDuplicateKey(filename: string): string {
  let base = String(filename || "").trim().toLowerCase();
  base = base.replace(/\.[a-z0-9]+$/i, "");
  base = base
    .replace(/\s*\(\d+\)\s*$/g, "")
    .replace(/[-_\s]*(copy|final|signed|v\d+)\s*$/gi, "")
    .replace(/[^a-z0-9]+/g, "");
  return base;
}

export function findFilenameNearDuplicates(
  rows: Array<{ id: string; filename: string }>,
): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const r of rows) {
    const key = filenameNearDuplicateKey(r.filename);
    if (!key) continue;
    const list = byKey.get(key) || [];
    list.push(r.id);
    byKey.set(key, list);
  }
  const out = new Map<string, string[]>();
  for (const [, ids] of byKey) {
    if (ids.length < 2) continue;
    for (const id of ids) out.set(id, ids.filter((x) => x !== id));
  }
  return out;
}
