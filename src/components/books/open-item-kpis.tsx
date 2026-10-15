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

type LoadState = "loading" | "ready" | "error";

function Tile({
  label,
  display,
  title,
  testId,
}: {
  label: string;
  display: string;
  title?: string;
  testId: string;
}) {
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

function moneyTile(
  loadState: LoadState,
  minor: number | undefined,
): { display: string; title?: string } {
  if (loadState === "loading") return { display: "…" };
  if (loadState === "error" || minor === undefined) return { display: "—" };
  return { display: formatMinor(minor), title: `AED ${formatMinor(minor)} (exact)` };
}

export function OpenItemKpiTiles({ side }: { side: "AR" | "AP" }) {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setKpis(null);
    void fetch(`/api/books/open-items/kpis?side=${side}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`kpis ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data.totalOutstandingAedMinor === "number") {
          setKpis(data as Kpis);
          setLoadState("ready");
        } else {
          setLoadState("error");
        }
      })
      .catch(() => {
        if (!cancelled) setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [side]);

  const prefix = side === "AP" ? "ap-kpi" : "ar-kpi";
  const outstanding = moneyTile(loadState, kpis?.totalOutstandingAedMinor);
  const overdue = moneyTile(loadState, kpis?.overdueAedMinor);
  const due7 = moneyTile(loadState, kpis?.dueIn7DaysAedMinor);

  return (
    <div className="flex flex-wrap gap-2" data-testid={`${prefix}-row`}>
      <Tile
        label="Total outstanding"
        display={outstanding.display}
        title={outstanding.title}
        testId={`${prefix}-outstanding`}
      />
      <Tile
        label="Overdue"
        display={overdue.display}
        title={overdue.title}
        testId={`${prefix}-overdue`}
      />
      <Tile
        label="Due in next 7 days"
        display={due7.display}
        title={due7.title}
        testId={`${prefix}-due-7`}
      />
    </div>
  );
}
