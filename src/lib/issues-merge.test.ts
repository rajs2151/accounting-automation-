import assert from "node:assert/strict";
import test from "node:test";

import { mergeIssuesWithCloseGates, type BooksIssue } from "@/server/books/dashboard";

test("mergeIssuesWithCloseGates adds failing gates and skips ar_ap_tieout when drift present", () => {
  const base: BooksIssue[] = [
    {
      kind: "ar_control_vs_open_items",
      label: "AR drift",
      href: "/books",
      refId: "ar",
    },
  ];
  const merged = mergeIssuesWithCloseGates(base, [
    {
      key: "ar_ap_tieout",
      label: "AR/AP tie-out",
      status: "fail",
      blocking: true,
      href: "/books/close",
    },
    {
      key: "inbox_unreviewed",
      label: "Inbox",
      status: "fail",
      blocking: true,
      href: "/books/inbox",
    },
    {
      key: "bank_recon",
      label: "Bank recon",
      status: "pass",
      blocking: true,
    },
  ]);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((i) => i.refId === "inbox_unreviewed"));
  assert.ok(!merged.some((i) => i.refId === "ar_ap_tieout"));
});
