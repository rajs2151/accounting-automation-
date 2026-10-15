import assert from "node:assert/strict";
import test from "node:test";

import { defaultIssueDateIso, dueDateFromTerms } from "@/lib/default-issue-date";

test("defaultIssueDateIso: today when today is in an open period", () => {
  assert.equal(
    defaultIssueDateIso({
      todayIso: "2026-05-20",
      selectedPeriodId: "may",
      periods: [
        { id: "apr", periodStart: "2026-04-01", periodEnd: "2026-04-30", status: "LOCKED" },
        { id: "may", periodStart: "2026-05-01", periodEnd: "2026-05-31", status: "OPEN" },
      ],
    }),
    "2026-05-20",
  );
});

test("defaultIssueDateIso: selected period end when today is outside all open periods", () => {
  assert.equal(
    defaultIssueDateIso({
      todayIso: "2026-10-08",
      selectedPeriodId: "may",
      periods: [
        { id: "may", periodStart: "2026-05-01", periodEnd: "2026-05-31", status: "OPEN" },
        { id: "jun", periodStart: "2026-06-01", periodEnd: "2026-06-30", status: "OPEN" },
      ],
    }),
    "2026-05-31",
  );
});

test("dueDateFromTerms: 30-day terms", () => {
  assert.equal(dueDateFromTerms("2026-01-28", 30), "2026-02-27");
  assert.equal(dueDateFromTerms("2026-01-28", null), null);
});
