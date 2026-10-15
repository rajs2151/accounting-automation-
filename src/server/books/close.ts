/**
 * P5-1: books month-end close checklist + lock gate.
 * Ports the structure of src/server/close.ts onto books tables / gates.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { formatMinor } from "@/lib/money";
import { writeBooksAudit } from "@/server/books/audit";
import { listBankReconciliations } from "@/server/books/bank-recon";
import { formatMoneyAmount } from "@/lib/money-display";
import { controlVsOpenItemsDrift } from "@/server/books/control-drift";
import { getBooksMonthChecklist, vatPeriodForMonth, type VatFrequency } from "@/server/books/dashboard";
import { requireApproverOrAdmin } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { missingPostedDepreciation } from "@/server/books/fixed-assets";
import { fxRevaluationGateState } from "@/server/books/fx-revaluation";
import { lockBooksPeriod, priorPeriodLockState, reopenBooksPeriod } from "@/server/books/periods";
import { queryPlaceOfSupplyGaps } from "@/server/books/place-of-supply";
import { booksTrialBalance } from "@/server/books/trial-balance";
import { booksAdvancesPanel } from "@/server/books/advances-panel";
import {
  booksCtAccrualPreview,
  ctAccrualGateFromAmounts,
} from "@/server/books/ct-accrual";
import { loanInterestGateState } from "@/server/books/loans";
import { generateVat201Draft } from "@/server/books/vat201";
import { assertSyntheticTenant } from "@/server/security-gate";

export const CLOSE_GATE_KEYS = [
  "statements",
  "bank_lines",
  "bank_recon",
  "suspense",
  "clearing_gateway",
  "clearing_info",
  "scheduled",
  "unposted_drafts",
  "inbox_unreviewed",
  "vat_control",
  "ar_ap_tieout",
  "missing_documents",
  "depreciation",
  "fx_revaluation",
  "prepaid_release",
  "ct_accrual",
  "salaries_payable",
  "advances_drift",
  "eosb_provision",
  "loan_interest",
  "staff_advances",
  "prior_period_locked",
] as const;

export type CloseGateKey = (typeof CLOSE_GATE_KEYS)[number];

export type CloseGateStatus = "pass" | "fail" | "waived" | "info" | "not_set_up";

export type CloseGate = {
  key: CloseGateKey;
  label: string;
  status: CloseGateStatus;
  /** Blocking fail unless waived. info / not_set_up never block lock once waived. */
  blocking: boolean;
  count: number;
  href: string;
  detail?: string;
  balanceMinor?: number;
  waiverReason?: string | null;
  /** Pending dual-control waive request awaiting a different approver. */
  pendingWaiver?: { reason: string; requestedBy: string } | null;
};

export type BooksCloseChecklist = {
  period: {
    id: string;
    label: string;
    start: string;
    end: string;
    status: string;
    changedSinceClose: boolean;
  };
  gates: CloseGate[];
  ready: boolean;
  failing: CloseGateKey[];
};

export class CloseGatesFailingError extends BooksError {
  readonly failingGates: CloseGate[];
  constructor(failingGates: CloseGate[]) {
    super("close_gates_failing", "conflict");
    this.name = "CloseGatesFailingError";
    this.failingGates = failingGates;
  }
}

const GATEWAY_CLEARING = ["1310", "1320", "1330", "1340"] as const;
// Info only: client disbursements recoverable (1220) and credit-card clearing (1130). 1300 is the
// non-postable Clearing header (its children are the gateway/suspense gates). Customer advances
// (2320) are an ordinary liability, not a clearing account, so they are not checked here.
const INFO_CLEARING = ["1220", "1130"] as const;

const RECON_STATUS_TEXT: Record<string, string> = {
  no_statement: "no statement",
  difference: "statement doesn't match the ledger",
};
const COVERAGE_STATE_TEXT: Record<string, string> = {
  gap: "statements have a gap",
  missing: "no statement",
};

