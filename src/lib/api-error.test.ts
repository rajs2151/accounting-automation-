import assert from "node:assert/strict";
import test from "node:test";

import { apiErrorMessage } from "@/lib/api-error";

test("apiErrorMessage: known codes read as sentences, unknown server errors show a ref, never 'request failed'", () => {
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
