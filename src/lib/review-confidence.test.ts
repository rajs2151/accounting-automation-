import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIDENCE_THRESHOLDS,
  confidenceTone,
  fieldConfidenceTone,
} from "@/lib/review-confidence";

test("confidenceTone maps green / amber / red at thresholds", () => {
  assert.equal(confidenceTone(CONFIDENCE_THRESHOLDS.green), "green");
  assert.equal(confidenceTone(0.99), "green");
  assert.equal(confidenceTone(CONFIDENCE_THRESHOLDS.amber), "amber");
  assert.equal(confidenceTone(0.7), "amber");
  assert.equal(confidenceTone(CONFIDENCE_THRESHOLDS.amber - 0.01), "red");
  assert.equal(confidenceTone(0), "red");
});

test("confidenceTone returns null when data is missing", () => {
  assert.equal(confidenceTone(null), null);
  assert.equal(confidenceTone(undefined), null);
  assert.equal(confidenceTone(Number.NaN), null);
});

test("fieldConfidenceTone prefers field confidence over word boxes", () => {
  assert.equal(
    fieldConfidenceTone({ fieldConfidence: 0.9, wordConfidences: [0.1, 0.2] }),
    "green",
  );
  assert.equal(fieldConfidenceTone({ wordConfidences: [0.9, 0.55] }), "red");
  assert.equal(fieldConfidenceTone({ wordConfidences: [0.9, 0.88] }), "green");
  assert.equal(fieldConfidenceTone({}), null);
});
