"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useBooksShell } from "@/components/books/books-shell-context";

/** P2B-4: top-bar issues badge (failed extractions, balance-check failures, bank recon differences). */
export function BooksIssuesBadge() {
  const { periodId } = useBooksShell();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = periodId ? `?periodId=${encodeURIComponent(periodId)}` : "";
    void fetch(`/api/books/dashboard/issues${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setCount(Array.isArray(data) ? data.length : null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [periodId]);

  if (!count) return null;
  return (
    <Link
      href="/books#issues"
      className="inline-flex h-7 items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2.5 text-xs font-medium text-red-900 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
      data-testid="topbar-issues"
    >
      {count} {count === 1 ? "issue" : "issues"}
    </Link>
  );
}
