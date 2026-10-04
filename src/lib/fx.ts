/** FX rate scaled by 1e8 (integer). 1.0 = 100_000_000. */

export const FX_RATE_SCALE = BigInt(100_000_000);

export function parseFxRateToScaled(rate: string | number): bigint {
  if (typeof rate === "number") {
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("invalid_fx_rate");
    // Avoid binary float drift: use string path
    return parseFxRateToScaled(String(rate));
  }
  const t = rate.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error("invalid_fx_rate");
  const [whole, frac = ""] = t.split(".");
  const scaled = BigInt(whole) * FX_RATE_SCALE + BigInt(frac.padEnd(8, "0").slice(0, 8));
  if (scaled <= BigInt(0)) throw new Error("invalid_fx_rate");
  return scaled;
}

export function fxRateScaledToNumber(scaled: number | bigint): number {
  const s = typeof scaled === "bigint" ? scaled : BigInt(scaled);
  return Number(s) / Number(FX_RATE_SCALE);
}

/** AED fils = round_half_up(original_minor * rate_scaled / 1e8) */
export function aedFromOriginal(originalMinor: number, fxRateScaled: number | bigint): number {
  if (!Number.isInteger(originalMinor)) throw new Error("invalid_money");
  const rate = typeof fxRateScaled === "bigint" ? fxRateScaled : BigInt(fxRateScaled);
  const prod = BigInt(originalMinor) * rate;
  const half = FX_RATE_SCALE / BigInt(2);
  const q =
    prod >= BigInt(0) ? (prod + half) / FX_RATE_SCALE : (prod - half) / FX_RATE_SCALE;
  const n = Number(q);
  if (!Number.isSafeInteger(n)) throw new Error("invalid_money");
  return n;
}
