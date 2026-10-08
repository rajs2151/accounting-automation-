/**
 * P2B-4 (Addendum C4): "This month" checklist per company. Read-only summary (full close is Phase 5).
 *
 * Cards: statements uploaded (coverage to month end per account) · documents to review · bank lines to
 * review · unassigned inbox · period status + VAT return due. Plus an issues list (failed extractions,
 * statement balance-check failures, bank reconciliation differences) that drives the top-bar badge.
 */
import { withUser } from "@/lib/db";
import { documentsToReviewHref, inboxQueueBucket } from "@/lib/inbox-classify";
import { controlDriftIssueLabel } from "@/lib/money-display";
import {
  computeStatementCoverage,
  normalizeIban,
  statementCoverageApplicable,
  type BankInstrumentType,
} from "@/lib/statement-coverage";
import { listBooksBankAccounts } from "@/server/books/bank-accounts";
import { listBankReconciliations } from "@/server/books/bank-recon";
import { controlVsOpenItemsDrift } from "@/server/books/control-drift";
import { BooksError } from "@/server/books/errors";
import { statementListBalanceCheck } from "@/server/books/statement-extractions";
import { assertSyntheticTenant } from "@/server/security-gate";

import type { VatFrequency } from "@/server/books/company-vat-settings";

export type { VatFrequency };

