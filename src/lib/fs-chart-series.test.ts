/**
 * P6-4c: chart series amounts + % change (pure).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildFsChartSeries } from "@/lib/fs-chart-series";

test("P6-4c: revenue series and pct change", () => {
  const series = buildFsChartSeries(
    [
      {
        column: { key: "m1", label: "May 2026" },
        sections: [{ key: "PL_revenue", totalMinor: 100_00 }],
        netProfitMinor: 40_00,
      },
      {
        column: { key: "m2", label: "Jun 2026" },
        sections: [{ key: "PL_revenue", totalMinor: 150_00 }],
        netProfitMinor: 60_00,
      },
    ],
    "revenue",
  );
  assert.equal(series[0].amountMinor, 100_00);
  assert.equal(series[1].amountMinor, 150_00);
  assert.equal(series[0].pctChange, null);
  // (15000-10000)/10000 = 50%
  assert.equal(series[1].pctChange, 50);
});
