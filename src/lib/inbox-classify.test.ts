import assert from "node:assert/strict";
import test from "node:test";

import {
  filenameNearDuplicateKey,
  findFilenameNearDuplicates,
  inboxQueueBucket,
} from "@/lib/inbox-classify";

test("inboxQueueBucket maps types to queues", () => {
  assert.equal(inboxQueueBucket("sales_invoice"), "sales");
  assert.equal(inboxQueueBucket("purchase_bill"), "purchase");
  assert.equal(inboxQueueBucket("receipt"), "purchase");
  assert.equal(inboxQueueBucket("credit_note"), "sales");
  assert.equal(inboxQueueBucket("bank_statement"), "statement");
  assert.equal(inboxQueueBucket("gateway_statement"), "statement");
  assert.equal(inboxQueueBucket(""), "purchase");
});

test("filenameNearDuplicateKey collapses copy suffixes", () => {
  assert.equal(filenameNearDuplicateKey("invoice.pdf"), filenameNearDuplicateKey("invoice (1).pdf"));
  assert.equal(filenameNearDuplicateKey("bill-copy.PDF"), filenameNearDuplicateKey("bill.pdf"));
});

test("findFilenameNearDuplicates links peers", () => {
  const map = findFilenameNearDuplicates([
    { id: "a", filename: "inv.pdf" },
    { id: "b", filename: "inv (2).pdf" },
    { id: "c", filename: "other.pdf" },
  ]);
  assert.deepEqual(map.get("a"), ["b"]);
  assert.equal(map.has("c"), false);
});
