"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useBooksShell } from "@/components/books/books-shell-context";
import { StatusBadge } from "@/components/books/status-badge";
import { apiErrorMessage } from "@/lib/api-error";
import { parseControlDriftLabel, type DriftSide } from "@/lib/dashboard-money-labels";
import { formatMinor } from "@/lib/money";
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
      state: "covered" | "gap" | "missing" | "n/a";
      coverageTo: string | null;
      requiresStatement?: boolean;
      instrumentType?: "bank" | "card" | "cash" | "gateway";
    }>;
  };
  documentsToReview: {
    count: number;
    purchaseBills: number;
    salesInvoices: number;
    notes: number;
    statements: number;
    href: string;
    hrefs?: {
      purchaseBills: string;
      salesInvoices: string;
      notes: string;
      statements: string;
    };
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

type Kpi = { totalOutstandingAedMinor: number; overdueAedMinor: number; dueIn7DaysAedMinor: number };
type Money = {
  ar: Kpi | null;
  ap: Kpi | null;
  cashMinor: number | null;
  cashAccounts: number;
  arDrift: DriftSide | null;
  apDrift: DriftSide | null;
};

function MoneyTile(props: {
  testId: string;
  label: string;
  amountMinor: number | null;
  overdueMinor?: number | null;
  note: string;
  href: string;
  tone?: "danger";
  drift?: DriftSide | null;
}) {
  return (
    <Link
      href={props.href}
      data-testid={props.testId}
      className="group rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/30"
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{props.label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" data-testid={`${props.testId}-outstanding`}>
        {props.amountMinor == null ? "—" : formatMinor(props.amountMinor)}
        <span className="ms-1 text-xs font-normal text-muted-foreground">AED outstanding</span>
      </div>
      {props.overdueMinor != null ? (
        <div
          className={
            props.overdueMinor > 0
              ? "mt-1 text-sm font-medium tabular-nums text-red-600"
              : "mt-1 text-sm tabular-nums text-muted-foreground"
          }
          data-testid={`${props.testId}-overdue`}
        >
          {formatMinor(props.overdueMinor)} AED overdue
        </div>
      ) : null}
      <div className={props.tone === "danger" ? "mt-1 text-xs text-red-600" : "mt-1 text-xs text-muted-foreground"}>
        {props.note}
      </div>
      {props.drift && props.drift.driftMinor !== 0 ? (
        <div className="mt-1 text-xs text-amber-800" data-testid={`${props.testId}-drift`}>
          Control {formatMinor(props.drift.controlMinor)} ≠ open items {formatMinor(props.drift.openMinor)}{" "}
          — see issues below
        </div>
      ) : null}
    </Link>
  );
}

const REPORT_SHORTCUTS = [
  { href: "/books/reports/pnl", label: "Profit & Loss", note: "Revenue to net profit" },
  { href: "/books/reports/balance-sheet", label: "Balance sheet", note: "Assets = liabilities + equity" },
  { href: "/books/reports/cash-flow", label: "Cash flow", note: "Indirect method" },
  { href: "/books/reports/trial-balance", label: "Trial balance", note: "Balances by account" },
  { href: "/books/reports/day-book", label: "Day book", note: "Every voucher by date" },
  { href: "/books/reports/ageing?side=ar", label: "Receivables ageing", note: "Who owes you" },
  { href: "/books/reports/ageing?side=ap", label: "Payables ageing", note: "What you owe" },
  { href: "/books/journals", label: "Journals", note: "Every posted voucher" },
];

/**
 * How values move through the books, left to right, with what is waiting at each step. Every number
 * links to the place where that work is done.
 */
function BooksFlow({ d }: { d: Checklist }) {
  const toReview = d.documentsToReview.count + d.bankLines.needsReview;
  const steps: Array<{ n: number; title: string; note: string; count: number | null; countLabel: string; href: string }> = [
    {
      n: 1,
      title: "Upload",
      note: "Bills, invoices, receipts and bank statements go to the Inbox and are read automatically.",
      count: d.unassignedInbox.count,
      countLabel: "unassigned",
      href: "/books/inbox",
    },
    {
      n: 2,
      title: "Review",
      note: "Check each document's party, amounts and VAT; match bank lines to invoices or bills.",
      count: toReview,
      countLabel: "to review",
      href: d.documentsToReview.count ? d.documentsToReview.href : d.bankLines.href,
    },
    {
      n: 3,
      title: "Approve & post",
      note: "A second person approves. Posting writes the journal entry: debits = credits.",
      count: d.bankLines.readyNotPosted,
      countLabel: "waiting",
      href: d.bankLines.readyNotPosted ? d.bankLines.href : "/books/journals",
    },
    {
      n: 4,
      title: "Reports",
      note: "Posted entries update account ledgers, the trial balance, ageing and the VAT return.",
      count: null,
      countLabel: "",
      href: "/books/reports/pnl",
    },
  ];
  return (
    <section className="space-y-2" data-testid="dashboard-flow">
      <h2 className="font-medium">How your books flow</h2>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => (
          <li key={s.n}>
            <Link
              href={s.href}
              data-testid={`dash-flow-${s.n}`}
              className="group flex h-full flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-primary/40 hover:bg-muted/30"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  <span className="me-1.5 inline-flex size-5 items-center justify-center rounded-full bg-muted text-[11px] tabular-nums text-muted-foreground">
                    {s.n}
                  </span>
                  {s.title}
                </span>
                {s.count != null ? (
                  <span
                    className={
                      s.count
                        ? "whitespace-nowrap text-xs font-medium text-amber-700 dark:text-amber-400"
                        : "whitespace-nowrap text-xs text-muted-foreground"
                    }
                  >
                    {s.count ? `${s.count} ${s.countLabel}` : "All clear"}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground transition-transform group-hover:translate-x-0.5">→</span>
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{s.note}</p>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

const COVERAGE_LABEL = {
  covered: "✓ to month end",
  gap: "✗ gap",
  missing: "✗ no statement",
  "n/a": "n/a — cash (no statement)",
} as const;

const INSTRUMENT_LABEL: Record<string, string> = {
  bank: "Bank",
  card: "Card",
  cash: "Cash",
  gateway: "Gateway",
};

export default function BooksHomePage() {
  const { periodId } = useBooksShell();
  const [data, setData] = useState<Checklist | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [money, setMoney] = useState<Money | null>(null);

  // Money at a glance (today): open receivables / payables, cash, and control vs open drift.
  useEffect(() => {
    let cancelled = false;
    const driftQ = periodId ? `?periodId=${encodeURIComponent(periodId)}` : "";
    void Promise.all([
      fetch("/api/books/open-items/kpis?side=AR").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/books/open-items/kpis?side=AP").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/books/bank-accounts").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      periodId
        ? fetch(`/api/books/dashboard/issues${driftQ}`).then((r) => (r.ok ? r.json() : [])).catch(() => [])
        : Promise.resolve([]),
    ]).then(([ar, ap, banks, iss]) => {
      if (cancelled) return;
      const cash = Array.isArray(banks)
        ? (banks as Array<{ instrumentType: string; ledgerBalanceMinor: number }>).filter(
            (b) => b.instrumentType === "bank" || b.instrumentType === "cash",
          )
        : null;
      const issues = Array.isArray(iss) ? (iss as Array<{ kind?: string; label?: string }>) : [];
      const arIssue = issues.find((i) => i.kind === "ar_control_vs_open_items");
      const apIssue = issues.find((i) => i.kind === "ap_control_vs_open_items");
      setMoney({
        ar: ar && !ar.error ? (ar as Kpi) : null,
        ap: ap && !ap.error ? (ap as Kpi) : null,
        cashMinor: cash ? cash.reduce((s, b) => s + Number(b.ledgerBalanceMinor || 0), 0) : null,
        cashAccounts: cash?.length ?? 0,
        arDrift: arIssue ? parseControlDriftLabel(arIssue.label) : null,
        apDrift: apIssue ? parseControlDriftLabel(apIssue.label) : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [periodId]);

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
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {d
            ? `${d.period.label} · ${formatDateUae(d.period.start)} – ${formatDateUae(d.period.end)}`
            : "Month-end checklist"}
        </p>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {money ? (
        <div className="grid gap-4 sm:grid-cols-3" data-testid="dashboard-money">
          <MoneyTile
            testId="dash-money-ar"
            label="Receivables"
            amountMinor={money.ar?.totalOutstandingAedMinor ?? null}
            overdueMinor={money.ar?.overdueAedMinor ?? null}
            note="Open invoices (sub-ledger)"
            tone={money.ar?.overdueAedMinor ? "danger" : undefined}
            href="/books/reports/ageing?side=ar"
            drift={money.arDrift}
          />
          <MoneyTile
            testId="dash-money-ap"
            label="Payables"
            amountMinor={money.ap?.totalOutstandingAedMinor ?? null}
            overdueMinor={money.ap?.overdueAedMinor ?? null}
            note="Open bills (sub-ledger)"
            tone={money.ap?.overdueAedMinor ? "danger" : undefined}
            href="/books/reports/ageing?side=ap"
            drift={money.apDrift}
          />
          <MoneyTile
            testId="dash-money-cash"
            label="Cash & bank"
            amountMinor={money.cashMinor}
            note={`Ledger balance · ${money.cashAccounts} account${money.cashAccounts === 1 ? "" : "s"}`}
            href="/books/banking"
          />
        </div>
      ) : null}

      {d ? <BooksFlow d={d} /> : null}

      {d ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="dashboard-checklist">
          <Card
            testId="dash-statements"
            title="Bank statements"
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
                      {a.instrumentType ? (
                        <span className="ms-1 text-muted-foreground">
                          ({INSTRUMENT_LABEL[a.instrumentType] || a.instrumentType})
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`shrink-0 whitespace-nowrap ${
                        a.state === "covered"
                          ? "text-emerald-700"
                          : a.state === "n/a"
                            ? "text-muted-foreground"
                            : "text-red-600"
                      }`}
                    >
                      {a.state === "n/a" && a.instrumentType && a.instrumentType !== "cash"
                        ? "n/a — no statement"
                        : COVERAGE_LABEL[a.state]}
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
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              <Link
                href={d.documentsToReview.hrefs?.purchaseBills || "/books/purchases?tab=needs_review"}
                className="hover:text-foreground hover:underline"
              >
                Bills {d.documentsToReview.purchaseBills}
              </Link>
              <Link
                href={d.documentsToReview.hrefs?.salesInvoices || "/books/sales?tab=needs_review"}
                className="hover:text-foreground hover:underline"
              >
                Invoices {d.documentsToReview.salesInvoices}
              </Link>
              <Link
                href={d.documentsToReview.hrefs?.notes || "/books/sales?tab=needs_review&docType=note"}
                className="hover:text-foreground hover:underline"
              >
                Notes {d.documentsToReview.notes}
              </Link>
              <Link
                href={d.documentsToReview.hrefs?.statements || "/books/statements?status=needs_review"}
                className="hover:text-foreground hover:underline"
              >
                Statements {d.documentsToReview.statements}
              </Link>
            </span>
          </Card>

          <Card
            testId="dash-bank-lines"
            title="Bank transactions to review"
            tone={d.bankLines.needsReview + d.bankLines.readyNotPosted ? "warning" : "success"}
            statusLabel={String(d.bankLines.needsReview + d.bankLines.readyNotPosted)}
            href={d.bankLines.href}
            action="Review now"
          >
            To categorise or match {d.bankLines.needsReview} · Waiting for approval {d.bankLines.readyNotPosted}
          </Card>

          <Card
            testId="dash-unassigned"
            title="Unassigned uploads"
            tone={d.unassignedInbox.count ? "warning" : "success"}
            statusLabel={String(d.unassignedInbox.count)}
            href={d.unassignedInbox.href}
            action="Assign to a company"
          >
            Firm-wide: files uploaded without a company, waiting to be routed.
          </Card>

          <Card
            testId="dash-period"
            title="Period & VAT"
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

      <section className="space-y-2" data-testid="dashboard-reports">
        <h2 className="font-medium">Reports</h2>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {REPORT_SHORTCUTS.map((r) => (
            <Link
              key={r.href}
              href={r.href}
              className="rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-primary/40 hover:bg-muted/30"
            >
              <div className="text-sm font-medium">{r.label}</div>
              <div className="text-xs text-muted-foreground">{r.note}</div>
            </Link>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
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
