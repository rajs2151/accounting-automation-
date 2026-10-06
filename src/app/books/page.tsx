"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useBooksShell } from "@/components/books/books-shell-context";
import { StatusBadge } from "@/components/books/status-badge";
import { apiErrorMessage } from "@/lib/api-error";
import { formatDateUae } from "@/lib/date";
import { isDevUiEnabled } from "@/lib/dev-ui";

type Checklist = {
  period: { id: string; label: string; start: string; end: string; status: string };
  statements: {
    ok: boolean;
    href: string;
    accounts: Array<{
      accountId: string;
      code: string;
      name: string;
      setupOk: boolean;
      state: "covered" | "gap" | "missing";
      coverageTo: string | null;
    }>;
  };
  documentsToReview: {
    count: number;
    purchaseBills: number;
    salesInvoices: number;
    notes: number;
    statements: number;
    href: string;
  };
  bankLines: { needsReview: number; readyNotPosted: number; href: string };
  unassignedInbox: { count: number; href: string };
  periodStatus: {
    status: string;
    locked: boolean;
    href: string;
    vat:
      | { set: false }
      | {
          set: true;
          frequency: "monthly" | "quarterly";
          periodStart: string;
          periodEnd: string;
          dueDate: string;
          daysUntilDue: number;
        };
  };
  issues: { count: number; href: string };
};

type Issue = { kind: string; label: string; href: string; refId: string };

type Tone = "success" | "warning" | "danger" | "neutral" | "info";

function Card(props: {
  testId: string;
  title: string;
  tone: Tone;
  statusLabel: string;
  href: string;
  action: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid={props.testId}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-medium">{props.title}</h2>
        <StatusBadge meta={{ label: props.statusLabel, tone: props.tone }} />
      </div>
      <div className="flex-1 text-sm text-muted-foreground">{props.children}</div>
      <Link
        href={props.href}
        className="inline-flex h-8 w-fit items-center rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
      >
        {props.action}
      </Link>
    </div>
  );
}

const COVERAGE_LABEL = { covered: "✓ to month end", gap: "✗ gap", missing: "✗ no statement" } as const;

export default function BooksHomePage() {
  const { periodId } = useBooksShell();
  const [data, setData] = useState<Checklist | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = periodId ? `?periodId=${encodeURIComponent(periodId)}` : "";
    void (async () => {
      const [res, iss] = await Promise.all([
        fetch(`/api/books/dashboard${q}`),
        fetch(`/api/books/dashboard/issues${q}`),
      ]);
      const body = await res.json().catch(() => ({}));
      const issBody = await iss.json().catch(() => []);
      if (cancelled) return;
      if (!res.ok) {
        setError(apiErrorMessage(body));
        return;
      }
      setError(null);
      setData(body as Checklist);
      setIssues(Array.isArray(issBody) ? issBody : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [periodId]);

  const d = data;
  return (
    <div className="mx-auto max-w-5xl space-y-6 py-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">This month</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {d
            ? `${d.period.label} · ${formatDateUae(d.period.start)} – ${formatDateUae(d.period.end)}`
            : "Monthly checklist"}{" "}
          · synthetic companies only until portal security passes.
        </p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {d ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="dashboard-checklist">
          <Card
            testId="dash-statements"
            title="Statements uploaded"
            tone={d.statements.ok ? "success" : "danger"}
            statusLabel={d.statements.ok ? "Complete" : "Missing"}
            href={d.statements.href}
            action="Upload statement"
          >
            {d.statements.accounts.length ? (
              <ul className="space-y-1">
                {d.statements.accounts.map((a) => (
                  <li key={a.accountId} className="flex justify-between gap-2">
                    <span>
                      {a.code} {a.name}
                    </span>
                    <span className={a.state === "covered" ? "text-emerald-700" : "text-red-600"}>
                      {COVERAGE_LABEL[a.state]}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              "No bank / card / gateway accounts yet."
            )}
          </Card>

          <Card
            testId="dash-documents"
            title="Documents to review"
            tone={d.documentsToReview.count ? "warning" : "success"}
            statusLabel={String(d.documentsToReview.count)}
            href={d.documentsToReview.href}
            action="Review documents"
          >
            Bills {d.documentsToReview.purchaseBills} · Invoices {d.documentsToReview.salesInvoices} · Notes{" "}
            {d.documentsToReview.notes} · Statements {d.documentsToReview.statements}
          </Card>

          <Card
            testId="dash-bank-lines"
            title="Bank lines to review"
            tone={d.bankLines.needsReview + d.bankLines.readyNotPosted ? "warning" : "success"}
            statusLabel={String(d.bankLines.needsReview + d.bankLines.readyNotPosted)}
            href={d.bankLines.href}
            action="Review now"
          >
            Needs review {d.bankLines.needsReview} · Ready, not posted {d.bankLines.readyNotPosted}
          </Card>

          <Card
            testId="dash-unassigned"
            title="Unassigned inbox"
            tone={d.unassignedInbox.count ? "warning" : "success"}
            statusLabel={String(d.unassignedInbox.count)}
            href={d.unassignedInbox.href}
            action="Open inbox"
          >
            Files not matched to a company.
          </Card>

          <Card
            testId="dash-period"
            title="Period status"
            tone={d.periodStatus.locked ? "neutral" : "info"}
            statusLabel={d.periodStatus.locked ? "Locked" : "Open"}
            href={d.periodStatus.href}
            action="Company settings"
          >
            {d.periodStatus.vat.set ? (
              <span data-testid="dash-vat-due">
                VAT {d.periodStatus.vat.frequency} return for {formatDateUae(d.periodStatus.vat.periodStart)} –{" "}
                {formatDateUae(d.periodStatus.vat.periodEnd)} due{" "}
                <strong>{formatDateUae(d.periodStatus.vat.dueDate)}</strong>
                {d.periodStatus.vat.daysUntilDue >= 0
                  ? ` (in ${d.periodStatus.vat.daysUntilDue} days)`
                  : ` (${-d.periodStatus.vat.daysUntilDue} days overdue)`}
              </span>
            ) : (
              <span data-testid="dash-vat-not-set">VAT return period not set for this company.</span>
            )}
          </Card>
        </div>
      ) : null}

      <section id="issues" className="space-y-2" data-testid="dashboard-issues">
        <h2 className="font-medium">Issues ({issues.length})</h2>
        {issues.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {issues.map((i) => (
              <li key={`${i.kind}:${i.refId}`} className="px-3 py-2 text-sm">
                <Link href={i.href} className="hover:underline">
                  {i.label}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No failed extractions or balance-check failures.</p>
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        <Link
          href="/books/journals"
          className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-sm hover:bg-muted"
        >
          Ledger
        </Link>
        <Link
          href="/books/reports/trial-balance"
          className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-sm hover:bg-muted"
        >
          Trial balance
        </Link>
        {isDevUiEnabled() ? (
          <Link
            href="/dev/ui"
            className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
          >
            UI component gallery
          </Link>
        ) : null}
      </div>
    </div>
  );
}
