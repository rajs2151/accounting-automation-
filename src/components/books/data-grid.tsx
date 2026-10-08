"use client";

import {
  flexRender,
  type ColumnSizingState,
  type ColumnVisibilityState,
  type RowData,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useLegacyTable,
  type LegacyColumnDef,
  type LegacyRow,
} from "@tanstack/react-table/legacy";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Columns3, Loader2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type BooksGridColumn<T> = {
  id: string;
  header: string;
  className?: string;
  size?: number;
  enableSorting?: boolean;
  cell: (row: T) => ReactNode;
  /** If set, used for sorting/filtering instead of rendered cell */
  accessor?: (row: T) => string | number;
  /** Pin column while scrolling horizontally. */
  sticky?: "left" | "right";
  /** When false, column cannot be hidden via the picker (default true). */
  hideable?: boolean;
};

export type BooksDataGridProps<T extends { id: string; entryDate?: string }> = {
  columns: BooksGridColumn<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  selectedId?: string | null;
  emptyLabel?: string;
  loading?: boolean;
  error?: string;
  searchQuery?: string;
  groupByMonth?: boolean;
  enableRowSelection?: boolean;
  onSelectionChange?: (ids: string[]) => void;
  showGridMeta?: boolean;
  /** Show Columns menu to toggle visibility (persisted when columnStorageKey set). */
  enableColumnPicker?: boolean;
  /** localStorage key for column visibility (e.g. books-journals-cols). */
  columnStorageKey?: string;
  /** Extra classes per data row (e.g. grey reversed entries). */
  getRowClassName?: (row: T) => string | undefined;
};

function monthKey(dateStr?: string) {
  if (!dateStr) return "Unknown";
  const d = dateStr.slice(0, 10);
  const [y, m] = d.split("-");
  const label = new Date(Number(y), Number(m) - 1, 1).toLocaleString("en", { month: "long", year: "numeric" });
  return `${y}-${m}|${label}`;
}

type FlatItem<T extends RowData> =
  | { kind: "group"; key: string; label: string; collapsed: boolean }
  | { kind: "row"; row: LegacyRow<T> };

