/**
 * D1: VAT on customer advances — split gross into net (2320) + VAT (2210).
 * VAT = floor(gross × 5 / 105) fils (integer).
 */

export type AdvancePartyTaxProfile = {
  trn?: string | null;
  country?: string | null;
  /** mainland | free_zone | designated_zone */
  zone?: string | null;
};

/** UAE taxable customer for advance VAT: has TRN, UAE country, not designated zone. */
export function partyIsUaeTaxableForAdvance(party: AdvancePartyTaxProfile): boolean {
  const trn = String(party.trn || "").trim();
  if (!trn) return false;
  const country = String(party.country || "AE").trim().toUpperCase();
  if (country !== "AE" && country !== "UAE") return false;
  const zone = String(party.zone || "").trim().toLowerCase();
  if (zone === "designated_zone") return false;
  // mainland, free_zone, or unset (legacy parties with TRN) → split VAT
  return true;
}

/** Output VAT embedded in a gross-inclusive advance (fils). */
export function vatFromGrossAdvanceMinor(grossMinor: number): number {
  const g = Math.trunc(Number(grossMinor) || 0);
  if (g <= 0) return 0;
  return Math.floor((g * 5) / 105);
}

export function netFromGrossAdvanceMinor(grossMinor: number): number {
  const g = Math.trunc(Number(grossMinor) || 0);
  return g - vatFromGrossAdvanceMinor(g);
}

/**
 * Split a gross advance apply amount into net + VAT using remaining balances.
 * When applying the full remaining gross, consume all remaining VAT (no rounding remainder).
 */
export function splitAdvanceApply(args: {
  applyGrossOriginalMinor: number;
  remainingNetOriginalMinor: number;
  remainingVatOriginalMinor: number;
}): { netOriginalMinor: number; vatOriginalMinor: number } {
  const apply = Math.trunc(args.applyGrossOriginalMinor);
  const remNet = Math.trunc(args.remainingNetOriginalMinor);
  const remVat = Math.trunc(args.remainingVatOriginalMinor);
  const remGross = remNet + remVat;
  if (apply <= 0) return { netOriginalMinor: 0, vatOriginalMinor: 0 };
  if (apply >= remGross) {
    return { netOriginalMinor: remNet, vatOriginalMinor: remVat };
  }
  if (remGross <= 0 || remVat <= 0) {
    return { netOriginalMinor: apply, vatOriginalMinor: 0 };
  }
  const vatOriginalMinor = Math.floor((remVat * apply) / remGross);
  return { netOriginalMinor: apply - vatOriginalMinor, vatOriginalMinor };
}
