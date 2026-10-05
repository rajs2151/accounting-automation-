"use client";

import { ChevronsUpDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function chipLetters(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase() || "??";
}

type Client = { id: string; name: string };

export function CompanySwitcher({
  clients,
  value,
  collapsed,
  onSwitch,
}: {
  clients: Client[];
  value: string;
  collapsed: boolean;
  onSwitch: (clientId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = clients.find((c) => c.id === value) || clients[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => c.name.toLowerCase().includes(q));
  }, [clients, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const pick = useCallback(
    (id: string) => {
      onSwitch(id);
      setOpen(false);
    },
    [onSwitch],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    }
    if (e.key === "Enter" && filtered[highlight]) {
      e.preventDefault();
      pick(filtered[highlight]!.id);
    }
  }

  if (!current) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        data-testid="books-company-switcher"
        title={current.name}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border border-border bg-card px-2 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
          collapsed && "size-10 justify-center px-0",
        )}
      >
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary-subtle text-xs font-semibold text-primary">
          {chipLetters(current.name)}
        </span>
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1 truncate text-sm">{current.name}</span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </>
        ) : (
          <span className="sr-only">{current.name}</span>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start" onKeyDown={onKeyDown}>
        <Input
          ref={inputRef}
          placeholder="Search companies…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2 h-8 text-sm"
        />
        <ul className="max-h-56 overflow-y-auto" role="listbox">
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                role="option"
                aria-selected={c.id === value}
                data-testid={`company-option-${c.id}`}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  i === highlight && "bg-muted",
                  c.id === value && "font-medium",
                )}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(c.id)}
              >
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                  {chipLetters(c.name)}
                </span>
                <span className="truncate">{c.name}</span>
              </button>
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className="px-2 py-3 text-center text-xs text-muted-foreground">No match</li>
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
