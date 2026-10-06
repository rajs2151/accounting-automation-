/** P2A-2: weighted bank↔open-item match score (0–1) with breakdown. Pure / client-safe. */

export type MatchScoreWeights = {
  amount: number;
  date: number;
  name: number;
  reference: number;
};

export const DEFAULT_MATCH_WEIGHTS: MatchScoreWeights = {
  amount: 0.45,
  date: 0.2,
  name: 0.2,
  reference: 0.15,
};

export type MatchScoreBreakdown = {
  amount: number;
  date: number;
  name: number;
  reference: number;
  warnings: string[];
};

export type MatchBand = "ready" | "suggested" | "none";

export function matchBandFromScore(score: number): MatchBand {
  if (score >= 0.85) return "ready";
  if (score >= 0.5) return "suggested";
  return "none";
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Normalise party / narration for loose contains matching. */
export function normalizeMatchText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .trim();
}

export function scoreAmountFit(bankMinor: number, openMinor: number): number {
  if (bankMinor <= 0 || openMinor <= 0) return 0;
  if (bankMinor === openMinor) return 1;
  const ratio = Math.min(bankMinor, openMinor) / Math.max(bankMinor, openMinor);
  // Partial payment (bank < open) still scores well for N:1.
  if (bankMinor < openMinor) return clamp01(0.55 + 0.45 * ratio);
  // Bank > open (needs split / fee) — weaker single-item score.
  return clamp01(0.35 + 0.4 * ratio);
}

