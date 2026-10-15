import assert from "node:assert/strict";
import test from "node:test";

import {
  matchBandFromScore,
  scoreBankOpenItemMatch,
  subsetSumBundle,
} from "@/lib/bank-txn-match-score";

test("P2A-2: bands at 0.85 / 0.5", () => {
  assert.equal(matchBandFromScore(0.85), "ready");
  assert.equal(matchBandFromScore(0.849), "suggested");
  assert.equal(matchBandFromScore(0.5), "suggested");
  assert.equal(matchBandFromScore(0.499), "none");
});

test("P2A-2: direction mismatch never scores", () => {
  const r = scoreBankOpenItemMatch({
    bankAmountMinor: 10500,
    openAmountMinor: 10500,
    bankDateIso: "2026-05-10",
    openDateIso: "2026-05-01",
    bankDescription: "ACME LLC",
    partyName: "ACME LLC",
    bankReference: "INV-1",
    documentNumber: "INV-1",
    directionOk: false,
  });
  assert.equal(r.score, 0);
  assert.equal(r.band, "none");
  assert.ok(r.breakdown.warnings.includes("direction_mismatch"));
});

test("P2A-2: exact amount+name+ref is ready; cross-period flagged", () => {
  const r = scoreBankOpenItemMatch({
    bankAmountMinor: 10500,
    openAmountMinor: 10500,
    bankDateIso: "2026-08-20",
    openDateIso: "2026-05-01",
    bankDescription: "Desert Falcon payment",
    partyName: "Desert Falcon",
    bankReference: "SV-2026-0001",
    documentNumber: "SV-2026-0001",
    directionOk: true,
  });
  assert.ok(r.breakdown.warnings.includes("cross_period_gt_90d"));
  assert.ok(r.score > 0.5);
  const tight = scoreBankOpenItemMatch({
    bankAmountMinor: 10500,
    openAmountMinor: 10500,
    bankDateIso: "2026-05-02",
    openDateIso: "2026-05-01",
    bankDescription: "Desert Falcon payment",
    partyName: "Desert Falcon",
    bankReference: "SV-2026-0001",
    documentNumber: "SV-2026-0001",
    directionOk: true,
  });
  assert.equal(tight.band, "ready");
  assert.ok(tight.score >= 0.85);
});

test("P2A-2: subset-sum bundle for two invoices", () => {
  const opens = [10500, 5250, 99999];
  const idxs = subsetSumBundle(15750, opens, 0);
  assert.deepEqual(idxs, [0, 1]);
  assert.equal(subsetSumBundle(100, [30, 40], 0), null);
});
