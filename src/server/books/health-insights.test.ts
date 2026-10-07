/**
 * P7-3: pure insight rule tests (hand-chosen thresholds).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHealthInsights,
  momPctChange,
  overdueConcentration,
} from "@/server/books/health-insights";

test("P7-3: momPctChange and overdue concentration math", () => {
  assert.equal(momPctChange(127, 100), 27);
  assert.equal(momPctChange(50, 0), null);

  const conc = overdueConcentration(
    [
      { partyId: "a", partyName: "Alpha", overdueMinor: 61_000 },
      { partyId: "b", partyName: "Beta", overdueMinor: 39_000 },
    ],
    100_000,
  );
  assert.ok(conc);
  assert.equal(conc!.parties.length, 1);
  assert.equal(conc!.parties[0].partyName, "Alpha");
  assert.equal(conc!.shareBps, 6100);
});

test("P7-3: insight triggers for runway, DSO, concentration, cost mover", () => {
  const insights = buildHealthInsights({
    runwayMonthsMilli: 4_500,
    dsoDays: 52,
    arOverdueMinor: 100_000,
    overdueByParty: [
      { partyId: "1", partyName: "Client A", overdueMinor: 61_000 },
      { partyId: "2", partyName: "Client B", overdueMinor: 39_000 },
    ],
    costMovers: [
      { code: "5107", name: "AWS", currentMinor: 127_00, priorMinor: 100_00, momPct: 27 },
    ],
  });
  const ids = insights.map((i) => i.id);
  assert.ok(ids.includes("runway_under_6"));
  assert.ok(ids.includes("dso_above_45"));
  assert.ok(ids.includes("overdue_ar_concentration"));
  assert.ok(ids.includes("cost_mover_5107"));
  assert.match(insights.find((i) => i.id === "overdue_ar_concentration")!.title, /61%/);
});

test("P7-3: no insights when metrics are healthy", () => {
  const insights = buildHealthInsights({
    runwayMonthsMilli: null,
    dsoDays: 30,
    arOverdueMinor: 0,
    overdueByParty: [],
    costMovers: [{ code: "5107", name: "Rent", currentMinor: 100, priorMinor: 100, momPct: 0 }],
  });
  assert.equal(insights.length, 0);
});
