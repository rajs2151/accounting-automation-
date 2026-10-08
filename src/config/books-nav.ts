/**
 * Single source for books sidebar labels + report tabs (Phase 4 item 22).
 * Icons stay in shell.tsx; labels/hrefs/soon flags live here.
 */

export type BooksNavItemDef = {
  href: string;
  label: string;
  also?: string[];
  soon?: boolean;
};

export type BooksNavGroupDef = {
  label?: string;
  items: BooksNavItemDef[];
};

export const BOOKS_NAV_GROUPS: BooksNavGroupDef[] = [
  {
    items: [
      { href: "/books", label: "Dashboard" },
      { href: "/books/inbox", label: "Inbox" },
    ],
  },
  {
    label: "Sales & purchases",
    items: [
      { href: "/books/sales", label: "Sales" },
      { href: "/books/purchases", label: "Purchases" },
      { href: "/books/expenses", label: "Expenses" },
      { href: "/books/receipts", label: "Receipts & payments" },
      { href: "/books/parties", label: "Customers & suppliers" },
    ],
  },
  {
    label: "Bank",
    items: [
      { href: "/books/banking", label: "Bank accounts", also: ["/books/statements"] },
      { href: "/books/transactions", label: "Bank transactions", also: ["/books/rules"] },
    ],
  },
  {
    label: "Accounting",
    items: [
      { href: "/books/journals", label: "Journals" },
      { href: "/books/fixed-assets", label: "Fixed assets" },
      { href: "/books/close", label: "Close" },
      { href: "/books/reports/trial-balance", label: "Reports", also: ["/books/reports"] },
      // Phase 7 product; keep route but mark Soon so it is not mistaken for finished scope.
      { href: "/books/health", label: "Company health", soon: true, also: ["/books/firm"] },
    ],
  },
  { items: [{ href: "/books/settings", label: "Settings" }] },
];

export const REPORT_TABS = [
  { href: "/books/reports/pnl", label: "Profit & Loss", key: "pnl" },
  { href: "/books/reports/balance-sheet", label: "Balance sheet", key: "bs" },
  { href: "/books/reports/cash-flow", label: "Cash flow", key: "cf" },
  { href: "/books/reports/trial-balance", label: "Trial balance", key: "tb" },
  { href: "/books/reports/day-book", label: "Day book", key: "daybook" },
  { href: "/books/reports/ageing?side=ar", label: "Receivables ageing", key: "ar" },
  { href: "/books/reports/ageing?side=ap", label: "Payables ageing", key: "ap" },
] as const;

export type ReportTabKey = (typeof REPORT_TABS)[number]["key"];
