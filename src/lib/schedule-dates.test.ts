import assert from "node:assert/strict";
import test from "node:test";

import { firstOfNextMonthIso, firstOfNextMonthUtc } from "@/lib/schedule-dates";

test("P4-4: firstOfNextMonthIso rolls within year", () => {
  assert.equal(firstOfNextMonthIso("2026-05-15"), "2026-06-01");
  assert.equal(firstOfNextMonthIso("2026-01-01"), "2026-02-01");
});

test("P4-4: firstOfNextMonthIso rolls Dec → Jan next year", () => {
  assert.equal(firstOfNextMonthIso("2026-12-31"), "2027-01-01");
});

test("P4-4: firstOfNextMonthUtc is midnight UTC on that day", () => {
  const d = firstOfNextMonthUtc("2026-05-20");
  assert.equal(d.toISOString(), "2026-06-01T00:00:00.000Z");
});
