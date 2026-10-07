/**
 * Trade / VAT control accounts must only move via documents & settlements (open items),
 * never via a free-form bank category or manual journal line.
 */
export const BOOKS_CONTROL_ACCOUNT_CODES = ["1210", "2110", "1430", "2210"] as const;

export type BooksControlAccountCode = (typeof BOOKS_CONTROL_ACCOUNT_CODES)[number];

export function isBooksControlAccountCode(code: string): boolean {
  return (BOOKS_CONTROL_ACCOUNT_CODES as readonly string[]).includes(code);
}
