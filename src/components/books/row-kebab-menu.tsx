"use client";

import { MoreHorizontal } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function RowKebabMenu({
  children,
  "data-testid": testId,
}: {
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-popup-open:opacity-100"
            data-testid={testId}
            aria-label="Row actions"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RowReviewLink({ href, testId }: { href: string; testId?: string }) {
  return (
    <DropdownMenuItem render={<Link href={href} data-testid={testId} />}>Review</DropdownMenuItem>
  );
}
