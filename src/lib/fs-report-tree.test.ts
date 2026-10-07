import assert from "node:assert/strict";
import test from "node:test";

import { pnlToReportTree } from "@/lib/fs-report-tree";

test("P6-2: P&L tree keeps hand subtotals and account drill ids", () => {
  const tree = pnlToReportTree([
    {
      column: { key: "m1", label: "May 2026", from: "2026-05-01", to: "2026-05-31" },
      sections: [
        {
          key: "PL_revenue",
          label: "Revenue",
          totalMinor: 10_000,
          accounts: [{ accountId: "a-rev", code: "4100", name: "Service revenue", amountMinor: 10_000 }],
        },
        {
          key: "PL_cogs",
          label: "Cost of sales",
          totalMinor: 2_000,
          accounts: [{ accountId: "a-cogs", code: "5100", name: "COGS", amountMinor: 2_000 }],
        },
        {
          key: "PL_opex",
          label: "Operating expenses",
          totalMinor: 1_000,
          accounts: [{ accountId: "a-rent", code: "6200", name: "Rent", amountMinor: 1_000 }],
        },
        { key: "PL_depr", label: "Depreciation & amortisation", totalMinor: 0, accounts: [] },
        { key: "PL_other", label: "Other income / finance", totalMinor: 0, accounts: [] },
        { key: "PL_tax", label: "Corporate tax", totalMinor: 0, accounts: [] },
      ],
      grossProfitMinor: 8_000,
      ebitdaMinor: 7_000,
      ebitMinor: 7_000,
      ebtMinor: 7_000,
      netProfitMinor: 7_000,
    },
  ]);
  assert.equal(tree.columns[0].label, "May 2026");
  const gp = tree.rows.find((r) => r.id === "sub:gp");
  assert.equal(gp?.values.m1, 8_000);
  const rent = tree.rows
    .flatMap((r) => r.children || [])
    .find((r) => r.code === "6200");
  assert.equal(rent?.values.m1, 1_000);
  assert.equal((rent?.drill as { accountId: string }).accountId, "a-rent");
  assert.equal(tree.footer[0].values.m1, 7_000);
});
