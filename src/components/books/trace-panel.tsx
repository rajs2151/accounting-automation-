"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Circle, X } from "lucide-react";

import { apiErrorMessage } from "@/lib/api-error";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";

type TraceStep = {
  key: string;
  label: string;
  status: "done" | "pending" | "failed" | "skipped";
  at: string | null;
  actors: Array<{ id: string; name: string | null }>;
  detail: Record<string, unknown>;
  href: string | null;
};

type TraceTieOut = {
  key: string;
  label: string;
  ok: boolean | null;
  detail: string | null;
};

type TraceResult = {
  kind: string;
  id: string;
  title: string;
  steps: TraceStep[];
  tieOuts: TraceTieOut[];
  reportEffects: Array<{ label: string; amountMinor: number; href: string | null }>;
};

function StatusIcon({ status }: { status: TraceStep["status"] }) {
  if (status === "done") return <Check className="h-4 w-4 text-emerald-600" aria-hidden />;
  if (status === "failed") return <X className="h-4 w-4 text-red-600" aria-hidden />;
  return <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />;
}

function TieIcon({ ok }: { ok: boolean | null }) {
  if (ok === true) return <Check className="h-4 w-4 text-emerald-600" aria-hidden />;
  if (ok === false) return <X className="h-4 w-4 text-red-600" aria-hidden />;
  return <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />;
}

export function TracePanel(props: {
  kind: "document" | "inbox" | "bank-transaction";
  id: string;
}) {
  const [data, setData] = useState<TraceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/books/trace/${props.kind}/${props.id}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) setError(apiErrorMessage(body));
          return;
        }
        if (!cancelled) setData(body as TraceResult);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "trace_failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.kind, props.id]);

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="trace-panel">
        Loading trace…
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-sm text-red-600" data-testid="trace-panel">
        {error}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-4" data-testid="trace-panel">
      <div>
        <h3 className="text-sm font-semibold" data-testid="trace-title">
          Trace · {data.title}
        </h3>
        <p className="text-xs text-muted-foreground">Read-only chain from upload to reports.</p>
      </div>

      <ol className="space-y-3" data-testid="trace-steps">
        {data.steps.map((step) => (
          <li
            key={step.key}
            className="rounded-md border border-border/60 p-3"
            data-testid={`trace-step-${step.key}`}
            data-status={step.status}
          >
            <div className="flex items-start gap-2">
              <StatusIcon status={step.status} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium">{step.label}</span>
                  <span
                    className={cn(
                      "text-xs",
                      step.status === "done"
                        ? "text-emerald-700"
                        : step.status === "failed"
                          ? "text-red-600"
                          : "text-muted-foreground",
                    )}
                  >
                    {step.status}
                  </span>
                  {step.at ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {new Date(step.at).toLocaleString()}
                    </span>
                  ) : null}
                </div>
                {step.actors.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {step.actors.map((a) => a.name || a.id.slice(0, 8)).join(" · ")}
                  </p>
                ) : null}
                {typeof step.detail.note === "string" ? (
                  <p className="mt-1 text-xs text-muted-foreground">{step.detail.note}</p>
                ) : null}
                {step.key === "journal" && Array.isArray(step.detail.lines) ? (
                  <table className="mt-2 w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-0.5">Code</th>
                        <th className="py-0.5 text-right">Dr</th>
                        <th className="py-0.5 text-right">Cr</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        step.detail.lines as Array<{
                          code: string;
                          debitMinor: number;
                          creditMinor: number;
                        }>
                      ).map((l) => (
                        <tr key={l.code}>
                          <td className="py-0.5 font-mono">{l.code}</td>
                          <td className="py-0.5 text-right tabular-nums">
                            {l.debitMinor ? formatMinor(l.debitMinor) : "—"}
                          </td>
                          <td className="py-0.5 text-right tabular-nums">
                            {l.creditMinor ? formatMinor(l.creditMinor) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                {step.key === "open_item" && step.detail.openAedMinor != null ? (
                  <p className="mt-1 text-xs tabular-nums" data-testid="trace-open-aed">
                    Open AED {formatMinor(Number(step.detail.openAedMinor))}
                    {step.detail.openOriginalMinor != null
                      ? ` · original ${formatMinor(Number(step.detail.openOriginalMinor))}`
                      : ""}
                  </p>
                ) : null}
                {step.href ? (
                  <Link href={step.href} className="mt-1 inline-block text-xs text-primary underline">
                    Open
                  </Link>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {data.reportEffects.length > 0 ? (
        <div data-testid="trace-report-effects">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Report effect
          </h4>
          <ul className="space-y-1 text-sm">
            {data.reportEffects.map((e) => (
              <li key={e.label} className="flex justify-between gap-2">
                <span>{e.label}</span>
                <span className="tabular-nums">{formatMinor(e.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div data-testid="trace-tieouts">
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tie-outs
        </h4>
        <ul className="space-y-2">
          {data.tieOuts.map((t) => (
            <li key={t.key} className="flex items-start gap-2 text-sm" data-testid={`trace-tie-${t.key}`}>
              <TieIcon ok={t.ok} />
              <div>
                <div>{t.label}</div>
                {t.detail ? <div className="text-xs text-muted-foreground">{t.detail}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