/** "1310 Payment gateway clearing (Stripe) — AED 12.50 Dr" for a non-zero closing balance. */
function balanceText(
  tb: Awaited<ReturnType<typeof booksTrialBalance>>,
  code: string,
  netMinor: number,
): string {
  const name = tb.accounts[code]?.name;
  return `${code}${name ? ` ${name}` : ""} — AED ${formatMinor(Math.abs(netMinor))} ${netMinor > 0 ? "Dr" : "Cr"}`;
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function closingNetMinor(tb: Awaited<ReturnType<typeof booksTrialBalance>>, code: string): number {
  const a = tb.accounts[code];
  if (!a) return 0;
  return a.closingDebitMinor - a.closingCreditMinor;
}

async function loadWaivers(
  db: PoolClient,
  clientId: string,
  periodId: string,
): Promise<{
  byGate: Map<string, string>;
  byAccount: Map<string, string>;
  pendingByGate: Map<string, { reason: string; requestedBy: string }>;
}> {
  // Active waivers unlock-invalidated; pending shown until confirmed or superseded.
  const rows = await db.query(
    `SELECT w.gate_key, w.reason, w.account_id, w.status, w.requested_by
     FROM books_close_waivers w
     WHERE w.client_id = $1 AND w.period_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM books_audit_events a
         WHERE a.client_id = w.client_id
           AND a.entity = 'books_period'
           AND a.entity_id = w.period_id
           AND a.action = 'unlock'
           AND a.at >= w.at
       )`,
    [clientId, periodId],
  );
  const byGate = new Map<string, string>();
  const byAccount = new Map<string, string>();
  const pendingByGate = new Map<string, { reason: string; requestedBy: string }>();
  for (const r of rows.rows) {
    const key = String(r.gate_key);
    const acct = r.account_id ? String(r.account_id) : null;
    const status = String(r.status || "active");
    if (status === "pending" && !acct) {
      pendingByGate.set(key, {
        reason: String(r.reason),
        requestedBy: String(r.requested_by || ""),
      });
      continue;
    }
    if (status !== "active") continue;
    if (acct) byAccount.set(`${key}:${acct}`, String(r.reason));
    else byGate.set(key, String(r.reason));
  }
  return { byGate, byAccount, pendingByGate };
}

/** 2210 (output, Cr−Dr) and 1430 (input, Dr−Cr) movement for posted/reversed entries by entry_date. */
export async function vatControlMovement(
  db: PoolClient,
  clientId: string,
  from: string,
  to: string,
): Promise<{ vatOutMinor: number; vatInMinor: number }> {
  const rows = await db.query(
    `SELECT a.code,
            COALESCE(SUM(l.debit_minor), 0)::bigint AS debit,
            COALESCE(SUM(l.credit_minor), 0)::bigint AS credit
     FROM books_journal_lines l
     JOIN books_journal_entries e ON e.id = l.entry_id
     JOIN books_accounts a ON a.id = l.account_id
     WHERE e.client_id = $1
       AND e.status IN ('posted', 'reversed')
       AND e.deleted_at IS NULL
       AND e.entry_date BETWEEN $2::date AND $3::date
       AND a.client_id = $1
       AND a.code IN ('2210', '1430')
       -- A VAT settlement (2210/1430 netted to 2220 payable / 1440 refund) clears the controls; it is
       -- not VAT charged in the period, so it must not offset the Box 8 / Box 11 comparison.
       AND NOT EXISTS (
         SELECT 1 FROM books_journal_lines sl
         JOIN books_accounts sa ON sa.id = sl.account_id
         WHERE sl.entry_id = e.id AND sa.client_id = $1 AND sa.code IN ('2220', '1440')
       )
     GROUP BY a.code`,
    [clientId, from, to],
  );
  let vatOutMinor = 0;
  let vatInMinor = 0;
  for (const r of rows.rows) {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    if (String(r.code) === "2210") vatOutMinor = credit - debit;
    else vatInMinor = debit - credit;
  }
  return { vatOutMinor, vatInMinor };
}

function applyWaiver(
  gate: CloseGate,
  waivers: {
    byGate: Map<string, string>;
    pendingByGate: Map<string, { reason: string; requestedBy: string }>;
  },
): CloseGate {
  const pending = waivers.pendingByGate.get(gate.key) || null;
  const reason = waivers.byGate.get(gate.key);
  if (reason && (gate.status === "fail" || gate.status === "not_set_up") && gate.blocking) {
    return { ...gate, status: "waived", waiverReason: reason, pendingWaiver: null };
  }
  return { ...gate, waiverReason: reason || null, pendingWaiver: pending };
}

export async function getBooksCloseChecklist(
  userId: string,
  clientId: string,
  periodId: string,
): Promise<BooksCloseChecklist> {
  const month = await getBooksMonthChecklist(userId, clientId, { periodId });
  const tb = await booksTrialBalance(userId, clientId, periodId, { includeZeroBalances: true });
  const recons = await listBankReconciliations(userId, clientId, { periodId });

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const periodRow = await db.query(
      `SELECT id, label, period_start, period_end, status,
              COALESCE(changed_since_close, false) AS changed_since_close
       FROM books_periods WHERE id = $1 AND client_id = $2`,
      [periodId, clientId],
    );
    if (!periodRow.rowCount) throw new BooksError("period_not_found", "not_found");
    const start = iso(periodRow.rows[0].period_start);
    const end = iso(periodRow.rows[0].period_end);
    const waivers = await loadWaivers(db, clientId, periodId);

    // D2: prior month in the same fiscal year must be LOCKED (or this is books-start / FY first).
    const priorLock = await priorPeriodLockState(db, clientId, periodId);
    const priorPeriodLockedGate: CloseGate = {
      key: "prior_period_locked",
      label: "Prior period locked (sequential)",
      status: priorLock.ok ? "pass" : "fail",
      blocking: true,
      count: priorLock.ok ? 0 : 1,
      href: "/books/close",
      detail: priorLock.detail,
    };

    // 1. Statements — only accounts that require coverage (set up + activity/balance).
    const requiredStmt = month.statements.accounts.filter((a) => a.requiresStatement);
    const uncovered = requiredStmt.filter(
      (a) => a.state !== "covered" && !waivers.byAccount.has(`statements:${a.accountId}`),
    );
    const statementsOk = requiredStmt.length === 0 || uncovered.length === 0;
    const statements: CloseGate = {
      key: "statements",
      label: "Bank / card / gateway statement coverage",
      status: statementsOk ? "pass" : "fail",
      blocking: true,
      count: uncovered.length,
      href: "/books/banking",
      detail: uncovered.length
        ? uncovered
            .map((a) => `${a.code} ${a.name} — ${COVERAGE_STATE_TEXT[a.state] || a.state}`)
            .join("; ")
        : requiredStmt.length === 0
          ? "No accounts need statements this period"
          : undefined,
    };

    // 2. Bank lines in period still needs_review or ready
    const bankOpen = await db.query(
      `SELECT COUNT(*)::int AS n FROM books_bank_transactions
       WHERE client_id = $1
         AND txn_date BETWEEN $2::date AND $3::date
         AND review_status IN ('needs_review', 'ready')`,
      [clientId, start, end],
    );
    const bankOpenN = Number(bankOpen.rows[0].n);
    const bankLines: CloseGate = {
      key: "bank_lines",
      label: "Bank lines reviewed and posted",
      status: bankOpenN === 0 ? "pass" : "fail",
      blocking: true,
      count: bankOpenN,
      href: "/books/transactions",
    };

    // 3. Bank recon — only for accounts that required (and have) statement coverage.
    // Missing coverage is owned by the statements gate (no double-count).
    const requiredIds = new Set(requiredStmt.map((a) => a.accountId));
    const coveredIds = new Set(
      requiredStmt.filter((a) => a.state === "covered").map((a) => a.accountId),
    );
    const reconDiffs = recons.filter((r) => {
      if (!requiredIds.has(r.accountId) || !coveredIds.has(r.accountId)) return false;
      if (waivers.byAccount.has(`bank_recon:${r.accountId}`)) return false;
      return r.status === "difference";
    });
    const bankRecon: CloseGate = {
      key: "bank_recon",
      label: "Bank reconciliation (difference = 0)",
      status: reconDiffs.length === 0 ? "pass" : "fail",
      blocking: true,
      count: reconDiffs.length,
      href: "/books/banking",
      detail:
        reconDiffs
          .map((r) => `${r.code} ${r.name} — ${RECON_STATUS_TEXT[r.status] || r.status}`)
          .join("; ") || undefined,
    };

    // 4. Suspense 1390
    const suspenseBal = closingNetMinor(tb, "1390");
    let suspenseEntries = 0;
    if (suspenseBal !== 0) {
      const se = await db.query(
        `SELECT COUNT(DISTINCT e.id)::int AS n
         FROM books_journal_entries e
         JOIN books_journal_lines l ON l.entry_id = e.id
         JOIN books_accounts a ON a.id = l.account_id
         WHERE e.client_id = $1 AND e.deleted_at IS NULL
           AND e.status IN ('posted', 'reversed')
           AND e.entry_date <= $2::date
           AND a.code = '1390'`,
        [clientId, end],
      );
      suspenseEntries = Number(se.rows[0].n);
    }
    const suspense: CloseGate = {
      key: "suspense",
      label: "Suspense (1390) closing balance",
      status: suspenseBal === 0 ? "pass" : "fail",
      blocking: true,
      count: suspenseBal === 0 ? 0 : suspenseEntries,
      href: "/books/reports/trial-balance",
      balanceMinor: suspenseBal,
    };

    // 5a. Gateway / transfer clearing must net to 0
    let gatewayFail = 0;
    const gatewayParts: string[] = [];
    for (const code of GATEWAY_CLEARING) {
      const bal = closingNetMinor(tb, code);
      if (bal !== 0) {
        gatewayFail += 1;
        gatewayParts.push(balanceText(tb, code, bal));
      }
    }
    const clearingGateway: CloseGate = {
      key: "clearing_gateway",
      label: "Gateway / POS / transfer clearing (1310–1340)",
      status: gatewayFail === 0 ? "pass" : "fail",
      blocking: true,
      count: gatewayFail,
      href: "/books/reports/trial-balance",
      detail: gatewayParts.join("; ") || undefined,
    };

    // 5b. Info clearing — never auto-fail
    const infoParts: string[] = [];
    for (const code of INFO_CLEARING) {
      const bal = closingNetMinor(tb, code);
      if (bal !== 0) infoParts.push(balanceText(tb, code, bal));
    }
    const clearingInfo: CloseGate = {
      key: "clearing_info",
      label: "Disbursements recoverable (1220) and card clearing (1130) — info",
      status: "info",
      blocking: false,
      count: infoParts.length,
      href: "/books/reports/trial-balance",
      detail: infoParts.join("; ") || "1220 and 1130 are both zero",
    };

    // 6. Scheduled / recurring due in period still unposted
    const scheduled = await db.query(
      `SELECT COUNT(*)::int AS n FROM books_journal_entries
       WHERE client_id = $1 AND deleted_at IS NULL
         AND status IN ('scheduled', 'draft')
         AND (
           (scheduled_for IS NOT NULL AND scheduled_for::date BETWEEN $2::date AND $3::date)
           OR (status = 'scheduled' AND entry_date BETWEEN $2::date AND $3::date)
         )`,
      [clientId, start, end],
    );
    let recurringDue = 0;
    const hasRecurring = await db.query(`SELECT to_regclass('books_recurring_templates') AS t`);
    if (hasRecurring.rows[0]?.t) {
      const rec = await db.query(
        `SELECT COUNT(*)::int AS n FROM books_recurring_templates
         WHERE client_id = $1 AND active = true AND remaining > 0
           AND next_date BETWEEN $2::date AND $3::date`,
        [clientId, start, end],
      );
      recurringDue = Number(rec.rows[0].n);
    }
    const dueN = Number(scheduled.rows[0].n) + recurringDue;
    const scheduledGate: CloseGate = {
      key: "scheduled",
      label: "Scheduled / recurring entries posted",
      status: dueN === 0 ? "pass" : "fail",
      blocking: true,
      count: dueN,
      href: "/books/journals?status=scheduled",
      detail: dueN === 0 ? "Nothing due in this period" : `${dueN} still unposted`,
    };

    const prepaidPending = await db.query(
      `SELECT COUNT(*)::int AS n FROM books_prepaid_schedules
       WHERE client_id = $1
         AND status IN ('pending', 'blocked')
         AND release_date BETWEEN $2::date AND $3::date`,
      [clientId, start, end],
    );
    const prepaidN = Number(prepaidPending.rows[0].n);
    const prepaidReleaseGate: CloseGate = {
      key: "prepaid_release",
      label: "Prepaid expense amortisation posted",
      status: prepaidN === 0 ? "pass" : "fail",
      blocking: true,
      count: prepaidN,
      href: "/books/purchases",
      detail:
        prepaidN === 0
          ? "No pending prepaid releases in this period"
          : `${prepaidN} prepaid release(s) still pending or blocked`,
    };

    // 6b. Unposted drafts — draft / scheduled journals dated inside the period that the scheduled
    // gate above does not already count (a draft dated 25/05 must not slip past a May lock).
    // The year-end closing draft is excluded: its two-step post (year-end.ts) needs this checklist
    // ready, and the Close page tracks it separately ("Post year-end entry").
    const drafts = await db.query(
      `SELECT entry_no, entry_date, memo FROM books_journal_entries
       WHERE client_id = $1 AND deleted_at IS NULL
         AND status IN ('draft', 'scheduled')
         AND entry_type <> 'closing'
         AND entry_date BETWEEN $2::date AND $3::date
         AND NOT (
           (scheduled_for IS NOT NULL AND scheduled_for::date BETWEEN $2::date AND $3::date)
           OR status = 'scheduled'
         )
       ORDER BY entry_date, created_at`,
      [clientId, start, end],
    );
    const draftN = drafts.rowCount ?? 0;
    const draftList = drafts.rows
      .slice(0, 5)
      .map((r) => {
        const what = r.entry_no ? String(r.entry_no) : String(r.memo || "").trim() || "Draft";
        return `${what} (${iso(r.entry_date)})`;
      })
      .join("; ");
    const unpostedDrafts: CloseGate = {
      key: "unposted_drafts",
      label: "Unposted drafts dated in the period",
      status: draftN === 0 ? "pass" : "fail",
      blocking: true,
      count: draftN,
      href: "/books/journals",
      detail: draftN ? `${draftList}${draftN > 5 ? `; and ${draftN - 5} more` : ""}` : undefined,
    };

    // 6c. Unreviewed inbox (blocking)
    const inboxReview = await db.query(
      `SELECT COUNT(*)::int AS n FROM books_inbox_items
       WHERE client_id = $1 AND status = 'needs_review'`,
      [clientId],
    );
    const inboxN = Number(inboxReview.rows[0].n);
    const inboxUnreviewed: CloseGate = {
      key: "inbox_unreviewed",
      label: "Unreviewed inbox documents",
      status: inboxN === 0 ? "pass" : "fail",
      blocking: true,
      count: inboxN,
      href: "/books/inbox",
      detail: inboxN ? `${inboxN} document(s) still need review` : undefined,
    };

    // 7. VAT control — emirate + return period required; otherwise not configured (fail).
    const client = await db.query(
      `SELECT establishment_emirate, vat_return_frequency, vat_period_end_month FROM clients WHERE id = $1`,
      [clientId],
    );
    const freq = (client.rows[0]?.vat_return_frequency as VatFrequency | null) || null;
    const emirate = (client.rows[0]?.establishment_emirate as string | null) || null;
    let vatGate: CloseGate;
    if (!freq || !emirate) {
      vatGate = {
        key: "vat_control",
        label: "VAT control",
        status: "not_set_up",
        blocking: true,
        count: 1,
        href: "/books/settings",
        detail: !emirate && !freq
          ? "Not configured — set establishment emirate and VAT return period in Settings"
          : !emirate
            ? "Not configured — set establishment emirate in Settings"
            : "Not configured — set VAT return period in Settings",
      };
    } else {
      const vatWindow = vatPeriodForMonth(end, freq, client.rows[0].vat_period_end_month as number | null);
      if (vatWindow.periodEnd !== end) {
        vatGate = {
          key: "vat_control",
          label: "VAT control",
          status: "pass",
          blocking: true,
          count: 0,
          href: "/books/reports/vat201",
          detail: "Not a VAT period end",
        };
      } else {
        const gaps = await queryPlaceOfSupplyGaps(db, clientId, {
          from: vatWindow.periodStart,
          to: vatWindow.periodEnd,
        });
        let draftOk = true;
        let detail = "";
        try {
          const draft = await generateVat201Draft(userId, clientId, {
            from: vatWindow.periodStart,
            to: vatWindow.periodEnd,
          });
          // Movement over the same VAT window as the draft (a quarter for quarterly filers),
          // not the month: output Cr−Dr on 2210, input Dr−Cr on 1430.
          const { vatOutMinor: vatOutPeriod, vatInMinor: vatInPeriod } = await vatControlMovement(
            db,
            clientId,
            vatWindow.periodStart,
            vatWindow.periodEnd,
          );
          const box8 = draft.box8.vatMinor;
          const box11 = draft.box11.vatMinor;
          if (box8 !== vatOutPeriod || box11 !== vatInPeriod) {
            draftOk = false;
            detail = `Box8 ${box8} vs 2210 ${vatOutPeriod}; Box11 ${box11} vs 1430 ${vatInPeriod}`;
          }
        } catch (err) {
          draftOk = false;
          detail = err instanceof Error ? err.message : "vat_draft_failed";
        }
        const fail = gaps.length > 0 || !draftOk;
        vatGate = {
          key: "vat_control",
          label: "VAT control (201 draft + 2210/1430)",
          status: fail ? "fail" : "pass",
          blocking: true,
          count: gaps.length + (draftOk ? 0 : 1),
          href: "/books/reports/vat201",
          detail: [
            gaps.length ? `${gaps.length} place-of-supply gap(s)` : null,
            detail || null,
          ]
            .filter(Boolean)
            .join("; ") || undefined,
        };
      }
    }

    // 8. Missing documents — information only (category posts without a linked document)
    const missingDocs = await db.query(
      `SELECT COUNT(*)::int AS n
       FROM books_bank_transactions t
       WHERE t.client_id = $1
         AND t.txn_date BETWEEN $2::date AND $3::date
         AND t.review_status = 'posted'
         AND t.journal_entry_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM books_documents d
           WHERE d.client_id = t.client_id
             AND d.journal_entry_id = t.journal_entry_id
             AND d.deleted_at IS NULL
         )`,
      [clientId, start, end],
    );
    const missingN = Number(missingDocs.rows[0].n);
    const missingDocuments: CloseGate = {
      key: "missing_documents",
      label: "Missing documents (category posts)",
      status: "info",
      blocking: false,
      count: missingN,
      href: "/books/transactions?status=posted",
      detail: "Information only — does not block lock",
    };

    // AR/AP control vs open items (month-end tie-out)
    let arApGate: CloseGate;
    try {
      const drift = await controlVsOpenItemsDrift(userId, clientId, periodId);
      const parts: string[] = [];
      if (drift.ar.driftMinor !== 0) {
        parts.push(
          `AR ${formatMoneyAmount({ amountMinor: drift.ar.controlMinor })} vs open ${formatMoneyAmount({ amountMinor: drift.ar.openMinor })}`,
        );
      }
      if (drift.ap.driftMinor !== 0) {
        parts.push(
          `AP ${formatMoneyAmount({ amountMinor: drift.ap.controlMinor })} vs open ${formatMoneyAmount({ amountMinor: drift.ap.openMinor })}`,
        );
      }
      arApGate = {
        key: "ar_ap_tieout",
        label: "AR/AP control vs open items",
        status: parts.length ? "fail" : "pass",
        blocking: true,
        count: parts.length,
        href: "/books/reports/ageing?side=ar",
        detail: parts.length ? parts.join("; ") : "Controls match open items",
      };
    } catch {
      arApGate = {
        key: "ar_ap_tieout",
        label: "AR/AP control vs open items",
        status: "fail",
        blocking: true,
        count: 1,
        href: "/books/reports/ageing?side=ar",
        detail: "Could not compute tie-out",
      };
    }

    const missingDepr = await missingPostedDepreciation(db, clientId, periodId, start, end);
    const depreciation: CloseGate = {
      key: "depreciation",
      label: "Depreciation",
      status: missingDepr.length === 0 ? "pass" : "fail",
      blocking: true,
      count: missingDepr.length,
      href: "/books/fixed-assets",
      detail:
        missingDepr.length === 0
          ? "All active assets have posted depreciation for this period (or none due)"
          : `Missing posted run: ${missingDepr.map((a) => a.name).join(", ")}`,
    };
    const fxState = await fxRevaluationGateState(db, clientId, periodId, end);
    const fx: CloseGate = {
      key: "fx_revaluation",
      label: "FX revaluation",
      status: fxState.status,
      blocking: true,
      count: fxState.count,
      href: "/books/settings#fx-rates",
      detail: fxState.detail,
    };

    let ctAccrualGate: CloseGate;
    try {
      // Leave nested withUser via preview (same pattern as VAT draft inside this checklist).
      const ctPrev = await booksCtAccrualPreview(userId, clientId, periodId);
      const ctState = ctAccrualGateFromAmounts({
        estimateMinor: ctPrev.estimateMinor,
        bookedPayableMinor: ctPrev.bookedPayableMinor,
        isFiscalYearEnd: ctPrev.isFiscalYearEnd,
        noTaxDueRecorded: ctPrev.noTaxDueRecorded,
      });
      ctAccrualGate = {
        key: "ct_accrual",
        label: "Corporate tax accrual (estimate vs 2230)",
        status: ctState.status,
        blocking: ctState.blocking,
        count: ctState.count,
        href: ctState.href,
        detail: ctState.detail,
      };
    } catch (err) {
      ctAccrualGate = {
        key: "ct_accrual",
        label: "Corporate tax accrual (estimate vs 2230)",
        status: "fail",
        blocking: true,
        count: 1,
        href: "/books/journals",
        detail: err instanceof Error ? err.message : "ct_accrual_failed",
      };
    }

    // Info only: unpaid salaries sitting on 2330 (payroll accrued, not yet paid).
    const salariesNet = closingNetMinor(tb, "2330");
    const salariesPayableMinor = Math.max(0, -salariesNet);
    const salariesPayableGate: CloseGate = {
      key: "salaries_payable",
      label: "Unpaid salaries (2330)",
      status: salariesPayableMinor === 0 ? "pass" : "info",
      blocking: false,
      count: salariesPayableMinor === 0 ? 0 : 1,
      href: "/books/journals",
      detail:
        salariesPayableMinor === 0
          ? "No salaries payable balance"
          : balanceText(tb, "2330", salariesNet),
      balanceMinor: salariesPayableMinor || undefined,
    };

    let advancesDriftGate: CloseGate;
    try {
      const adv = await booksAdvancesPanel(userId, clientId);
      advancesDriftGate = {
        key: "advances_drift",
        label: "Customer advances 2320 vs subledger",
        status: adv.drift ? "info" : "pass",
        blocking: false,
        count: adv.drift ? 1 : 0,
        href: "/books/advances",
        detail: adv.drift
          ? `GL ${formatMoneyAmount({ amountMinor: adv.gl2320CreditMinor })} vs subledger ${formatMoneyAmount({ amountMinor: adv.subledgerAedMinor })} (gap ${formatMoneyAmount({ amountMinor: adv.driftMinor })})`
          : "2320 matches party advances",
        balanceMinor: adv.drift ? Math.abs(adv.driftMinor) : undefined,
      };
    } catch {
      advancesDriftGate = {
        key: "advances_drift",
        label: "Customer advances 2320 vs subledger",
        status: "info",
        blocking: false,
        count: 1,
        href: "/books/advances",
        detail: "Could not compute advances tie-out",
      };
    }

    // Info: EOSB provision (2410) had no posted movement this period while salaries expense did.
    const eosbMove = await db.query(
      `SELECT COALESCE(SUM(ABS(l.debit_minor) + ABS(l.credit_minor)), 0)::bigint AS n
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_accounts a ON a.id = l.account_id
       WHERE e.client_id = $1 AND e.status IN ('posted','reversed') AND e.deleted_at IS NULL
         AND e.entry_date BETWEEN $2::date AND $3::date
         AND a.client_id = $1 AND a.code = '2410'`,
      [clientId, start, end],
    );
    const payrollExp = await db.query(
      `SELECT COALESCE(SUM(l.debit_minor), 0)::bigint AS n
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_accounts a ON a.id = l.account_id
       WHERE e.client_id = $1 AND e.status IN ('posted','reversed') AND e.deleted_at IS NULL
         AND e.entry_date BETWEEN $2::date AND $3::date
         AND a.client_id = $1 AND a.code IN ('6100','6110')`,
      [clientId, start, end],
    );
    const eosbMoved = Number(eosbMove.rows[0].n) > 0;
    const hadPayroll = Number(payrollExp.rows[0].n) > 0;
    const eosbStale = hadPayroll && !eosbMoved;
    const eosbProvisionGate: CloseGate = {
      key: "eosb_provision",
      label: "EOSB provision (2410)",
      status: eosbStale ? "info" : "pass",
      blocking: false,
      count: eosbStale ? 1 : 0,
      href: "/books/journals",
      detail: eosbStale
        ? "Salaries posted this period but 2410 had no movement — consider Create Entry → EOSB accrual"
        : eosbMoved
          ? "2410 moved this period"
          : "No payroll expense this period",
    };

    const loanState = await loanInterestGateState(db, clientId, periodId, start, end);
    const loanInterestGate: CloseGate = {
      key: "loan_interest",
      label: "Loan interest accrual",
      status: loanState.status,
      blocking: true,
      count: loanState.count,
      href: "/books/loans",
      detail: loanState.detail,
    };

    // Info: outstanding employee advances on 1230.
    const staffNet = closingNetMinor(tb, "1230");
    const staffAdvanceMinor = Math.max(0, staffNet);
    const staffAdvancesGate: CloseGate = {
      key: "staff_advances",
      label: "Employee advances (1230)",
      status: staffAdvanceMinor === 0 ? "pass" : "info",
      blocking: false,
      count: staffAdvanceMinor === 0 ? 0 : 1,
      href: "/books/journals",
      detail:
        staffAdvanceMinor === 0
          ? "No employee advances outstanding"
          : balanceText(tb, "1230", staffNet),
      balanceMinor: staffAdvanceMinor || undefined,
    };

    const gates = [
      priorPeriodLockedGate,
      statements,
      bankLines,
      bankRecon,
      suspense,
      clearingGateway,
      clearingInfo,
      scheduledGate,
      prepaidReleaseGate,
      unpostedDrafts,
      inboxUnreviewed,
      vatGate,
      arApGate,
      missingDocuments,
      depreciation,
      fx,
      ctAccrualGate,
      salariesPayableGate,
      advancesDriftGate,
      eosbProvisionGate,
      loanInterestGate,
      staffAdvancesGate,
    ].map((g) => applyWaiver(g, waivers));

    const failing = gates
      .filter((g) => g.blocking && (g.status === "fail" || g.status === "not_set_up"))
      .map((g) => g.key);

    return {
      period: {
        id: String(periodRow.rows[0].id),
        label: String(periodRow.rows[0].label),
        start,
        end,
        status: String(periodRow.rows[0].status),
        changedSinceClose: Boolean(periodRow.rows[0].changed_since_close),
      },
      gates,
      ready: failing.length === 0,
      failing,
    };
  });
}

