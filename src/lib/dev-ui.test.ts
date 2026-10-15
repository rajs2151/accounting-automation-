import assert from "node:assert/strict";
import test from "node:test";

import { isDevUiEnabled } from "./dev-ui";

test("isDevUiEnabled is true only for development", () => {
  assert.equal(isDevUiEnabled("development"), true);
  assert.equal(isDevUiEnabled("production"), false);
  assert.equal(isDevUiEnabled("test"), false);
  assert.equal(isDevUiEnabled(undefined), false);
});
