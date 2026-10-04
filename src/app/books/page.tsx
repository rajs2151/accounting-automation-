import Link from "next/link";

import { isDevUiEnabled } from "@/lib/dev-ui";

export default function BooksHomePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 py-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Arnibooks workspace — synthetic companies only until portal security passes.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/books/journals"
          className="rounded-xl border border-border bg-card p-5 shadow-sm transition hover:border-primary/40"
        >
          <h2 className="font-medium">Ledger</h2>
          <p className="mt-1 text-sm text-muted-foreground">Review and post journal entries.</p>
        </Link>
        <Link
          href="/books/reports/trial-balance"
          className="rounded-xl border border-border bg-card p-5 shadow-sm transition hover:border-primary/40"
        >
          <h2 className="font-medium">Trial balance</h2>
          <p className="mt-1 text-sm text-muted-foreground">Posted balances by account.</p>
        </Link>
      </div>
      {isDevUiEnabled() ? (
        <Link
          href="/dev/ui"
          className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
        >
          UI component gallery
        </Link>
      ) : null}
    </div>
  );
}