/**
 * Dual-control waive: accountant/approver requests (pending); a different approver/admin confirms (active).
 * Optional accountId for per-account statements/recon waivers.
 */
export async function waiveBooksCloseGate(
  userId: string,
  clientId: string,
  periodId: string,
  gateKey: string,
  reason: string,
  opts?: { accountId?: string | null; action?: "request" | "confirm" },
) {
  const trimmed = String(reason || "").trim();
  if (!trimmed) throw new BooksError("waiver_reason_required", "invalid");
  if (!(CLOSE_GATE_KEYS as readonly string[]).includes(gateKey)) {
    throw new BooksError("invalid_close_gate", "invalid");
  }
  const accountId = opts?.accountId?.trim() || null;
  const action = opts?.action === "confirm" ? "confirm" : "request";

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const period = await db.query(
      `SELECT id, status FROM books_periods WHERE id = $1 AND client_id = $2`,
      [periodId, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
      throw new BooksError("period_locked", "period_closed");
    }

    if (accountId) {
      const acct = await db.query(
        `SELECT id FROM books_accounts WHERE id = $1 AND client_id = $2`,
        [accountId, clientId],
      );
      if (!acct.rowCount) throw new BooksError("account_not_found", "not_found");
    }

    const existing = await db.query(
      `SELECT id, status, requested_by, reason FROM books_close_waivers
       WHERE client_id = $1 AND period_id = $2 AND gate_key = $3
         AND COALESCE(account_id, '00000000-0000-0000-0000-000000000000')
           = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000')`,
      [clientId, periodId, gateKey, accountId],
    );

    if (action === "request") {
      // Any books writer with access may request; confirm needs approver ≠ requester.
      const id = existing.rowCount ? String(existing.rows[0].id) : randomUUID();
      if (existing.rowCount) {
        await db.query(
          `UPDATE books_close_waivers
           SET reason = $2, requested_by = $3, actor = $3, status = 'pending', at = now()
           WHERE id = $1`,
          [id, trimmed, userId],
        );
      } else {
        await db.query(
          `INSERT INTO books_close_waivers
             (id, client_id, period_id, gate_key, reason, actor, requested_by, account_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'pending')`,
          [id, clientId, periodId, gateKey, trimmed, userId, accountId],
        );
      }
      await writeBooksAudit(db, {
        clientId,
        actor: userId,
        action: "request_waive_close_gate",
        entity: "books_period",
        entityId: periodId,
        after: { gate: gateKey, reason: trimmed, accountId, status: "pending" },
      });
      return { ok: true, gateKey, reason: trimmed, status: "pending" as const, accountId };
    }

    // confirm
    await requireApproverOrAdmin(db, userId, "lock");
    if (!existing.rowCount || String(existing.rows[0].status) !== "pending") {
      throw new BooksError("waiver_request_required", "invalid");
    }
    const requestedBy = existing.rows[0].requested_by
      ? String(existing.rows[0].requested_by)
      : null;
    if (requestedBy && requestedBy === userId) {
      throw new BooksError("waiver_dual_control", "forbidden");
    }
    const finalReason = trimmed || String(existing.rows[0].reason || "");
    await db.query(
      `UPDATE books_close_waivers
       SET status = 'active', actor = $2, reason = $3, at = now()
       WHERE id = $1`,
      [String(existing.rows[0].id), userId, finalReason],
    );
    await db.query(
      `INSERT INTO books_close_events (id, client_id, period_id, action, actor, reason, checklist_json)
       VALUES ($1,$2,$3,'WAIVE',$4,$5,$6::jsonb)`,
      [
        randomUUID(),
        clientId,
        periodId,
        userId,
        finalReason,
        JSON.stringify({ gate: gateKey, accountId, requestedBy }),
      ],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "waive_close_gate",
      entity: "books_period",
      entityId: periodId,
      after: { gate: gateKey, reason: finalReason, accountId, status: "active", requestedBy },
    });
    return { ok: true, gateKey, reason: finalReason, status: "active" as const, accountId };
  });
}

