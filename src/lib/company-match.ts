/**
 * Company match evidence for review / Unassigned routing.
 * Never label a name or fuzzy hit as a TRN match.
 */

export type CompanyMatchMethod = "trn_exact" | "iban_exact" | "name_fuzzy" | "none";

export type CompanyMatchResult = {
  matched: boolean;
  method: CompanyMatchMethod;
  score: number | null;
  evidence: string;
  needsReview: boolean;
  unassigned: boolean;
  label: string;
};

function tokenizeName(name: string): string[] {
  return name
    .split(/\W+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4);
}

/** Fuzzy name score: fraction of significant company tokens found in blob (0–1). */
export function nameFuzzyScore(blob: string, companyName: string | null | undefined): number {
  if (!companyName?.trim()) return 0;
  const tokens = tokenizeName(companyName);
  if (!tokens.length) return 0;
  const lower = blob.toLowerCase();
  const hits = tokens.filter((t) => lower.includes(t.toLowerCase())).length;
  return hits / tokens.length;
}

export function matchCompany(args: {
  text: string;
  filename?: string;
  companyTrn?: string | null;
  companyIban?: string | null;
  companyName?: string | null;
}): CompanyMatchResult {
  const blob = `${args.filename || ""}\n${args.text || ""}`;
  const compact = blob.replace(/\s+/g, "").toUpperCase();

  const trn = args.companyTrn?.trim() || "";
  if (trn && blob.includes(trn)) {
    return {
      matched: true,
      method: "trn_exact",
      score: 1,
      evidence: `TRN exact: ${trn}`,
      needsReview: false,
      unassigned: false,
      label: `Matched — TRN exact (${trn})`,
    };
  }

  const iban = (args.companyIban || "").replace(/\s+/g, "").toUpperCase();
  if (iban && compact.includes(iban)) {
    return {
      matched: true,
      method: "iban_exact",
      score: 1,
      evidence: `IBAN exact: ${iban}`,
      needsReview: false,
      unassigned: false,
      label: `Matched — IBAN exact`,
    };
  }

  const score = nameFuzzyScore(blob, args.companyName);
  if (score >= 0.5) {
    return {
      matched: true,
      method: "name_fuzzy",
      score,
      evidence: `Name fuzzy score ${(score * 100).toFixed(0)}%`,
      needsReview: true,
      unassigned: false,
      label: `Needs review — name fuzzy (${(score * 100).toFixed(0)}%), not TRN`,
    };
  }

  const hasOtherTrn = /\b100\d{12}\b/.test(blob);
  const hasOtherIban = /\bAE\d{21}\b/i.test(blob);
  return {
    matched: false,
    method: "none",
    score: null,
    evidence: hasOtherTrn || hasOtherIban ? "other_party_identifiers" : "no_identifiers",
    needsReview: true,
    unassigned: true,
    label: hasOtherTrn
      ? "Unassigned — document TRN does not match company"
      : "Unassigned — no company identifiers",
  };
}