export function BooksDataGrid<T extends RowData & { id: string; entryDate?: string }>({
  columns,
  rows,
  onRowClick,
  selectedId,
  emptyLabel = "No rows",
  loading = false,
  error,
  searchQuery = "",
  groupByMonth = true,
  enableRowSelection = false,
  onSelectionChange,
  showGridMeta = false,
  enableColumnPicker = false,
  columnStorageKey,
  getRowClassName,
}: BooksDataGridProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>(() => {
    if (!columnStorageKey || typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(columnStorageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as ColumnVisibilityState;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!columnStorageKey || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(columnStorageKey, JSON.stringify(columnVisibility));
    } catch {
      /* ignore quota */
    }
  }, [columnStorageKey, columnVisibility]);

  const stickyMeta = useMemo(() => {
    const leftOffsets = new Map<string, number>();
    let left = enableRowSelection ? 40 : 0;
    for (const col of columns) {
      if (col.sticky === "left") {
        leftOffsets.set(col.id, left);
        left += col.size ?? 140;
      }
    }
    return { leftOffsets };
  }, [columns, enableRowSelection]);

  const columnDefs = useMemo<LegacyColumnDef<T>[]>(() => {
    const defs: LegacyColumnDef<T>[] = [];
    if (enableRowSelection) {
      defs.push({
        id: "_select",
        size: 40,
        enableSorting: false,
        enableHiding: false,
        header: ({ table }) => (
          <Checkbox
            checked={table.getIsAllPageRowsSelected()}
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(Boolean(v))}
            aria-label="Select all rows"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(Boolean(v))}
            onClick={(e) => e.stopPropagation()}
            aria-label="Select row"
          />
        ),
        meta: {
          className: "sticky left-0 z-20 bg-card",
          sticky: "left" as const,
          stickyLeft: 0,
        },
      });
    }
    for (const col of columns) {
      defs.push({
        id: col.id,
        accessorFn: (row) => (col.accessor ? col.accessor(row) : col.id),
        header: col.header,
        size: col.size ?? 140,
        enableSorting: col.enableSorting !== false,
        enableHiding: col.hideable !== false,
        cell: ({ row }) => col.cell(row.original),
        meta: {
          className: col.className,
          sticky: col.sticky,
          stickyLeft: col.sticky === "left" ? stickyMeta.leftOffsets.get(col.id) : undefined,
        },
      });
    }
    return defs;
  }, [columns, enableRowSelection, stickyMeta]);

  const table = useLegacyTable({
    data: rows,
    columns: columnDefs,
    state: { sorting, columnVisibility, columnSizing, rowSelection, globalFilter: searchQuery },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onRowSelectionChange: (updater) => {
      setRowSelection((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        onSelectionChange?.(Object.keys(next).filter((k) => next[k]));
        return next;
      });
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    getRowId: (row) => row.id,
  });

  const tableRows = table.getRowModel().rows;

  const flatItems = useMemo(() => {
    if (!groupByMonth) {
      return tableRows.map((row) => ({ kind: "row" as const, row }));
    }
    const items: FlatItem<T>[] = [];
    let lastKey = "";
    for (const row of tableRows) {
      const { key, label } = (() => {
        const mk = monthKey(row.original.entryDate);
        const [, lbl] = mk.split("|");
        return { key: mk.split("|")[0], label: lbl };
      })();
      if (key !== lastKey) {
        items.push({
          kind: "group",
          key,
          label,
          collapsed: Boolean(collapsedGroups[key]),
        });
        lastKey = key;
      }
      if (!collapsedGroups[key]) items.push({ kind: "row", row });
    }
    return items;
  }, [tableRows, groupByMonth, collapsedGroups]);

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (flatItems[i]?.kind === "group" ? 36 : 52),
    overscan: 8,
  });

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!onRowClick || !tableRows.length) return;
      const idx = tableRows.findIndex((r) => r.original.id === selectedId);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = tableRows[Math.min(idx + 1, tableRows.length - 1)] ?? tableRows[0];
        onRowClick(next.original);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = tableRows[Math.max(idx - 1, 0)] ?? tableRows[0];
        onRowClick(next.original);
      }
    },
    [onRowClick, selectedId, tableRows],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-8 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-16 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  function stickyCellClass(meta: {
    className?: string;
    sticky?: "left" | "right";
  } | undefined) {
    return cn(
      meta?.className,
      meta?.sticky === "left" && "sticky z-20 bg-inherit shadow-[1px_0_0_0_var(--border)]",
      meta?.sticky === "right" && "sticky z-20 bg-inherit shadow-[-1px_0_0_0_var(--border)]",
    );
  }

  function stickyCellStyle(
    meta: { sticky?: "left" | "right"; stickyLeft?: number } | undefined,
    width: number,
  ): CSSProperties {
    const style: CSSProperties = { width };
    if (meta?.sticky === "left" && meta.stickyLeft != null) style.left = meta.stickyLeft;
    if (meta?.sticky === "right") style.right = 0;
    return style;
  }

  return (
    <div className="space-y-2" data-testid="books-data-grid-root">
      {showGridMeta || enableColumnPicker ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{showGridMeta ? `${tableRows.length} entries` : null}</span>
          {enableColumnPicker ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted"
                data-testid="books-column-picker"
              >
                <Columns3 className="size-3.5" aria-hidden />
                Columns
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {columns.map((col) => {
                  const hideable = col.hideable !== false;
                  const visible = columnVisibility[col.id] !== false;
                  return (
                    <DropdownMenuCheckboxItem
                      key={col.id}
                      checked={visible}
                      disabled={!hideable}
                      onCheckedChange={(v) => {
                        setColumnVisibility((prev) => ({ ...prev, [col.id]: Boolean(v) }));
                      }}
                      data-testid={`books-col-toggle-${col.id}`}
                    >
                      {col.header}
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}

      <div
        ref={parentRef}
        className="max-h-[calc(100vh-320px)] overflow-auto rounded-lg border border-border bg-card focus:outline-none"
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-testid="books-data-grid"
      >
        <table data-own-style="" className="w-full min-w-max border-collapse text-sm" style={{ width: table.getCenterTotalSize() }}>
          <thead className="sticky top-0 z-30 bg-muted/95 backdrop-blur">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border bg-muted/95">
                {hg.headers.map((header) => {
                  const meta = header.column.columnDef.meta as
                    | { className?: string; sticky?: "left" | "right"; stickyLeft?: number }
                    | undefined;
                  return (
                  <th
                    key={header.id}
                    className={cn(
                      "relative px-3 py-2.5 text-left text-xs font-medium text-muted-foreground whitespace-nowrap bg-muted/95",
                      stickyCellClass(meta),
                    )}
                    style={stickyCellStyle(meta, header.getSize())}
                  >
                    {header.isPlaceholder ? null : (
                      <button
                        type="button"
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground",
                          header.column.getCanSort() && "cursor-pointer",
                        )}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {{
                          asc: " ↑",
                          desc: " ↓",
                        }[header.column.getIsSorted() as string] ?? null}
                      </button>
                    )}
                    {header.column.getCanResize() ? (
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-border/0 hover:bg-primary/40"
                      />
                    ) : null}
                  </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const item = flatItems[virtualRow.index];
              if (!item) return null;
              if (item.kind === "group") {
                return (
                  <tr
                    key={`g-${item.key}`}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                      height: `${virtualRow.size}px`,
                    }}
                    className="bg-muted/40"
                  >
                    <td colSpan={columnDefs.length} className="px-3 py-2">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                        onClick={() =>
                          setCollapsedGroups((prev) => ({ ...prev, [item.key]: !prev[item.key] }))
                        }
                      >
                        {item.collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                        {item.label}
                      </button>
                    </td>
                  </tr>
                );
              }
              const row = item.row;
              const isSelected = selectedId === row.original.id;
              return (
                <tr
                  key={row.id}
                  data-row-id={row.original.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                    height: `${virtualRow.size}px`,
                  }}
                  className={cn(
                    "border-b border-border/80 bg-card hover:bg-muted/30",
                    onRowClick && "cursor-pointer",
                    isSelected && "bg-primary-subtle/60",
                    row.getIsSelected() && "ring-1 ring-inset ring-primary/20",
                    getRowClassName?.(row.original),
                  )}
                  onClick={() => onRowClick?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as
                      | { className?: string; sticky?: "left" | "right"; stickyLeft?: number }
                      | undefined;
                    return (
                      <td
                        key={cell.id}
                        className={cn("px-3 py-3 align-middle bg-inherit", stickyCellClass(meta))}
                        style={stickyCellStyle(meta, cell.column.getSize())}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
