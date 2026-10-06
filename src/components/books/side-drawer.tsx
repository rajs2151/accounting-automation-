"use client";

import { useState, type ReactNode } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { CellStatusPill, CellTypePill } from "@/components/books/cells";
import { cn } from "@/lib/utils";

export function BooksSideDrawer({
  open,
  onOpenChange,
  title,
  entryNo,
  status,
  source,
  entryType,
  tabs,
  activeTab,
  onTabChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  entryNo?: string | null;
  status?: string;
  source?: string;
  entryType?: string;
  tabs?: { id: string; label: string }[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  children: ReactNode;
}) {
  // Notion-style: side peek by default, expand to a wide panel.
  const [wide, setWide] = useState(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className={cn(
          "flex w-full flex-col gap-0 p-0 shadow-2xl transition-[max-width] duration-200 ease-out",
          wide ? "sm:max-w-4xl" : "sm:max-w-[560px]",
        )}
        data-testid="books-side-drawer"
      >
        <div className="flex items-center gap-1 border-b border-border/70 px-3 py-2 text-muted-foreground">
          <button
            type="button"
            className="rounded-md p-1.5 hover:bg-muted"
            onClick={() => onOpenChange(false)}
            aria-label="Close drawer"
          >
            <X className="size-4" />
          </button>
          <button
            type="button"
            className="rounded-md p-1.5 hover:bg-muted"
            onClick={() => setWide((w) => !w)}
            aria-label={wide ? "Side peek" : "Expand"}
            data-testid="books-side-drawer-expand"
          >
            {wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        </div>
        <div className="flex items-start justify-between px-8 pb-3 pt-6">
          <div className="min-w-0 space-y-1">
            <SheetTitle className="text-2xl font-semibold tracking-tight">{entryNo || title}</SheetTitle>
            <p className="truncate text-sm text-muted-foreground">{title}</p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {status ? <CellStatusPill status={status} /> : null}
              {entryType ? <CellTypePill entryType={entryType} /> : null}
              {source ? (
                <span className="text-xs text-muted-foreground">
                  {source} · {entryType || "manual"}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {tabs && tabs.length > 0 ? (
          <div className="flex gap-1 border-b border-border/70 px-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={cn(
                  "border-b-2 px-3 py-2.5 text-sm -mb-px",
                  activeTab === tab.id
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                onClick={() => onTabChange?.(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex-1 overflow-y-auto px-8 py-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