export async function lockBooksPeriodWithChecklist(
  userId: string,
  clientId: string,
  periodId: string,
) {
  const checklist = await getBooksCloseChecklist(userId, clientId, periodId);
  if (checklist.period.status === "LOCKED") {
    throw new BooksError("period_already_locked", "conflict");
  }
  if (!checklist.ready) {
    throw new CloseGatesFailingError(
      checklist.gates.filter((g) => g.blocking && (g.status === "fail" || g.status === "not_set_up")),
    );
  }

  const locked = await lockBooksPeriod(userId, clientId, periodId);

  await withUser(userId, async (db) => {
    await db.query(
      `UPDATE books_periods
       SET changed_since_close = false, closed_at = now(), closed_by = $3
       WHERE id = $1 AND client_id = $2`,
      [periodId, clientId, userId],
    );
    await db.query(
      `INSERT INTO books_close_events (id, client_id, period_id, action, actor, reason, checklist_json)
       VALUES ($1,$2,$3,'LOCK',$4,$5,$6::jsonb)`,
      [
        randomUUID(),
        clientId,
        periodId,
        userId,
        "period locked via close checklist",
        JSON.stringify({
          gates: checklist.gates.map((g) => ({ key: g.key, status: g.status, count: g.count })),
        }),
      ],
    );
  });

  return { ...locked, checklist };
}

