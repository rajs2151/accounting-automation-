"use client";

import { useEffect, useState } from "react";

import { formatMinor } from "@/lib/money";

type Kpis = {
  side: "AR" | "AP";
  totalOutstandingAedMinor: number;
  overdueAedMinor: number;
  dueIn7DaysAedMinor: number;
  unmatchedToBankAedMinor: number | null;
};

function Tile({
  label,
  minor,
  testId,
}: {
  label: string;
  minor: number | null;
  testId: string;
}) {
  const display = minor == null ? "—" : formatMinor(minor);
  const title = minor == null ? "Available in Phase 2" : `AED ${formatMinor(minor)} (exact)`;
  return (
    <div
      className="min-w-[140px] flex-1 rounded-lg border border-border bg-background px-3 py-2"
      data-testid={testId}
      title={title}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{display}</p>
    </div>
  );
}

export function OpenItemKpiTiles({ side }: { side: "AR" | "AP" }) {
  const [kpis, setKpis] = useState<Kpis | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/books/open-items/kpis?side=${side}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data && typeof data.totalOutstandingAedMinor === "number") {
          setKpis(data as Kpis);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [side]);

  const prefix = side === "AP" ? "ap-kpi" : "ar-kpi";

  return (
    <div className="flex flex-wrap gap-2" data-testid={`${prefix}-row`}>
      <Tile
        label="Total outstanding"
        minor={kpis?.totalOutstandingAedMinor ?? 0}
        testId={`${prefix}-outstanding`}
      />
      <Tile label="Overdue" minor={kpis?.overdueAedMinor ?? 0} testId={`${prefix}-overdue`} />
      <Tile
        label="Due in next 7 days"
        minor={kpis?.dueIn7DaysAedMinor ?? 0}
        testId={`${prefix}-due-7`}
      />
      <Tile label="Unmatched to bank" minor={null} testId={`${prefix}-unmatched`} />
    </div>
  );
}
