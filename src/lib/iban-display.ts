import { formatMinor } from "@/lib/money";

/**
 * Client-safe IBAN mask: AE07 **** 3456.
 * Do not import src/lib/iban.ts (node:crypto) from client components.
 */
export function maskIbanDisplay(plain: string | null | undefined): string {
  if (plain == null || plain === "") return "—";
  const compact = plain.replace(/\s+/g, "").toUpperCase();
  if (compact.length < 8) return compact;
  return `${compact.slice(0, 4)} **** ${compact.slice(-4)}`;
}

/** Absolute difference in fils → "Off by 12.40" (no currency suffix). */
export function formatOffBy(diffMinor: number): string {
  const abs = Math.abs(diffMinor);
  return `Off by ${formatMinor(abs)}`;
}

/** Balanced vs Off-by label from opening/credits/debits vs closing (fils). */
export function statementBalanceBadgeLabel(args: {
  openingMinor: number;
  closingMinor: number;
  sumDebitMinor: number;
  sumCreditMinor: number;
  empty?: boolean;
}): string {
  if (args.empty) return "No rows";
  const computed = args.openingMinor + args.sumCreditMinor - args.sumDebitMinor;
  if (computed === args.closingMinor) return "Balanced";
  return formatOffBy(computed - args.closingMinor);
}
