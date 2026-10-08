import assert from "node:assert/strict";
import test from "node:test";

import { parseControlDriftLabel } from "@/lib/dashboard-money-labels";

test("parseControlDriftLabel extracts control and open from AED issues label", () => {
  const d = parseControlDriftLabel(
    "AR control (1210) 210.00 AED ≠ open items 0.00 AED",
  );
  assert.ok(d);
  assert.equal(d!.controlMinor, 21000);
  assert.equal(d!.openMinor, 0);
  assert.equal(d!.driftMinor, 21000);
});

test("parseControlDriftLabel still accepts legacy fils labels", () => {
  const d = parseControlDriftLabel(
    "AR control (1210) 21000 fils ≠ open items 0 fils",
  );
  assert.ok(d);
  assert.equal(d!.controlMinor, 21000);
});

test("parseControlDriftLabel returns null when label missing", () => {
  assert.equal(parseControlDriftLabel(undefined), null);
});
