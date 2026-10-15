import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StatusLabel, StatusTone } from "@/lib/status-labels";

const toneClass: Record<StatusTone, string> = {
  neutral: "border-border bg-muted/60 text-foreground",
  warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100",
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
  danger: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100",
};

export function StatusBadge({
  meta,
  className,
  "data-testid": testId,
}: {
  meta: StatusLabel;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      className={cn("font-normal", toneClass[meta.tone], className)}
    >
      {meta.label}
    </Badge>
  );
}
