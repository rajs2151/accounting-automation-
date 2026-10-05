import assert from "node:assert/strict";
import test from "node:test";

import {
  formatOffBy,
  maskIbanDisplay,
  statementBalanceBadgeLabel,
} from "@/lib/iban-display";

test("maskIbanDisplay masks to AE07 **** 3456", () => {
  assert.equal(maskIbanDisplay("AE070331234567890123456"), "AE07 **** 3456");
  assert.equal(maskIbanDisplay("ae07 0331 2345 6789 0123 456"), "AE07 **** 3456");
  assert.equal(maskIbanDisplay(null), "—");
  assert.equal(maskIbanDisplay(""), "—");
  assert.equal(maskIbanDisplay("AE07"), "AE07");
});

test("formatOffBy formats absolute fils difference", () => {
  assert.equal(formatOffBy(1240), "Off by 12.40");
  assert.equal(formatOffBy(-500), "Off by 5.00");
  assert.equal(formatOffBy(0), "Off by 0.00");
});

test("statementBalanceBadgeLabel Balanced vs Off by", () => {
  assert.equal(
    statementBalanceBadgeLabel({
      openingMinor: 100_000,
      closingMinor: 130_000,
      sumDebitMinor: 20_000,
      sumCreditMinor: 50_000,
    }),
    "Balanced",
  );
  assert.equal(
    statementBalanceBadgeLabel({
      openingMinor: 100_000,
      closingMinor: 130_000,
      sumDebitMinor: 20_000,
      sumCreditMinor: 49_000,
    }),
    "Off by 10.00",
  );
  assert.equal(
    statementBalanceBadgeLabel({
      openingMinor: 0,
      closingMinor: 0,
      sumDebitMinor: 0,
      sumCreditMinor: 0,
      empty: true,
    }),
    "No rows",
  );
});