export async function unlockBooksPeriodWithReason(
  userId: string,
  clientId: string,
  periodId: string,
  reason: string,
) {
  const unlocked = await reopenBooksPeriod(userId, clientId, periodId, reason);
  await withUser(userId, async (db) => {
    await db.query(
      `INSERT INTO books_close_events (id, client_id, period_id, action, actor, reason, checklist_json)
       VALUES ($1,$2,$3,'UNLOCK',$4,$5,$6::jsonb)`,
      [
        randomUUID(),
        clientId,
        periodId,
        userId,
        reason.trim(),
        JSON.stringify({ invalidatedWaivers: unlocked.invalidatedWaivers }),
      ],
    );
  });
  return unlocked;
}

/**
 * Route entry point for the per-period lock / reopen actions (POST periods/:id/lock|reopen).
 * Both go through the close checklist path so gates, close events, waiver invalidation and
 * changed-since-close are applied — never the raw lockBooksPeriod / reopenBooksPeriod.
 */
export async function booksPeriodRouteAction(
  userId: string,
  clientId: string,
  periodId: string,
  action: "lock" | "reopen",
  reason = "",
) {
  if (action === "lock") {
    const locked = await lockBooksPeriodWithChecklist(userId, clientId, periodId);
    return { id: locked.id, status: locked.status, checklist: locked.checklist };
  }
  return unlockBooksPeriodWithReason(userId, clientId, periodId, reason);
}

export async function listBooksCloseEvents(userId: string, clientId: string, periodId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT e.id, e.action, e.reason, e.at, e.checklist_json AS checklist,
              u.name AS "actorName"
       FROM books_close_events e
       LEFT JOIN users u ON u.id = e.actor
       WHERE e.client_id = $1 AND e.period_id = $2
       ORDER BY e.at DESC`,
      [clientId, periodId],
    );
    return rows.rows.map((r) => ({
      id: String(r.id),
      action: String(r.action),
      reason: String(r.reason || ""),
      at: r.at,
      checklist: r.checklist,
      actorName: r.actorName ? String(r.actorName) : null,
    }));
  });
}

/** Called after a journal posts into a period — marks REOPENED periods as changed since close. */
export async function markPeriodChangedSinceClose(
  db: PoolClient,
  clientId: string,
  periodId: string,
) {
  await db.query(
    `UPDATE books_periods
     SET changed_since_close = true
     WHERE id = $1 AND client_id = $2 AND status = 'REOPENED'`,
    [periodId, clientId],
  );
}
