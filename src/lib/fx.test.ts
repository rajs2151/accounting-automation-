import assert from "node:assert/strict";
import test from "node:test";

import { aedFromOriginal, parseFxRateToScaled } from "@/lib/fx";

test("fx scaled rate converts without float drift on common UAE rates", () => {
  const r = Number(parseFxRateToScaled("3.6725"));
  assert.equal(aedFromOriginal(100, r), 367);
  assert.equal(aedFromOriginal(1, Number(parseFxRateToScaled("1"))), 1);
});
