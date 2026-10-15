"use client";

import { Check, Copy, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import type { ConfidenceTone } from "@/lib/review-confidence";
import { cn } from "@/lib/utils";

type Props = {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onActivate?: () => void;
  onDeactivate?: () => void;
  confidenceTone?: ConfidenceTone | null;
  status?: string;
  locationMissing?: boolean;
  className?: string;
};

const DOT: Record<ConfidenceTone, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

/**
 * Read-first review field: plain value until click/Enter edits.
 * testids: review-field-{name} on the read shell; field-{name} on the input while editing.
 */
export function ReviewReadField({
  name,
  label,
  value,
  onChange,
  onActivate,
  onDeactivate,
  confidenceTone = null,
  status,
  locationMissing,
  className,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [copied, setCopied] = useState(false);
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function startEdit() {
    editingRef.current = true;
    setDraft(value);
    setEditing(true);
    onActivate?.();
  }

  function commit() {
    onChange(draft);
    editingRef.current = false;
    setEditing(false);
    onDeactivate?.();
  }

  function cancel() {
    setDraft(value);
    editingRef.current = false;
    setEditing(false);
    onDeactivate?.();
  }

  async function copyValue(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }

  const bad = status === "fail";

  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {confidenceTone ? (
          <span
            className={cn("inline-block size-1.5 rounded-full", DOT[confidenceTone])}
            data-testid={`confidence-dot-${name}`}
            title={`confidence: ${confidenceTone}`}
            aria-label={`${label} confidence ${confidenceTone}`}
          />
        ) : null}
        {bad ? <span className="text-[11px] text-red-600">fail</span> : null}
      </div>

      {editing ? (
        <Input
          data-testid={`field-${name}`}
          className={cn("h-8", bad && "border-red-500")}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            onActivate?.();
            e.currentTarget.select();
          }}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
        />
      ) : (
        <div
          role="button"
          tabIndex={0}
          data-testid={`review-field-${name}`}
          className={cn(
            "group relative flex min-h-8 items-center rounded-md border border-transparent px-2 py-1 text-sm transition-colors",
            "hover:border-border hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
            bad && "text-red-700",
          )}
          onClick={() => startEdit()}
          onFocus={() => onActivate?.()}
          onMouseEnter={() => onActivate?.()}
          onMouseLeave={() => {
            // Defer so unmounting into edit mode does not clear the active highlight.
            window.setTimeout(() => {
              if (!editingRef.current) onDeactivate?.();
            }, 0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              startEdit();
            }
          }}
        >
          <span className="min-w-0 flex-1 truncate tabular-nums">
            {value || (
              <span className="text-muted-foreground">Not found — enter it</span>
            )}
          </span>
          <span className="ms-1 flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label={`Edit ${label}`}
              data-testid={`review-field-edit-${name}`}
              onClick={(e) => {
                e.stopPropagation();
                startEdit();
              }}
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label={`Copy ${label}`}
              data-testid={`review-field-copy-${name}`}
              onClick={(e) => void copyValue(e)}
            >
              {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
            </button>
          </span>
        </div>
      )}

      {locationMissing && value ? (
        <p
          className="mt-0.5 text-[11px] text-muted-foreground"
          data-testid={`location-missing-${name}`}
        >
          location not found
        </p>
      ) : null}
    </div>
  );
}
