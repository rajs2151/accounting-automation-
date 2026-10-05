/**
 * Map extraction field confidence (0–1) to a traffic-light tone for the review UI.
 * Display only — never used to auto-approve.
 */

export type ConfidenceTone = "green" | "amber" | "red";

/** Inclusive lower bounds. Below amber → red. Missing/NaN → no dot. */
export const CONFIDENCE_THRESHOLDS = {
  green: 0.85,
  amber: 0.6,
} as const;

/**
 * Map a 0–1 confidence score to green / amber / red.
 * Returns null when confidence is missing or not a finite number (no dot).
 */
export function confidenceTone(confidence: number | null | undefined): ConfidenceTone | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  if (confidence >= CONFIDENCE_THRESHOLDS.green) return "green";
  if (confidence >= CONFIDENCE_THRESHOLDS.amber) return "amber";
  return "red";
}

/**
 * Prefer an explicit field confidence; otherwise use the minimum word-box
 * confidence that falls inside the field bbox (when callers have that data).
 */
export function fieldConfidenceTone(opts: {
  fieldConfidence?: number | null;
  wordConfidences?: number[] | null;
}): ConfidenceTone | null {
  if (opts.fieldConfidence != null && Number.isFinite(opts.fieldConfidence)) {
    return confidenceTone(opts.fieldConfidence);
  }
  const words = (opts.wordConfidences || []).filter((c) => Number.isFinite(c));
  if (!words.length) return null;
  return confidenceTone(Math.min(...words));
}
