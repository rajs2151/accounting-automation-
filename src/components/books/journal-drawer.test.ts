import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAuditAction,
  journalLineSide,
  linkedEntryLabel,
} from "@/components/books/journal-drawer";

test("P4-2: journalLineSide from amounts", () => {
  assert.equal(journalLineSide({ debitMinor: 100, creditMinor: 0 }), "debit");
  assert.equal(journalLineSide({ debitMinor: 0, creditMinor: 50 }), "credit");
});

test("P4-2: formatAuditAction title-cases", () => {
  assert.equal(formatAuditAction("post"), "Post");
  assert.equal(formatAuditAction("soft_delete_expense_draft"), "Soft Delete Expense Draft");
});

test("P4-2: linkedEntryLabel prefers entry no", () => {
  assert.equal(linkedEntryLabel("JV-2026-0001", "aaaaaaaa-bbbb"), "JV-2026-0001");
  assert.match(linkedEntryLabel(null, "aaaaaaaa-bbbb-cccc"), /^aaaaaaaa…$/);
  assert.equal(linkedEntryLabel(null, null), "—");
});
