/**
 * P5-1: books month-end close checklist + lock gate.
 * Ports the structure of src/server/close.ts onto books tables / gates.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { listBankReconciliations } from "@/server/books/bank-recon";
import { getBooksMonthChecklist, vatPeriodForMonth, type VatFrequency } from "@/server/books/dashboard";
import { requireApproverOrAdmin } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { missingPostedDepreciation } from "@/server/books/fixed-assets";
import { fxRevaluationGateState } from "@/server/books/fx-revaluation";
import { lockBooksPeriod, reopenBooksPeriod } from "@/server/books/periods";
import { queryPlaceOfSupplyGaps } from "@/server/books/place-of-supply";
import { booksTrialBalance } from "@/server/books/trial-balance";
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
  "vat_control",
  "missing_documents",
  "depreciation",
  "fx_revaluation",
] as const;

export type CloseGateKey = (typeof CLOSE_GATE_KEYS)[number];

export type CloseGateStatus = "pass" | "fail" | "waived" | "info" | "not_set_up";

export type CloseGate = {
  key: CloseGateKey;
  label: string;
  status: CloseGateStatus;
  /** Blocking fail unless waived. info / not_set_up never block. */
  blocking: boolean;
  count: number;
  href: string;
  detail?: string;
  balanceMinor?: number;
  waiverReason?: string | null;
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
const INFO_CLEARING = ["1220", "1300", "1130"] as const;

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
): Promise<Map<string, string>> {
  // A waiver only counts until the period is next reopened: any 'unlock' audit event on the
  // period at/after the waiver's timestamp invalidates it (re-waiving refreshes `at`).
  const rows = await db.query(
    `SELECT w.gate_key, w.reason FROM books_close_waivers w
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
  return new Map(rows.rows.map((r) => [String(r.gate_key), String(r.reason)]));
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

function applyWaiver(gate: CloseGate, waivers: Map<string, string>): CloseGate {
  const reason = waivers.get(gate.key);
  if (!reason) return gate;
  if (gate.status === "fail" && gate.blocking) {
    return { ...gate, status: "waived", waiverReason: reason };
  }
  return { ...gate, waiverReason: reason };
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

    // 1. Statements — vacuously pass when the company has no bank/card/gateway accounts yet.
    const uncovered = month.statements.accounts.filter((a) => a.state !== "covered");
    const statementsOk =
      month.statements.accounts.length === 0 || month.statements.ok;
    const statements: CloseGate = {
      key: "statements",
      label: "Bank / card / gateway statement coverage",
      status: statementsOk ? "pass" : "fail",
      blocking: true,
      count: uncovered.length,
      href: "/books/banking",
      detail: uncovered.length
        ? uncovered.map((a) => `${a.code} (${a.state})`).join(", ")
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

    // 3. Bank recon
    const reconDiffs = recons.filter((r) => r.status === "difference" || r.status === "no_statement");
    const bankRecon: CloseGate = {
      key: "bank_recon",
      label: "Bank reconciliation (difference = 0)",
      status: reconDiffs.length === 0 ? "pass" : "fail",
      blocking: true,
      count: reconDiffs.length,
      href: "/books/banking",
      detail: reconDiffs.map((r) => `${r.code}:${r.status}`).join(", ") || undefined,
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
        gatewayParts.push(`${code}=${bal}`);
      }
    }
    const clearingGateway: CloseGate = {
      key: "clearing_gateway",
      label: "Gateway / POS / transfer clearing (1310–1340)",
      status: gatewayFail === 0 ? "pass" : "fail",
      blocking: true,
      count: gatewayFail,
      href: "/books/reports/trial-balance",
      detail: gatewayParts.join(", ") || undefined,
    };

    // 5b. Info clearing — never auto-fail
    const infoParts: string[] = [];
    for (const code of INFO_CLEARING) {
      const bal = closingNetMinor(tb, code);
      if (bal !== 0) infoParts.push(`${code}=${bal}`);
    }
    const clearingInfo: CloseGate = {
      key: "clearing_info",
      label: "Disbursements / advances clearing (info)",
      status: "info",
      blocking: false,
      count: infoParts.length,
      href: "/books/reports/trial-balance",
      detail: infoParts.join(", ") || "All zero",
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
    };

    // 7. VAT control
    const client = await db.query(
      `SELECT vat_return_frequency, vat_period_end_month FROM clients WHERE id = $1`,
      [clientId],
    );
    const freq = (client.rows[0]?.vat_return_frequency as VatFrequency | null) || null;
    let vatGate: CloseGate;
    if (!freq) {
      vatGate = {
        key: "vat_control",
        label: "VAT control",
        status: "pass",
        blocking: true,
        count: 0,
        href: "/books/settings",
        detail: "VAT stagger not set — treated as not a VAT period end",
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
          href: "/books/reports/trial-balance",
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
          href: "/books/settings",
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

    const gates = [
      statements,
      bankLines,
      bankRecon,
      suspense,
      clearingGateway,
      clearingInfo,
      scheduledGate,
      vatGate,
      missingDocuments,
      depreciation,
      fx,
    ].map((g) => applyWaiver(g, waivers));

    const failing = gates
      .filter((g) => g.blocking && g.status === "fail")
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

export async function waiveBooksCloseGate(
  userId: string,
  clientId: string,
  periodId: string,
  gateKey: string,
  reason: string,
) {
  const trimmed = String(reason || "").trim();
  if (!trimmed) throw new BooksError("waiver_reason_required", "invalid");
  if (!(CLOSE_GATE_KEYS as readonly string[]).includes(gateKey)) {
    throw new BooksError("invalid_close_gate", "invalid");
  }

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireApproverOrAdmin(db, userId, "lock");
    const period = await db.query(
      `SELECT id, status FROM books_periods WHERE id = $1 AND client_id = $2`,
      [periodId, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
      throw new BooksError("period_locked", "period_closed");
    }

    await db.query(
      `INSERT INTO books_close_waivers (id, client_id, period_id, gate_key, reason, actor)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (client_id, period_id, gate_key)
       DO UPDATE SET reason = EXCLUDED.reason, actor = EXCLUDED.actor, at = now()`,
      [randomUUID(), clientId, periodId, gateKey, trimmed, userId],
    );
    await db.query(
      `INSERT INTO books_close_events (id, client_id, period_id, action, actor, reason, checklist_json)
       VALUES ($1,$2,$3,'WAIVE',$4,$5,$6::jsonb)`,
      [
        randomUUID(),
        clientId,
        periodId,
        userId,
        trimmed,
        JSON.stringify({ gate: gateKey }),
      ],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "waive_close_gate",
      entity: "books_period",
      entityId: periodId,
      after: { gate: gateKey, reason: trimmed },
    });
    return { ok: true, gateKey, reason: trimmed };
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
    throw new CloseGatesFailingError(checklist.gates.filter((g) => g.blocking && g.status === "fail"));
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
