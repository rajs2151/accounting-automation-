"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useBooksShell } from "@/components/books/books-shell-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Issue = { kind: string; label: string; href: string; refId: string };

/** Top-bar issues badge: popover list + deep link to dashboard #issues. */
export function BooksIssuesBadge() {
  const { periodId } = useBooksShell();
  const router = useRouter();
  const [issues, setIssues] = useState<Issue[]>([]);

  useEffect(() => {
    let cancelled = false;
    const q = periodId ? `?periodId=${encodeURIComponent(periodId)}` : "";
    void fetch(`/api/books/dashboard/issues${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setIssues(Array.isArray(data) ? data : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [periodId]);

  const count = issues.length;
  if (!count) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex h-7 items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2.5 text-xs font-medium text-red-900 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
        data-testid="topbar-issues"
      >
        {count} {count === 1 ? "issue" : "issues"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Open issues</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {issues.map((i) => (
          <DropdownMenuItem
            key={`${i.kind}:${i.refId}`}
            className="cursor-pointer whitespace-normal text-sm"
            onClick={() => router.push(i.href)}
          >
            {i.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer"
          data-testid="topbar-issues-all"
          onClick={() => router.push("/books#issues")}
        >
          View all on dashboard
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
