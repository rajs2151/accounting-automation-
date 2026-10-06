"use client";

import { ChevronDown, ChevronUp, Maximize2, Minimize2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Notion-style "side peek" for every plain table in Books.
 *
 * Clicking a row of any `<table>` inside the Books area opens a panel that slides in from the right
 * with the row shown as properties (column header → value). ↑ / ↓ (or the arrows) move to the
 * previous / next row, Esc or the backdrop closes, the expand button switches between side peek and a
 * centred view. Buttons and links of the row are mirrored as actions in the panel (they click the
 * original control, so the page's own logic runs — nothing is duplicated).
 *
 * Rows that already have their own click behaviour (a React onClick on the row — e.g. Journals,
 * Sales, Purchases, Transactions, reports) are left alone, as are tables marked `data-no-peek`.
 * Clicks on interactive elements inside a row (buttons, links, inputs, selects, checkboxes) never open
 * the peek.
 */

type Peek = {
  table: HTMLTableElement;
  row: HTMLTableRowElement;
  title: string;
  properties: Array<{ label: string; value: string }>;
  actions: Array<{ label: string; el: HTMLElement }>;
};

const INTERACTIVE = "button, a, input, select, textarea, label, summary, [role='button'], [role='checkbox'], [contenteditable='true'], [data-no-row-open]";

/**
 * Props for a table row that opens its real record (review drawer, detail page …) on click — the same
 * Notion feel as the generic peek: pointer, hover "Open" chip, and clicks on the row's own controls
 * (checkboxes, buttons, links, menus) are ignored. Also opens on Enter when the row is focused.
 */
export function rowOpenProps(open: () => void) {
  return {
    "data-openable": "",
    tabIndex: 0,
    onClick: (e: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
      const t = e.target as Element | null;
      // React bubbles clicks from portals (menus, dialogs) through the row — only real row clicks count.
      if (!t || !(e.currentTarget as Element | null)?.contains(t)) return;
      if (t.closest(INTERACTIVE)) return;
      if (window.getSelection()?.toString()) return;
      open();
    },
    onKeyDown: (e: { key: string; target: EventTarget | null; currentTarget: EventTarget | null }) => {
      if (e.key === "Enter" && e.target === e.currentTarget) open();
    },
  } as const;
}

/** Rows with editable fields (other than a selection checkbox) are data entry, never peeked. */
function isEditableRow(row: Element): boolean {
  return !!row.querySelector("input:not([type='checkbox']), select, textarea, [contenteditable='true']");
}

function text(el: Element | null | undefined) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

/** Visible text pieces of a cell joined with spaces (badges / sub-lines don't run together). */
function cellText(el: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent || "").replace(/\s+/g, " ").trim();
    if (t) parts.push(t);
  }
  return parts.join(" ").replace(/\s+·\s+/g, " · ");
}

/** Main text of a cell: its first element's text when it has one (e.g. the name above a badge). */
function primaryText(cell: Element): string {
  const first = Array.from(cell.querySelectorAll("*")).find(
    (n) => n.children.length === 0 || n.matches("div, span, p, strong"),
  );
  return text(first) || cellText(cell);
}

/** React stores props on DOM nodes; a row (or its table) with its own onClick handles clicks itself. */
function hasOwnClick(el: Element | null): boolean {
  for (let node = el; node && node.tagName !== "TABLE"; node = node.parentElement) {
    const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
    const props = key ? (node as unknown as Record<string, { onClick?: unknown }>)[key] : undefined;
    if (props && typeof props.onClick === "function") return true;
    if (node.tagName === "TR") return false;
  }
  return false;
}

function headerLabels(table: HTMLTableElement): string[] {
  const head = table.tHead?.rows[table.tHead.rows.length - 1];
  return head ? Array.from(head.cells).map((c) => text(c)) : [];
}

/** Data rows of the table body that could be peeked (skips group headers / empty-state rows). */
function peekableRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.tBodies).flatMap((b) =>
    Array.from(b.rows).filter((r) => r.cells.length > 1 && !hasOwnClick(r) && !isEditableRow(r)),
  );
}

function readPeek(table: HTMLTableElement, row: HTMLTableRowElement): Peek {
  const labels = headerLabels(table);
  const cells = Array.from(row.cells);
  const properties: Peek["properties"] = [];
  cells.forEach((cell, i) => {
    const label = labels[i] || "";
    // Interactive-only cells (pure action buttons) become actions, not properties.
    const clone = cell.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("button, select, input, a[href]").forEach((n) => n.remove());
    const value = cellText(clone);
    if (!label && !value) return;
    properties.push({ label: label || "—", value: value || "—" });
  });
  const actions = Array.from(row.querySelectorAll<HTMLElement>("button, a[href]"))
    .filter((el) => text(el) && !el.closest("[data-no-peek-action]"))
    .map((el) => ({ label: text(el), el }));
  const titleCell = cells.find((c) => cellText(c));
  const title = (titleCell && primaryText(titleCell)) || properties.find((p) => p.value !== "—")?.value || "Row";
  return { table, row, title, properties, actions };
}