function iso(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function lastDayOf(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function ymd(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * VAT tax period that contains the given month, and its return/payment due date
 * (28 days after the tax period ends — FTA).
 * quarterly: periodEndMonth is any month in which one of the company's quarters ends (stagger).
 */
export function vatPeriodForMonth(
  monthEnd: string,
  frequency: VatFrequency,
  periodEndMonth?: number | null,
): { periodStart: string; periodEnd: string; dueDate: string } {
  const year = Number(monthEnd.slice(0, 4));
  const month = Number(monthEnd.slice(5, 7));
  let endYear = year;
  let endMonth = month;
  if (frequency === "quarterly") {
    if (!periodEndMonth || periodEndMonth < 1 || periodEndMonth > 12) {
      throw new BooksError("vat_stagger_invalid", "invalid");
    }
    // Months until the next quarter end (0 when this month closes a quarter).
    const ahead = (((periodEndMonth - month) % 3) + 3) % 3;
    endMonth = month + ahead;
    if (endMonth > 12) {
      endMonth -= 12;
      endYear += 1;
    }
  }
  const periodEnd = ymd(endYear, endMonth, lastDayOf(endYear, endMonth));
  let startMonth = endMonth - (frequency === "quarterly" ? 2 : 0);
  let startYear = endYear;
  if (startMonth < 1) {
    startMonth += 12;
    startYear -= 1;
  }
  return {
    periodStart: ymd(startYear, startMonth, 1),
    periodEnd,
    dueDate: addDays(periodEnd, 28),
  };
}

export type StatementCoverageItem = {
  accountId: string;
  code: string;
  name: string;
  setupOk: boolean;
  /** covered/gap/missing for statement-required accounts; n/a for cash. */
  state: "covered" | "gap" | "missing" | "n/a";
  coverageTo: string | null;
  instrumentType?: string;
  requiresStatement?: boolean;
};

export type BooksIssue = {
  kind:
    | "failed_extraction"
    | "statement_balance_check"
    | "bank_recon_difference"
    | "ar_control_vs_open_items"
    | "ap_control_vs_open_items"
    | "close_gate_fail"
    | "vat_not_configured";
  label: string;
  href: string;
  refId: string;
  /** Structured amounts for client formatting (never put "fils" in label). */
  amounts?: Array<{ amountMinor: number; currency: string; role: string }>;
};

export type BooksMonthChecklist = {
  period: { id: string; label: string; start: string; end: string; status: string };
  statements: { ok: boolean; accounts: StatementCoverageItem[]; href: string };
  documentsToReview: {
    count: number;
    purchaseBills: number;
    salesInvoices: number;
    notes: number;
    statements: number;
    href: string;
    hrefs: {
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
    vat:
      | { set: false }
      | {
          set: true;
          frequency: VatFrequency;
          periodStart: string;
          periodEnd: string;
          dueDate: string;
          daysUntilDue: number;
        };
    href: string;
  };
  issues: { count: number; href: string };
};

/** Covered = the merged statement ranges contain the whole month with no gap. */
function coverageState(
  periods: Array<{ from: string; to: string }>,
  start: string,
  end: string,
): "covered" | "gap" | "missing" {
  const cov = computeStatementCoverage(periods);
  if (!cov.coverageFrom || !cov.coverageTo) return "missing";
  const overlaps = cov.coverageFrom <= end && cov.coverageTo >= start;
  if (!overlaps) return "missing";
  const gapInMonth = cov.gaps.some((g) => g.from <= end && g.to >= start);
  if (cov.coverageFrom <= start && cov.coverageTo >= end && !gapInMonth) return "covered";
  return "gap";
}

async function resolvePeriod(userId: string, clientId: string, periodId?: string | null) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const today = new Date().toISOString().slice(0, 10);
    const row = periodId
      ? await db.query(
          `SELECT id, label, period_start, period_end, status FROM books_periods
           WHERE id = $1 AND client_id = $2`,
          [periodId, clientId],
        )
      : await db.query(
          `SELECT id, label, period_start, period_end, status FROM books_periods
           WHERE client_id = $1
           ORDER BY (period_start <= $2::date AND period_end >= $2::date) DESC,
                    (period_start <= $2::date) DESC, period_start DESC
           LIMIT 1`,
          [clientId, today],
        );
    if (!row.rowCount) throw new BooksError("period_not_found", "not_found");
    const p = row.rows[0];
    return {
      id: String(p.id),
      label: String(p.label),
      start: iso(p.period_start),
      end: iso(p.period_end),
      status: String(p.status),
    };
  });
}

/** Issues behind the top-bar badge (outstanding, plus bank recon differences at the period end). */
export async function listBooksIssues(
  userId: string,
  clientId: string,
  opts?: { periodId?: string | null },
): Promise<BooksIssue[]> {
  const period = await resolvePeriod(userId, clientId, opts?.periodId);
  const issues = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const out: BooksIssue[] = [];
    const failedInbox = await db.query(
      `SELECT i.id, f.filename, i.error
       FROM books_inbox_items i JOIN books_files f ON f.id = i.file_id
       WHERE i.client_id = $1 AND i.status = 'failed'
       ORDER BY i.created_at`,
      [clientId],
    );
    for (const r of failedInbox.rows) {
      out.push({
        kind: "failed_extraction",
        label: `Extraction failed: ${String(r.filename)}${r.error ? ` (${String(r.error)})` : ""}`,
        href: `/books/inbox?item=${String(r.id)}`,
        refId: String(r.id),
      });
    }
    const stmts = await db.query(
      `SELECT s.id, s.status, s.validation_flags, f.filename, s.period_from, s.period_to
       FROM books_statement_extractions s JOIN books_files f ON f.id = s.file_id
       WHERE s.client_id = $1
       ORDER BY s.created_at`,
      [clientId],
    );
    for (const r of stmts.rows) {
      // Same rule as the Statements list "Balance check" column.
      if (statementListBalanceCheck(r.validation_flags, String(r.status)) !== "failed") continue;
      const failed = String(r.status) === "failed";
      out.push({
        kind: failed ? "failed_extraction" : "statement_balance_check",
        label: failed
          ? `Statement extraction failed: ${String(r.filename)}`
          : `Statement balances do not add up: ${String(r.filename)}`,
        href: `/books/statements?id=${String(r.id)}`,
        refId: String(r.id),
      });
    }
    return out;
  });
  for (const r of await listBankReconciliations(userId, clientId, { periodId: period.id })) {
    if (r.status !== "difference") continue;
    issues.push({
      kind: "bank_recon_difference",
      label: `${r.code} ${r.name}: statement and ledger differ at ${r.asOf}`,
      href: `/books/banking?recon=${r.accountId}`,
      refId: r.accountId,
    });
  }

  // AR/AP control (TB) vs open-item ageing — drift means someone posted to 1210/2110 without an open item.
  try {
    const drift = await controlVsOpenItemsDrift(userId, clientId, period.id);
    if (drift.ar.driftMinor !== 0) {
      issues.push({
        kind: "ar_control_vs_open_items",
        label: controlDriftIssueLabel(
          "AR",
          { amountMinor: drift.ar.controlMinor },
          { amountMinor: drift.ar.openMinor },
        ),
        href: "/books/reports/ageing?side=ar",
        refId: "1210",
        amounts: [
          { amountMinor: drift.ar.controlMinor, currency: "AED", role: "control" },
          { amountMinor: drift.ar.openMinor, currency: "AED", role: "open" },
        ],
      });
    }
    if (drift.ap.driftMinor !== 0) {
      issues.push({
        kind: "ap_control_vs_open_items",
        label: controlDriftIssueLabel(
          "AP",
          { amountMinor: drift.ap.controlMinor },
          { amountMinor: drift.ap.openMinor },
        ),
        href: "/books/reports/ageing?side=ap",
        refId: "2110",
        amounts: [
          { amountMinor: drift.ap.controlMinor, currency: "AED", role: "control" },
          { amountMinor: drift.ap.openMinor, currency: "AED", role: "open" },
        ],
      });
    }
  } catch {
    /* TB / ageing unavailable — skip drift check */
  }
  return issues;
}

