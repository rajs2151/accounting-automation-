import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_KNOWN_STATUS_KEYS,
  balanceCheckLabel,
  docTypeLabel,
  documentStatusLabel,
  extractionStatusLabel,
  inboxStatusLabel,
  statementStatusLabel,
} from "@/lib/status-labels";

test("known inbox statuses map to human labels", () => {
  assert.equal(inboxStatusLabel("needs_review").label, "Needs review");
  assert.equal(inboxStatusLabel("queued").tone, "neutral");
  assert.equal(inboxStatusLabel("", true).label, "Duplicate");
});

test("every enumerated server status has a human label", () => {
  assert.ok(ALL_KNOWN_STATUS_KEYS.length >= 20);
  assert.equal(inboxStatusLabel("needs_review").label, "Needs review");
  assert.equal(documentStatusLabel("posted").label, "Posted");
  assert.equal(statementStatusLabel("confirmed").label, "Confirmed");
  assert.equal(balanceCheckLabel("ok").label, "Balanced");
});

test("unknown status falls back to raw value", () => {
  assert.equal(docTypeLabel("unknown_type_xyz").label, "unknown_type_xyz");
  assert.equal(documentStatusLabel("future_status").label, "future_status");
});
