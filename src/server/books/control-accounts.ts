/**
 * Trade / VAT control accounts must only move via documents & settlements (open items),
 * never via a free-form bank category or manual journal line.
 */
/** Trade + VAT controls — never via free-form manual journal (VAT settlement carve-out separate). */
export const BOOKS_CONTROL_ACCOUNT_CODES = ["1210", "2110", "1430", "2210", "2220"] as const;

export type BooksControlAccountCode = (typeof BOOKS_CONTROL_ACCOUNT_CODES)[number];

export function isBooksControlAccountCode(code: string): boolean {
  return (BOOKS_CONTROL_ACCOUNT_CODES as readonly string[]).includes(code);
}

/** VAT controls; a manual journal may move them only as a pure VAT settlement. */
export const BOOKS_VAT_CONTROL_CODES = ["2210", "1430"] as const;

/** Accounts a VAT settlement journal nets into (VAT payable / refund due). */
export const BOOKS_VAT_SETTLEMENT_CODES = ["2210", "1430", "2220", "1440"] as const;

/**
 * A manual VAT settlement (quarter-end: Dr 2210 / Cr 1430 / net to 2220 or 1440) touches the VAT
 * controls by design. Allowed only when every line is a VAT control or settlement account, so no
 * trade control (1210/2110) or P&L/bank line can ride along.
 */
export function isPureVatSettlement(codes: string[]): boolean {
  return (
    codes.length > 0 &&
    codes.every((c) => (BOOKS_VAT_SETTLEMENT_CODES as readonly string[]).includes(c)) &&
    codes.some((c) => (BOOKS_VAT_CONTROL_CODES as readonly string[]).includes(c))
  );
}