/** Map failing / not-configured close gates into top-bar issues (same checklist source). */
export function closeGatesToIssues(
  gates: Array<{
    key: string;
    label: string;
    status: string;
    blocking: boolean;
    detail?: string;
    href?: string;
  }>,
): BooksIssue[] {
  const out: BooksIssue[] = [];
  for (const g of gates) {
    if (!g.blocking) continue;
    if (g.status !== "fail" && g.status !== "not_set_up") continue;
    out.push({
      kind: g.key === "vat_control" && g.status === "not_set_up" ? "vat_not_configured" : "close_gate_fail",
      label: `${g.label}${g.detail ? `: ${g.detail}` : ""}`,
      href: g.href || "/books/close",
      refId: g.key,
    });
  }
  return out;
}

/** Merge base issues with failing close gates (dedupe; skip ar_ap_tieout when drift already listed). */
export function mergeIssuesWithCloseGates(
  base: BooksIssue[],
  gates: Array<{
    key: string;
    label: string;
    status: string;
    blocking: boolean;
    detail?: string;
    href?: string;
  }>,
): BooksIssue[] {
  const fromGates = closeGatesToIssues(gates);
  const seen = new Set(base.map((i) => `${i.kind}:${i.refId}`));
  const hasDrift = base.some(
    (i) => i.kind === "ar_control_vs_open_items" || i.kind === "ap_control_vs_open_items",
  );
  return [
    ...base,
    ...fromGates.filter((i) => {
      if (i.refId === "ar_ap_tieout" && hasDrift) return false;
      return !seen.has(`${i.kind}:${i.refId}`);
    }),
  ];
}

/**
 * Issues for the badge + dashboard checklist count (same SoT).
 * Dynamic-imports close to avoid a dashboard ↔ close cycle.
 */
export async function listBooksIssuesMerged(
  userId: string,
  clientId: string,
  opts?: { periodId?: string | null },
): Promise<BooksIssue[]> {
  const base = await listBooksIssues(userId, clientId, opts);
  const periodId = opts?.periodId;
  if (!periodId) return base;
  try {
    const { getBooksCloseChecklist } = await import("@/server/books/close");
    const checklist = await getBooksCloseChecklist(userId, clientId, periodId);
    return mergeIssuesWithCloseGates(base, checklist.gates);
  } catch {
    return base;
  }
}

