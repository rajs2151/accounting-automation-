import assert from "node:assert/strict";
import test from "node:test";

import { apiErrorMessage } from "@/lib/api-error";

test("apiErrorMessage: known codes read as sentences, unknown server errors show a ref, never 'request failed'", () => {
  assert.equal(
    apiErrorMessage({ error: "c2_bank_accounts_migration_required" }),
    "Banking isn’t available until the latest database update is applied. Ask your admin to update the app.",
  );
  assert.equal(
    apiErrorMessage({ error: "post_preparer_cannot_approve" }),
    "You prepared this document, so someone else must approve it.",
  );
  assert.equal(
    apiErrorMessage({ error: "internal_error", ref: "a1b2c3d4" }),
    "Something went wrong (ref a1b2c3d4). Please try again.",
  );
  assert.equal(apiErrorMessage({ error: "some_new_code" }), "Some new code");
  assert.equal(apiErrorMessage(null, "Fallback"), "Fallback");
  assert.equal(apiErrorMessage({}), "Something went wrong. Please try again.");
  for (const body of [{ error: "internal_error" }, { error: "request_failed" }, undefined]) {
    assert.doesNotMatch(apiErrorMessage(body), /request failed/i);
  }
});

test("apiErrorMessage: Phase 3-5 codes and code:detail codes read as sentences", () => {
  assert.equal(
    apiErrorMessage({ error: "entry_date_outside_period" }),
    "The date is outside the selected period. Pick a date inside the period, or switch period.",
  );
  assert.equal(
    apiErrorMessage({ error: "year_has_open_periods:Apr 2026,May 2026" }),
    "Lock these months before closing the year: Apr 2026, May 2026.",
  );
  assert.equal(apiErrorMessage({ error: "fx_rate_missing:USD" }), "Enter the closing exchange rate for: USD.");
  assert.equal(apiErrorMessage({ error: "some_unknown_code" }), "Some unknown code");
});

test("ING-1 codes read as sentences, with or without a detail", () => {
  assert.match(apiErrorMessage({ error: "fx_rate_required:USD" }), /Settings → FX rates .*for: USD\.$/);
  assert.match(apiErrorMessage({ error: "fx_rate_required" }), /for\.$/);
  assert.match(apiErrorMessage({ error: "control_account_forbidden:1210" }), /manual entry.*Account: 1210\.$/);
  assert.match(apiErrorMessage({ error: "control_account_requires_open_item:2110" }), /Account: 2110\.$/);
});
