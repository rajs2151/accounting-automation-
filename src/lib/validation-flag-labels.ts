import { formatMinor } from "@/lib/money";

export type FlagBadge = {
  /** Stable key for React / testids */
  key: string;
  /** Human-readable label shown on the badge */
  label: string;
  /** When true, this token only appears in the technical tooltip */
  technical: boolean;
  /** Optional expected vs read (fils or raw) for failed checks */
  expected?: string;
  got?: string;
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
  lines_ne_subtotal: "Lines do not match subtotal",
  totals_mismatch: "Subtotal + VAT ≠ total",
  vat_not_5pct: "VAT is not ~5% of net",
  trn_invalid: "TRN format invalid",
  statement_balance_mismatch: "Statement does not balance",
  closing_mismatch: "Closing balance mismatch",
  running_balance_break: "Running balance break",
  iban_checksum_invalid: "IBAN fails checksum",
  account_attribution_ambiguous: "Account attribution ambiguous",
  iban_account_mismatch: "Statement IBAN ≠ selected account",
  iban_missing_for_selected_account: "No IBAN on statement for selected account",
  card_pdf_partial: "Card PDF partially read — review lines",
  card_pdf_no_lines: "No card lines found",
  proforma_or_quote: "Looks like a proforma / quote",
  credit_note: "Credit note",
  debit_note: "Debit note",
};

const EXPECTED_GOT_RE = /^(.*?):expected=([^|]*)\|got=(.*)$/i;

function formatCheckValue(raw: string): string {
  const t = String(raw ?? "").trim();
  if (!t) return "—";
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n) && Math.abs(n) >= 100) {
      // Likely fils (or a large integer id — still readable as minor).
      try {
        return formatMinor(n);
      } catch {
        return t;
      }
    }
  }
  return t;
}

/**
 * Split validation / extraction flags into readable badges vs technical tokens.
 * Technical: methods:*, extractor versions, raw machine codes kept for tooltip only.
 * Failed checks may carry `code:expected=…|got=…` → label includes expected vs read.
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

    if (
      /^methods:/i.test(flag) ||
      /^extractor/i.test(flag) ||
      /^phase1-/i.test(flag) ||
      /^identity:/i.test(flag) ||
      /^statement_count:/i.test(flag) ||
      /^balance_diff:/i.test(flag) ||
      /^running_balance_diff:/i.test(flag) ||
      /^running_balance_break_line:/i.test(flag) ||
      /^running_balance_break_date:/i.test(flag) ||
      /^text_layer_unreliable:/i.test(flag)
    ) {
      technical.push(flag);
      continue;
    }

    const eg = flag.match(EXPECTED_GOT_RE);
    let code = flag;
    let expected: string | undefined;
    let got: string | undefined;
    if (eg) {
      code = eg[1]!;
      expected = formatCheckValue(eg[2] ?? "");
      got = formatCheckValue(eg[3] ?? "");
    }

    const lower = code.toLowerCase();
    let label = READABLE[lower] || READABLE[code];
    if (!label && lower.startsWith("company_match")) {
      label = "Company mismatch";
    }
    if (!label && lower.includes("mismatch") && !eg) {
      label = "Company mismatch";
    }
    if (!label) {
      label = code
        .split(/[_:]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
    }
    if (expected != null && got != null) {
      label = `${label} — expected ${expected}, read ${got}`;
    }

    const key = lower.replace(/[^a-z0-9]+/g, "_");
    if (seen.has(key)) continue;
    seen.add(key);
    badges.push({ key, label, technical: false, expected, got });
  }

  return { badges, technical };
}