export async function getBooksMonthChecklist(
  userId: string,
  clientId: string,
  opts?: { periodId?: string | null; today?: string },
): Promise<BooksMonthChecklist> {
  const period = await resolvePeriod(userId, clientId, opts?.periodId);
  // Soft-fail missing db/33 columns so Close still loads; Banking page surfaces the migration.
  let accounts: Awaited<ReturnType<typeof listBooksBankAccounts>> = [];
  try {
    accounts = await listBooksBankAccounts(userId, clientId);
  } catch (err) {
    const { BooksError } = await import("@/server/books/errors");
    if (err instanceof BooksError && err.message === "c2_bank_accounts_migration_required") {
      accounts = [];
    } else {
      throw err;
    }
  }

  // Coverage needs the raw statement ranges per account (the Banking list only keeps merged ones).
  const counts = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const docs = await db.query(
      `SELECT doc_type, COUNT(*)::int AS n FROM books_documents
       WHERE client_id = $1 AND status = 'draft' AND deleted_at IS NULL
       GROUP BY doc_type`,
      [clientId],
    );
    const inbox = await db.query(
      `SELECT LOWER(COALESCE(intended_type, detected_type, '')) AS t, COUNT(*)::int AS n
       FROM books_inbox_items WHERE client_id = $1 AND status = 'needs_review'
       GROUP BY 1`,
      [clientId],
    );
    const stmtReview = await db.query(
      `SELECT COUNT(*)::int AS n FROM books_statement_extractions
       WHERE client_id = $1 AND status = 'needs_review'`,
      [clientId],
    );
    const bank = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE review_status = 'needs_review')::int AS needs_review,
         COUNT(*) FILTER (WHERE review_status = 'ready')::int AS ready
       FROM books_bank_transactions WHERE client_id = $1`,
      [clientId],
    );
    const unassigned = await db.query(
      `SELECT COUNT(*)::int AS n FROM books_inbox_items
       WHERE client_id IS NULL AND status NOT IN ('confirmed', 'routed')`,
    );
    const ranges = await db.query(
      `SELECT account_id, iban, period_from, period_to FROM books_statement_extractions
       WHERE client_id = $1 AND status <> 'failed' AND period_from IS NOT NULL AND period_to IS NOT NULL`,
      [clientId],
    );
    const activity = await db.query(
      `SELECT account_id::text AS id, COUNT(*)::int AS n
       FROM books_bank_transactions
       WHERE client_id = $1 AND txn_date BETWEEN $2::date AND $3::date
       GROUP BY account_id`,
      [clientId, period.start, period.end],
    );
    const client = await db.query(
      `SELECT establishment_emirate, vat_return_frequency, vat_period_end_month
       FROM clients WHERE id = $1`,
      [clientId],
    );
    return { docs, inbox, stmtReview, bank, unassigned, ranges, activity, client };
  });

  const docBy = new Map(counts.docs.rows.map((r) => [String(r.doc_type), Number(r.n)]));
  let inboxPurchase = 0;
  let inboxSales = 0;
  for (const r of counts.inbox.rows) {
    const bucket = inboxQueueBucket(String(r.t));
    if (bucket === "statement") continue; // counted via statement extractions
    if (bucket === "purchase") inboxPurchase += Number(r.n);
    else if (bucket === "sales") inboxSales += Number(r.n);
  }
  const purchaseBills = (docBy.get("purchase_bill") || 0) + inboxPurchase;
  const salesInvoices = (docBy.get("sales_invoice") || 0) + inboxSales;
  const notes = (docBy.get("credit_note") || 0) + (docBy.get("debit_note") || 0);
  const statementsToReview = Number(counts.stmtReview.rows[0].n);

  const activityByAccount = new Map(
    counts.activity.rows.map((r) => [String(r.id), Number(r.n) > 0]),
  );
  const coverage: StatementCoverageItem[] = accounts.map((a) => {
    const instrumentType = (a.instrumentType || "bank") as BankInstrumentType;
    const applicable = statementCoverageApplicable({
      instrumentType,
      setupOk: a.setupOk,
      ledgerBalanceMinor: a.ledgerBalanceMinor,
      hasPeriodActivity: Boolean(activityByAccount.get(a.id)),
    });
    const nib = normalizeIban(a.iban);
    const periods = counts.ranges.rows
      .filter(
        (s) =>
          String(s.account_id || "") === a.id ||
          (!s.account_id && nib && normalizeIban(s.iban as string | null) === nib),
      )
      .map((s) => ({ from: iso(s.period_from), to: iso(s.period_to) }));
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      setupOk: a.setupOk,
      state: applicable ? coverageState(periods, period.start, period.end) : "n/a",
      coverageTo: a.coverageTo,
      instrumentType,
      requiresStatement: applicable,
    };
  });
  const requiredCoverage = coverage.filter((x) => x.requiresStatement);

  const c = counts.client.rows[0] || {};
  const freq = (c.vat_return_frequency as VatFrequency | null) || null;
  const emirate = (c.establishment_emirate as string | null) || null;
  // Due dates only when establishment emirate and return period are both set (item 8).
  let vat: BooksMonthChecklist["periodStatus"]["vat"] = { set: false };
  if (freq && emirate) {
    const v = vatPeriodForMonth(period.end, freq, c.vat_period_end_month as number | null);
    const today = opts?.today || new Date().toISOString().slice(0, 10);
    const daysUntilDue = Math.round(
      (Date.parse(`${v.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000,
    );
    vat = { set: true, frequency: freq, ...v, daysUntilDue };
  }

  const issues = await listBooksIssuesMerged(userId, clientId, { periodId: period.id });

  return {
    period,
    statements: {
      ok:
        requiredCoverage.length === 0 ||
        requiredCoverage.every((x) => x.state === "covered"),
      accounts: coverage,
      href: "/books/banking",
    },
    documentsToReview: {
      count: purchaseBills + salesInvoices + notes + statementsToReview,
      purchaseBills,
      salesInvoices,
      notes,
      statements: statementsToReview,
      hrefs: {
        purchaseBills: documentsToReviewHref("purchase"),
        salesInvoices: documentsToReviewHref("sales"),
        notes: documentsToReviewHref("notes"),
        statements: documentsToReviewHref("statement"),
      },
      // Open the queue that actually has work (bills first, then invoices, then statements).
      href:
        purchaseBills > 0
          ? documentsToReviewHref("purchase")
          : salesInvoices + notes > 0
            ? documentsToReviewHref("sales")
            : statementsToReview > 0
              ? documentsToReviewHref("statement")
              : documentsToReviewHref("purchase"),
    },
    bankLines: {
      needsReview: Number(counts.bank.rows[0].needs_review),
      readyNotPosted: Number(counts.bank.rows[0].ready),
      href: "/books/transactions",
    },
    unassignedInbox: { count: Number(counts.unassigned.rows[0].n), href: "/books/inbox?unassigned=1" },
    periodStatus: {
      status: period.status,
      locked: !["OPEN", "REOPENED"].includes(period.status),
      vat,
      href: "/books/settings",
    },
    issues: { count: issues.length, href: "/books#issues" },
  };
}