export function TablePeekLayer({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [wide, setWide] = useState(false);
  const [open, setOpen] = useState(false);

  const show = useCallback((table: HTMLTableElement, row: HTMLTableRowElement) => {
    document.querySelectorAll("tr[data-peek-active]").forEach((r) => r.removeAttribute("data-peek-active"));
    row.setAttribute("data-peek-active", "");
    setPeek(readPeek(table, row));
    requestAnimationFrame(() => setOpen(true));
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    document.querySelectorAll("tr[data-peek-active]").forEach((r) => r.removeAttribute("data-peek-active"));
    window.setTimeout(() => setPeek(null), 180);
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!peek) return;
      const rows = peekableRows(peek.table);
      const i = rows.indexOf(peek.row);
      const next = rows[i + dir];
      if (next) {
        next.scrollIntoView({ block: "nearest" });
        show(peek.table, next);
      }
    },
    [peek, show],
  );

  // Delegated row clicks inside the Books area.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Element | null;
      if (!target || target.closest(INTERACTIVE)) return;
      const row = target.closest("tr");
      const table = row?.closest("table");
      if (!row || !table || !root!.contains(table)) return;
      if (table.closest("[data-no-peek], [data-own-style]") || row.parentElement?.tagName !== "TBODY") return;
      if (row.cells.length < 2 || hasOwnClick(row) || isEditableRow(row)) return;
      if (window.getSelection()?.toString()) return; // user is selecting text
      show(table, row as HTMLTableRowElement);
    }
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [show]);

  // Mark peekable tables so CSS can show the pointer + "Open" hint only where a click does something.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mark = () => {
      root.querySelectorAll("table").forEach((t) => {
        const want = !t.closest("[data-no-peek], [data-own-style]") && peekableRows(t).length > 0;
        if (want) t.setAttribute("data-peekable", "");
        else t.removeAttribute("data-peekable");
      });
    };
    mark();
    const obs = new MutationObserver(() => mark());
    obs.observe(root, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  // Keyboard while open.
  useEffect(() => {
    if (!peek) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as Element | null;
      if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        step(-1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peek, close, step]);

  const rows = peek ? peekableRows(peek.table) : [];
  const idx = peek ? rows.indexOf(peek.row) : -1;

  return (
    <div ref={rootRef} className="books-notion contents">
      {children}
      {peek ? (
        <div className="fixed inset-0 z-50" data-testid="table-peek-layer">
          <button
            type="button"
            aria-label="Close"
            className={cn(
              "absolute inset-0 cursor-default bg-black/10 transition-opacity duration-200",
              open ? "opacity-100" : "opacity-0",
            )}
            onClick={close}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={peek.title}
            data-testid="table-peek"
            className={cn(
              "absolute flex flex-col overflow-hidden border-border bg-popover text-popover-foreground shadow-2xl transition-all duration-200 ease-out",
              wide
                ? "inset-x-4 top-[6vh] bottom-[6vh] mx-auto max-w-3xl rounded-xl border"
                : "inset-y-0 end-0 w-full border-s sm:max-w-[520px]",
              open
                ? "translate-x-0 opacity-100"
                : wide
                  ? "translate-y-3 opacity-0"
                  : "translate-x-8 opacity-0 rtl:-translate-x-8",
            )}
          >
            <div className="flex items-center gap-1 border-b border-border/70 px-3 py-2 text-muted-foreground">
              <button type="button" className="rounded-md p-1.5 hover:bg-muted" onClick={close} aria-label="Close peek" data-testid="table-peek-close">
                <X className="size-4" />
              </button>
              <button
                type="button"
                className="rounded-md p-1.5 hover:bg-muted"
                onClick={() => setWide((w) => !w)}
                aria-label={wide ? "Side peek" : "Centre peek"}
                data-testid="table-peek-expand"
              >
                {wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </button>
              <div className="ms-auto flex items-center gap-1 text-xs">
                <span className="tabular-nums">{idx >= 0 ? `${idx + 1} / ${rows.length}` : ""}</span>
                <button type="button" className="rounded-md p-1.5 hover:bg-muted disabled:opacity-40" disabled={idx <= 0} onClick={() => step(-1)} aria-label="Previous row" data-testid="table-peek-prev">
                  <ChevronUp className="size-4" />
                </button>
                <button
                  type="button"
                  className="rounded-md p-1.5 hover:bg-muted disabled:opacity-40"
                  disabled={idx < 0 || idx >= rows.length - 1}
                  onClick={() => step(1)}
                  aria-label="Next row"
                  data-testid="table-peek-next"
                >
                  <ChevronDown className="size-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-8 pb-10 pt-8">
              <h2 className="text-2xl font-semibold leading-tight tracking-tight" data-testid="table-peek-title">
                {peek.title}
              </h2>
              <dl className="mt-6 space-y-0.5">
                {peek.properties.map((p, i) => (
                  <div key={`${p.label}-${i}`} className="grid grid-cols-[minmax(110px,160px)_1fr] items-start gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                    <dt className="truncate text-sm text-muted-foreground">{p.label}</dt>
                    <dd className="min-w-0 break-words text-sm">{p.value}</dd>
                  </div>
                ))}
              </dl>
              {peek.actions.length ? (
                <div className="mt-8 border-t border-border/70 pt-5">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Actions</p>
                  <div className="flex flex-wrap gap-2">
                    {peek.actions.map((a, i) => (
                      <button
                        key={`${a.label}-${i}`}
                        type="button"
                        className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
                        onClick={() => {
                          close();
                          a.el.click();
                        }}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <p className="mt-10 text-xs text-muted-foreground">↑ ↓ to move between rows · Esc to close</p>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
