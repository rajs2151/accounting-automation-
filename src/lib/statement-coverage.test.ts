import assert from "node:assert/strict";
import test from "node:test";

import {
  bankInstrumentType,
  computeStatementCoverage,
  ibanLast4,
  isBankAccountSetUp,
  normalizeIban,
  statementCoverageApplicable,
} from "@/lib/statement-coverage";

test("computeStatementCoverage merges overlap and reports day gaps", () => {
  const r = computeStatementCoverage([
    { from: "2026-04-01", to: "2026-04-30" },
    { from: "2026-04-15", to: "2026-05-15" },
    { from: "2026-06-01", to: "2026-06-30" },
  ]);
  assert.equal(r.coverageFrom, "2026-04-01");
  assert.equal(r.coverageTo, "2026-06-30");
  assert.deepEqual(r.gaps, [{ from: "2026-05-16", to: "2026-05-31" }]);
});

test("computeStatementCoverage adjacent periods have no gap", () => {
  const r = computeStatementCoverage([
    { from: "2026-01-01", to: "2026-01-31" },
    { from: "2026-02-01", to: "2026-02-28" },
  ]);
  assert.equal(r.gaps.length, 0);
  assert.equal(r.coverageFrom, "2026-01-01");
  assert.equal(r.coverageTo, "2026-02-28");
});

test("computeStatementCoverage empty", () => {
  assert.deepEqual(computeStatementCoverage([]), {
    coverageFrom: null,
    coverageTo: null,
    gaps: [],
  });
});

test("iban helpers and setup gate", () => {
  assert.equal(normalizeIban("AE07 0331 2345 6789"), "AE07033123456789");
  assert.equal(ibanLast4("AE07033123456789"), "6789");
  assert.equal(bankInstrumentType({ isBank: true, subType: "cash" }), "cash");
  assert.equal(bankInstrumentType({ isGateway: true }), "gateway");
  assert.equal(
    isBankAccountSetUp({ instrumentType: "bank", iban: null, ibanLast4: null }),
    false,
  );
  assert.equal(
    isBankAccountSetUp({ instrumentType: "bank", iban: "AE07033123456789" }),
    true,
  );
  assert.equal(isBankAccountSetUp({ instrumentType: "cash" }), true);
});

test("statementCoverageApplicable: setup + activity/balance only", () => {
  assert.equal(
    statementCoverageApplicable({
      instrumentType: "bank",
      setupOk: true,
      ledgerBalanceMinor: 0,
      hasPeriodActivity: false,
    }),
    false,
  );
  assert.equal(
    statementCoverageApplicable({
      instrumentType: "bank",
      setupOk: true,
      ledgerBalanceMinor: 100,
      hasPeriodActivity: false,
    }),
    true,
  );
  assert.equal(
    statementCoverageApplicable({
      instrumentType: "cash",
      setupOk: true,
      ledgerBalanceMinor: 100,
      hasPeriodActivity: true,
    }),
    false,
  );
});