/** Days apart; 0 days = 1, decays to 0 at 90+ days. Flags cross-period beyond 90. */
export function scoreDateFit(
  bankDateIso: string | null,
  openDateIso: string | null,
): { score: number; crossPeriod: boolean; daysApart: number | null } {
  if (!bankDateIso || !openDateIso) return { score: 0.4, crossPeriod: false, daysApart: null };
  const a = Date.parse(bankDateIso.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(openDateIso.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { score: 0.4, crossPeriod: false, daysApart: null };
  }
  const days = Math.abs(Math.round((a - b) / 86400000));
  const crossPeriod = days > 90;
  if (days === 0) return { score: 1, crossPeriod, daysApart: days };
  if (days <= 7) return { score: 0.9, crossPeriod, daysApart: days };
  if (days <= 30) return { score: 0.7, crossPeriod, daysApart: days };
  if (days <= 90) return { score: 0.45, crossPeriod, daysApart: days };
  return { score: 0.15, crossPeriod, daysApart: days };
}

export function scoreNameFit(bankText: string, partyName: string): number {
  const a = normalizeMatchText(bankText);
  const b = normalizeMatchText(partyName);
  if (!a || !b) return 0.25;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const atoks = new Set(a.split(" ").filter((t) => t.length > 2));
  const btoks = b.split(" ").filter((t) => t.length > 2);
  if (btoks.length === 0) return 0.25;
  let hit = 0;
  for (const t of btoks) if (atoks.has(t)) hit += 1;
  return clamp01(hit / btoks.length);
}

export function scoreReferenceFit(bankRef: string, docNumber: string | null): number {
  const a = normalizeMatchText(bankRef);
  const b = normalizeMatchText(docNumber || "");
  if (!a || !b) return 0.3;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  return 0.2;
}

export function scoreBankOpenItemMatch(input: {
  bankAmountMinor: number;
  openAmountMinor: number;
  bankDateIso: string | null;
  openDateIso: string | null;
  bankDescription: string;
  partyName: string;
  bankReference: string | null;
  documentNumber: string | null;
  /** Receipt expects money in; payment money out — caller enforces; if false → score 0. */
  directionOk: boolean;
  weights?: MatchScoreWeights;
}): { score: number; band: MatchBand; breakdown: MatchScoreBreakdown } {
  const w = input.weights || DEFAULT_MATCH_WEIGHTS;
  const warnings: string[] = [];
  if (!input.directionOk) {
    return {
      score: 0,
      band: "none",
      breakdown: { amount: 0, date: 0, name: 0, reference: 0, warnings: ["direction_mismatch"] },
    };
  }
  const amount = scoreAmountFit(input.bankAmountMinor, input.openAmountMinor);
  const dateFit = scoreDateFit(input.bankDateIso, input.openDateIso);
  if (dateFit.crossPeriod) warnings.push("cross_period_gt_90d");
  const name = scoreNameFit(input.bankDescription, input.partyName);
  const reference = scoreReferenceFit(
    `${input.bankReference || ""} ${input.bankDescription}`,
    input.documentNumber,
  );
  const score = clamp01(
    w.amount * amount + w.date * dateFit.score + w.name * name + w.reference * reference,
  );
  return {
    score: Math.round(score * 10000) / 10000,
    band: matchBandFromScore(score),
    breakdown: {
      amount: Math.round(amount * 10000) / 10000,
      date: Math.round(dateFit.score * 10000) / 10000,
      name: Math.round(name * 10000) / 10000,
      reference: Math.round(reference * 10000) / 10000,
      warnings,
    },
  };
}

/**
 * Greedy subset of open items whose amounts sum near bankMinor (partial-payment / 1:N bundle).
 * Returns indices into `opens` or null if no useful bundle (size>=2 within tolerance).
 */
export function subsetSumBundle(
  bankMinor: number,
  opens: number[],
  toleranceMinor = 0,
): number[] | null {
  if (bankMinor <= 0 || opens.length < 2) return null;
  const indexed = opens.map((amt, i) => ({ amt, i })).filter((x) => x.amt > 0);
  indexed.sort((a, b) => b.amt - a.amt);
  // Meet-in-the-middle for n<=20; else greedy.
  if (indexed.length <= 16) {
    const n = indexed.length;
    const half = Math.floor(n / 2);
    const left = indexed.slice(0, half);
    const right = indexed.slice(half);
    type Sum = { sum: number; mask: number };
    function enumSums(arr: typeof indexed): Sum[] {
      const out: Sum[] = [{ sum: 0, mask: 0 }];
      for (let i = 0; i < arr.length; i++) {
        const cur = out.length;
        for (let j = 0; j < cur; j++) {
          out.push({ sum: out[j]!.sum + arr[i]!.amt, mask: out[j]!.mask | (1 << i) });
        }
      }
      return out;
    }
    const L = enumSums(left);
    const R = enumSums(right);
    R.sort((a, b) => a.sum - b.sum);
    let best: { total: number; lMask: number; rMask: number } | null = null;
    for (const l of L) {
      const need = bankMinor - l.sum;
      let lo = 0;
      let hi = R.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (R[mid]!.sum < need - toleranceMinor) lo = mid + 1;
        else hi = mid - 1;
      }
      for (let k = Math.max(0, lo - 1); k < R.length && k <= lo + 2; k++) {
        const total = l.sum + R[k]!.sum;
        const err = Math.abs(total - bankMinor);
        if (err > toleranceMinor) continue;
        const bits =
          popcount(l.mask) + popcount(R[k]!.mask);
        if (bits < 2) continue;
        if (!best || err < Math.abs(best.total - bankMinor) || bits > popcount(best.lMask) + popcount(best.rMask)) {
          best = { total, lMask: l.mask, rMask: R[k]!.mask };
        }
      }
    }
    if (!best) return null;
    const idxs: number[] = [];
    for (let i = 0; i < left.length; i++) if (best.lMask & (1 << i)) idxs.push(left[i]!.i);
    for (let i = 0; i < right.length; i++) if (best.rMask & (1 << i)) idxs.push(right[i]!.i);
    return idxs.sort((a, b) => a - b);
  }
  // Greedy fallback
  let sum = 0;
  const picked: number[] = [];
  for (const x of indexed) {
    if (sum + x.amt <= bankMinor + toleranceMinor) {
      sum += x.amt;
      picked.push(x.i);
    }
    if (Math.abs(sum - bankMinor) <= toleranceMinor && picked.length >= 2) return picked.sort((a, b) => a - b);
  }
  return Math.abs(sum - bankMinor) <= toleranceMinor && picked.length >= 2
    ? picked.sort((a, b) => a - b)
    : null;
}

function popcount(n: number): number {
  let c = 0;
  while (n) {
    c += n & 1;
    n >>= 1;
  }
  return c;
}
