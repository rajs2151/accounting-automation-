import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExtractedPartySignal,
  partyMismatchDiffs,
} from "@/lib/party-mismatch";

test("partyMismatchDiffs empty when names/TRNs match (normalised)", () => {
  const diffs = partyMismatchDiffs(
    { name: "Oasis  Retail LLC", trn: "100-123-456" },
    { id: "1", name: "Oasis Retail LLC", trn: "100123456" },
  );
  assert.equal(diffs.length, 0);
});

test("partyMismatchDiffs reports name and TRN when both differ", () => {
  const diffs = partyMismatchDiffs(
    { name: "New Co LLC", trn: "100000000000001" },
    { id: "1", name: "Oasis Retail LLC", trn: "100123456789012" },
  );
  assert.deepEqual(
    diffs.map((d) => d.field),
    ["name", "trn"],
  );
});

test("partyMismatchDiffs ignores missing side", () => {
  assert.equal(
    partyMismatchDiffs({ name: "X", trn: null }, { id: "1", name: "Y", trn: null }).length,
    1,
  );
  assert.equal(
    partyMismatchDiffs({ name: "X", trn: "1" }, { id: "1", name: "X", trn: null }).length,
    0,
  );
});

test("hasExtractedPartySignal", () => {
  assert.equal(hasExtractedPartySignal({ name: "", trn: "" }), false);
  assert.equal(hasExtractedPartySignal({ name: "Acme", trn: null }), true);
});
