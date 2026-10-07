export type FlagBadge = {
  /** Stable key for React / testids */
  key: string;
  /** Human-readable label shown on the badge */
  label: string;
  /** When true, this token only appears in the technical tooltip */
  technical: boolean;
};

const READABLE: Record<string, string> = {
  tax_invoice: "Tax invoice",
  company_match: "Company mismatch",
  company_match_mismatch: "Company mismatch",
  "company_match:mismatch": "Company mismatch",
  unassigned: "Unassigned",
  party_roles_uncertain: "Party roles uncertain",
  company_not_on_invoice: "Your company isn't on this invoice — confirm sale or purchase",
  vat_code_missing: "VAT code missing",
  line_sum_mismatch: "Line sum mismatch",
  account_attribution_ambiguous: "Account attribution ambiguous",
  iban_account_mismatch: "Statement IBAN ≠ selected account",
  iban_missing_for_selected_account: "No IBAN on statement for selected account",
};

/**
 * Split validation / extraction flags into readable badges vs technical tokens.
 * Technical: methods:*, extractor versions, raw machine codes kept for tooltip only.
 */
export function splitValidationFlags(flags: string[]): {
  badges: FlagBadge[];
  technical: string[];
} {
  const badges: FlagBadge[] = [];
  const technical: string[] = [];
  const seen = new Set<string>();

  for (const raw of flags) {
    const flag = String(raw || "").trim();
    if (!flag) continue;

    if (/^methods:/i.test(flag) || /^extractor/i.test(flag) || /^phase1-/i.test(flag)) {
      technical.push(flag);
      continue;
    }

    // company_match:mismatch → Company mismatch
    const lower = flag.toLowerCase();
    let label = READABLE[lower] || READABLE[flag];
    if (!label && lower.startsWith("company_match")) {
      label = "Company mismatch";
    }
    if (!label && lower.includes("mismatch")) {
      label = "Company mismatch";
    }
    if (!label) {
      // snake_case → Title case words
      label = flag
        .split(/[_:]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
    }

    const key = lower.replace(/[^a-z0-9]+/g, "_");
    if (seen.has(key)) continue;
    seen.add(key);
    badges.push({ key, label, technical: false });
  }

  return { badges, technical };
}
