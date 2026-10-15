import assert from "node:assert/strict";
import test from "node:test";

import {
  netFromGrossAdvanceMinor,
  partyIsUaeTaxableForAdvance,
  splitAdvanceApply,
  vatFromGrossAdvanceMinor,
} from "@/lib/advance-vat";

test("D1: VAT from gross advance (5/105 floor)", () => {
  // 1,050.00 AED → VAT 50.00
  assert.equal(vatFromGrossAdvanceMinor(105_000), 5_000);
  assert.equal(netFromGrossAdvanceMinor(105_000), 100_000);
  assert.equal(vatFromGrossAdvanceMinor(0), 0);
});

test("D1: taxable party rules", () => {
  assert.equal(partyIsUaeTaxableForAdvance({ trn: null }), false);
  assert.equal(
    partyIsUaeTaxableForAdvance({ trn: "100000000000003", country: "AE", zone: "mainland" }),
    true,
  );
  assert.equal(
    partyIsUaeTaxableForAdvance({ trn: "100000000000003", country: "AE", zone: "free_zone" }),
    true,
  );
  assert.equal(
    partyIsUaeTaxableForAdvance({
      trn: "100000000000003",
      country: "AE",
      zone: "designated_zone",
    }),
    false,
  );
  assert.equal(
    partyIsUaeTaxableForAdvance({ trn: "100000000000003", country: "US", zone: "mainland" }),
    false,
  );
});

test("D1: splitAdvanceApply consumes all VAT on full apply", () => {
  const full = splitAdvanceApply({
    applyGrossOriginalMinor: 105_000,
    remainingNetOriginalMinor: 100_000,
    remainingVatOriginalMinor: 5_000,
  });
  assert.equal(full.netOriginalMinor, 100_000);
  assert.equal(full.vatOriginalMinor, 5_000);

  const half = splitAdvanceApply({
    applyGrossOriginalMinor: 52_500,
    remainingNetOriginalMinor: 100_000,
    remainingVatOriginalMinor: 5_000,
  });
  assert.equal(half.netOriginalMinor + half.vatOriginalMinor, 52_500);
  assert.ok(half.vatOriginalMinor > 0);
});
