import assert from "node:assert/strict";
import test from "node:test";

import { canShowWorkingAs, workingAsLabel } from "@/lib/working-as-label";

test("workingAsLabel uses name · role, never a bare UUID when name exists", () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const label = workingAsLabel({ id, name: "Omar", role: "accountant" });
  assert.equal(label, "Omar · accountant");
  assert.doesNotMatch(label, /^[0-9a-f-]{36}$/i);
});

test("workingAsLabel collapsed shows name only", () => {
  assert.equal(
    workingAsLabel({ id: "x", name: "Layla", role: "approver" }, { collapsed: true }),
    "Layla",
  );
});

test("canShowWorkingAs: admin always; others only in development", () => {
  assert.equal(canShowWorkingAs("admin", "production"), true);
  assert.equal(canShowWorkingAs("accountant", "production"), false);
  assert.equal(canShowWorkingAs("accountant", "development"), true);
});
