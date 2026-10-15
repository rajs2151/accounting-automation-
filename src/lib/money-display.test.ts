import assert from "node:assert/strict";
import test from "node:test";

import { controlDriftInsightBody, controlDriftIssueLabel, formatMoneyAmount } from "@/lib/money-display";

test("formatMoneyAmount never says fils", () => {
  assert.equal(formatMoneyAmount({ amountMinor: 21000 }), "210.00 AED");
  assert.doesNotMatch(formatMoneyAmount({ amountMinor: 21000 }), /fils/i);
});

test("control drift labels use AED", () => {
  const label = controlDriftIssueLabel(
    "AR",
    { amountMinor: 21000 },
    { amountMinor: 0 },
  );
  assert.match(label, /210\.00 AED/);
  assert.match(label, /open items 0\.00 AED/);
  assert.doesNotMatch(label, /fils/i);
  assert.doesNotMatch(controlDriftInsightBody("AR", 21000), /fils/i);
});
