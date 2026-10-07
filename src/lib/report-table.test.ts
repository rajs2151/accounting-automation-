import assert from "node:assert/strict";
import test from "node:test";

import {
  allGroupIds,
  differenceRow,
  flattenReportRows,
  formatReportAmount,
  monthColumns,
  reportExportRows,
  tbToReportTree,
  type ReportRow,
} from "@/lib/report-table";

test("RPT-1: difference row only when totals differ", () => {
  assert.equal(differenceRow(150000, 150000), null);
  assert.deepEqual(differenceRow(150001, 150000), { differenceMinor: 1 });
  assert.deepEqual(differenceRow(0, 250), { differenceMinor: -250 });
});

test("RPT-1: amount format — blank zero, brackets for negatives on statements", () => {
  assert.equal(formatReportAmount(0), "");
  assert.equal(formatReportAmount(null), "");
  assert.equal(formatReportAmount(123456), "1,234.56");
  assert.equal(formatReportAmount(-123456, { brackets: true }), "(1,234.56)");
  assert.equal(formatReportAmount(-5), "-0.05");
  assert.equal(formatReportAmount(150_000, { abbreviate: true }), "1.5K");
  assert.equal(formatReportAmount(-250_000_000, { abbreviate: true, brackets: true }), "(2.5M)");
});

test("RPT-1: monthly column split, clipped to the range, across a year end", () => {
  assert.deepEqual(monthColumns("2026-04-15", "2026-06-10"), [
    { key: "2026-04", label: "Apr 2026", start: "2026-04-15", end: "2026-04-30" },
    { key: "2026-05", label: "May 2026", start: "2026-05-01", end: "2026-05-31" },
    { key: "2026-06", label: "Jun 2026", start: "2026-06-01", end: "2026-06-10" },
  ]);
  assert.deepEqual(
    monthColumns("2026-12-01", "2027-02-28").map((c) => [c.key, c.end]),
    [
      ["2026-12", "2026-12-31"],
      ["2027-01", "2027-01-31"],
      ["2027-02", "2027-02-28"],
    ],
  );
  assert.deepEqual(monthColumns("2026-05-01", "2026-05-31").length, 1);
  assert.deepEqual(monthColumns("2026-06-01", "2026-05-01"), [], "reversed range → none");
});

test("RPT-1: tree flatten honours expand state; expand all lists every group", () => {
  const rows: ReportRow[] = [
    { id: "g1", label: "Assets", values: {}, children: [{ id: "a1", label: "Bank", values: {} }] },
    { id: "g2", label: "Liabilities", values: {}, children: [{ id: "a2", label: "AP", values: {} }] },
  ];
  assert.deepEqual(flattenReportRows(rows, new Set()).map((r) => r.id), ["g1", "g2"]);
  assert.deepEqual(
    flattenReportRows(rows, new Set(["g2"])).map((r) => [r.id, r.depth]),
    [
      ["g1", 0],
      ["g2", 0],
      ["a2", 1],
    ],
  );
  assert.deepEqual(allGroupIds(rows), ["g1", "g2"]);
});

test("RPT-1: TB → report tree keeps TB's numbers exactly", () => {
  const acct = (id: string, code: string, cd: number, cc: number) => ({
    id, code, name: code, openingDebitMinor: 0, openingCreditMinor: 0,
    periodDebitMinor: cd, periodCreditMinor: cc, closingDebitMinor: cd, closingCreditMinor: cc,
  });
  const tb = {
    groups: [
      { key: "asset", label: "Assets", accounts: [acct("1", "1120", 150000, 0), acct("2", "1210", 5000, 0)],
        subtotalClosingDebitMinor: 155000, subtotalClosingCreditMinor: 0 },
      { key: "equity", label: "Equity", accounts: [acct("3", "3100", 0, 155000)],
        subtotalClosingDebitMinor: 0, subtotalClosingCreditMinor: 155000 },
    ],
    totalClosingDebit: 155000,
    totalClosingCredit: 155000,
  };
  const { rows, totals } = tbToReportTree(tb);
  assert.deepEqual(rows.map((r) => [r.label, r.values.closingDebit, r.values.closingCredit]), [
    ["Assets", 155000, 0],
    ["Equity", 0, 155000],
  ]);
  assert.equal(totals.closingDebit, 155000);
  assert.equal(totals.closingCredit, 155000);
  assert.deepEqual(rows[0].children!.map((c) => c.drill), [
    { kind: "account", accountId: "1" },
    { kind: "account", accountId: "2" },
  ]);
});

test("RPT-1: export rows carry the on-screen numbers, grand total and Difference row", () => {
  const columns = [
    { key: "closingDebit", label: "Debit" },
    { key: "closingCredit", label: "Credit" },
  ];
  const rows = [
    { id: "g", label: "Assets", values: { closingDebit: 155000 }, depth: 0 },
    { id: "a", code: "1120", label: "Bank", values: { closingDebit: 155000 }, depth: 1 },
  ];
  const balanced = reportExportRows({
    title: "Trial balance", company: "Test Co", periodLabel: "May 2026", preparedBy: "Omar",
    labelHeader: "Particulars", columns, rows,
    footer: [{ label: "Grand total", values: { closingDebit: 155000, closingCredit: 155000 } }],
    difference: { debitKey: "closingDebit", creditKey: "closingCredit", totals: { closingDebit: 155000, closingCredit: 155000 } },
  });
  assert.deepEqual(balanced.slice(0, 4), [["Trial balance"], ["Test Co"], ["May 2026 · AED"], ["Prepared by Omar"]]);
  assert.deepEqual(balanced.slice(5), [
    ["Particulars", "Debit", "Credit"],
    ["Assets", "1550.00", ""],
    ["  1120 Bank", "1550.00", ""],
    ["Grand total", "1550.00", "1550.00"],
  ]);
  const off = reportExportRows({
    title: "TB", company: "C", periodLabel: "P", labelHeader: "Particulars", columns, rows: [],
    difference: { debitKey: "closingDebit", creditKey: "closingCredit", totals: { closingDebit: 100, closingCredit: 90 } },
  });
  assert.deepEqual(off.at(-1), ["Difference", "0.10", ""]);
});
