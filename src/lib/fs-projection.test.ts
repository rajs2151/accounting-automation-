import assert from "node:assert/strict";
import test from "node:test";

import { buildProjectedPnlColumn } from "@/lib/fs-projection";

test("projected P&L puts each forecast in its own section and computes profit like the P&L", () => {
  const accounts = [
    { id: "rev", code: "4100", name: "Service revenue", accountType: "income", statementLine: "PL_revenue" },
    { id: "rent", code: "6200", name: "Rent", accountType: "expense", statementLine: "PL_opex" },
    { id: "dep", code: "6800", name: "Depreciation", accountType: "expense", statementLine: "PL_opex", subType: "depr" },
    { id: "int", code: "7100", name: "Interest income", accountType: "income", statementLine: "PL_other" },
  ];
  const col = buildProjectedPnlColumn(
    [
      { accountId: "rev", amountMinor: 100_000 },
      { accountId: "rent", amountMinor: 30_000 },
      { accountId: "dep", amountMinor: 5_000 },
      { accountId: "int", amountMinor: 2_000 },
    ],
    accounts,
  );
  const total = (k: string) => col.sections.find((s) => s.key === k)!.totalMinor;
  assert.equal(total("PL_revenue"), 100_000);
  assert.equal(total("PL_opex"), 30_000, "rent is an expense, not revenue");
  assert.equal(total("PL_depr"), 5_000, "depreciation counted once, in its own section");
  assert.equal(col.ebitdaMinor, 70_000);
  assert.equal(col.ebitMinor, 65_000);
  assert.equal(col.netProfitMinor, 67_000);
});
