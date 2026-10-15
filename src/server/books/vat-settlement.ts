/**
 * VAT settlement: clear 2210 (output) / 1430 (input) into 2220 (payable / reclaim).
 * D3: prepare a draft JV from the VAT 201 tax window — never auto-post; idempotent per from/to.
 */
import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { vatPeriodForMonth, type VatFrequency } from "@/server/books/dashboard";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal } from "@/server/books/journals";
import { generateVat201Draft } from "@/server/books/vat201";
import { assertSyntheticTenant } from "@/server/security-gate";

export type VatSettlementLine = {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  lineMemo: string;
};

/**
 * Pure builder: Dr 2210 (clear output) / Cr 1430 (clear input) / Cr or Dr 2220 (net).
 * payableMinor > 0 → Cr 2220; < 0 → Dr 2220 (reclaim); 0 → no 2220 line when nets equal.
 */
export function buildVat201SettlementLines(args: {
  outputAccountId: string;
  inputAccountId: string;
  payableAccountId: string;
  /** Credit balance sitting on 2210 (fils). */
  outputNetMinor: number;
  /** Debit balance sitting on 1430 (fils). */
  inputNetMinor: number;
}): { lines: VatSettlementLine[]; payableMinor: number; outputNetMinor: number; inputNetMinor: number } {
  const outNet = Math.max(0, Math.trunc(args.outputNetMinor));
  const inNet = Math.max(0, Math.trunc(args.inputNetMinor));
  const payableMinor = outNet - inNet;
  const lines: VatSettlementLine[] = [];
  if (outNet > 0) {
    lines.push({
      accountId: args.outputAccountId,
      debitMinor: outNet,
      creditMinor: 0,
      lineMemo: "Clear VAT output (2210)",
    });
  }
  if (inNet > 0) {
    lines.push({
      accountId: args.inputAccountId,
      debitMinor: 0,
      creditMinor: inNet,
      lineMemo: "Clear VAT input (1430)",
    });
  }
  if (payableMinor > 0) {
    lines.push({
      accountId: args.payableAccountId,
      debitMinor: 0,
      creditMinor: payableMinor,
      lineMemo: "VAT payable (2220)",
    });
  } else if (payableMinor < 0) {
    lines.push({
      accountId: args.payableAccountId,
      debitMinor: -payableMinor,
      creditMinor: 0,
      lineMemo: "VAT reclaim (2220)",
    });
  }
  return { lines, payableMinor, outputNetMinor: outNet, inputNetMinor: inNet };
}

async function accountBalancesAsOf(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  clientId: string,
  asOf: string,
  codes: string[],
) {
  const accounts = await db.query(
    `SELECT id, code, name FROM books_accounts
     WHERE client_id = $1 AND code = ANY($2::text[])
     ORDER BY code`,
    [clientId, codes],
  );
  const byCode = new Map(accounts.rows.map((r) => [String(r.code), r]));

  const bal = async (code: string) => {
    const acc = byCode.get(code);
    if (!acc) return { accountId: null as string | null, debitMinor: 0, creditMinor: 0, netMinor: 0 };
    const rows = await db.query(
      `SELECT COALESCE(SUM(l.debit_minor),0)::bigint AS dr,
              COALESCE(SUM(l.credit_minor),0)::bigint AS cr
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       WHERE e.client_id = $1 AND e.status IN ('posted','reversed')
         AND e.deleted_at IS NULL
         AND e.entry_date <= $2::date
         AND l.account_id = $3`,
      [clientId, asOf, acc.id],
    );
    const debitMinor = Number(rows.rows[0].dr);
    const creditMinor = Number(rows.rows[0].cr);
    return {
      accountId: String(acc.id),
      code,
      name: String(acc.name),
      debitMinor,
      creditMinor,
      netMinor: debitMinor - creditMinor,
    };
  };

  return { byCode, bal };
}

async function resolveVatTaxWindow(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  clientId: string,
  opts: { from?: string; to?: string; monthEnd?: string },
): Promise<{ from: string; to: string; dueDate: string }> {
  const settings = await db.query(
    `SELECT establishment_emirate, vat_return_frequency, vat_period_end_month
     FROM clients WHERE id = $1`,
    [clientId],
  );
  const emirate = settings.rows[0]?.establishment_emirate as string | null;
  const freq = settings.rows[0]?.vat_return_frequency as VatFrequency | null;
  if (!emirate) throw new BooksError("vat_establishment_emirate_required", "invalid");
  if (!freq) throw new BooksError("vat_stagger_not_set", "invalid");

  if (opts.from && opts.to) {
    const window = vatPeriodForMonth(opts.to, freq, settings.rows[0].vat_period_end_month as number | null);
    return { from: opts.from, to: opts.to, dueDate: window.dueDate };
  }
  if (!opts.monthEnd) throw new BooksError("vat_return_range_required", "invalid");
  const window = vatPeriodForMonth(
    opts.monthEnd,
    freq,
    settings.rows[0].vat_period_end_month as number | null,
  );
  return { from: window.periodStart, to: window.periodEnd, dueDate: window.dueDate };
}

/** Period balances for 2210 / 1430 used by the VAT settlement template (Create Entry). */
export async function booksVatSettlementPreview(
  userId: string,
  clientId: string,
  periodId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const period = await db.query(
      `SELECT id, label, period_end FROM books_periods WHERE id = $1 AND client_id = $2`,
      [periodId, clientId],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    const periodEnd = String(period.rows[0].period_end).slice(0, 10);

    const { byCode, bal } = await accountBalancesAsOf(db, clientId, periodEnd, [
      "1430",
      "2210",
      "2220",
      "1120",
      "1110",
    ]);

    const output = await bal("2210"); // liability: credit balance → netMinor negative
    const input = await bal("1430"); // asset: debit balance → netMinor positive
    const outNet = Math.max(0, -output.netMinor);
    const inNet = Math.max(0, input.netMinor);

    const vatPayable = byCode.get("2220");
    if (!output.accountId || !input.accountId || !vatPayable) {
      throw new BooksError("vat_accounts_missing", "invalid");
    }

    const built = buildVat201SettlementLines({
      outputAccountId: output.accountId,
      inputAccountId: input.accountId,
      payableAccountId: String(vatPayable.id),
      outputNetMinor: outNet,
      inputNetMinor: inNet,
    });

    const bank = byCode.get("1120") || byCode.get("1110");
    const paymentLines: VatSettlementLine[] = [];
    if (built.payableMinor > 0 && bank) {
      paymentLines.push({
        accountId: String(vatPayable.id),
        debitMinor: built.payableMinor,
        creditMinor: 0,
        lineMemo: "Settle VAT payable",
      });
      paymentLines.push({
        accountId: String(bank.id),
        debitMinor: 0,
        creditMinor: built.payableMinor,
        lineMemo: "Bank payment to FTA",
      });
    }

    return {
      periodId,
      periodLabel: String(period.rows[0].label),
      periodEnd,
      outputVat: output,
      inputVat: input,
      outputNetMinor: built.outputNetMinor,
      inputNetMinor: built.inputNetMinor,
      payableMinor: built.payableMinor,
      returnEntry: {
        memo: `VAT return ${period.rows[0].label}`,
        voucherType: "Journal",
        lines: built.lines,
      },
      paymentEntry:
        built.payableMinor > 0
          ? {
              memo: `VAT payment ${period.rows[0].label}`,
              voucherType: "Payment",
              lines: paymentLines,
            }
          : null,
    };
  });
}

export type Vat201SettlementStatus = {
  id: string;
  periodFrom: string;
  periodTo: string;
  dueDate: string;
  payableMinor: number;
  outputNetMinor: number;
  inputNetMinor: number;
  journalEntryId: string;
  journalStatus: string;
  journalReference: string | null;
  alreadyPrepared: boolean;
};

async function loadExistingSettlement(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }> },
  clientId: string,
  from: string,
  to: string,
): Promise<{
  id: string;
  journalEntryId: string;
  payableMinor: number;
  outputNetMinor: number;
  inputNetMinor: number;
  journalStatus: string | null;
  journalReference: string | null;
  deleted: boolean;
} | null> {
  const row = await db.query(
    `SELECT s.id, s.journal_entry_id, s.payable_minor, s.output_net_minor, s.input_net_minor,
            e.status AS journal_status, e.reference AS journal_reference, e.deleted_at
     FROM books_vat201_settlements s
     LEFT JOIN books_journal_entries e ON e.id = s.journal_entry_id
     WHERE s.client_id = $1 AND s.period_from = $2::date AND s.period_to = $3::date`,
    [clientId, from, to],
  );
  if (!row.rowCount) return null;
  const r = row.rows[0];
  return {
    id: String(r.id),
    journalEntryId: String(r.journal_entry_id),
    payableMinor: Number(r.payable_minor),
    outputNetMinor: Number(r.output_net_minor),
    inputNetMinor: Number(r.input_net_minor),
    journalStatus: r.journal_status == null ? null : String(r.journal_status),
    journalReference: r.journal_reference == null ? null : String(r.journal_reference),
    deleted: r.deleted_at != null || r.journal_status == null,
  };
}

/** Read existing settlement for a VAT tax window (or null). */
export async function getVat201Settlement(
  userId: string,
  clientId: string,
  opts: { from?: string; to?: string; monthEnd?: string },
): Promise<Vat201SettlementStatus | null> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const table = await db.query(`SELECT to_regclass('books_vat201_settlements') AS t`);
    if (!table.rows[0]?.t) return null;
    const window = await resolveVatTaxWindow(db, clientId, opts);
    const existing = await loadExistingSettlement(db, clientId, window.from, window.to);
    if (!existing || existing.deleted) return null;
    return {
      id: existing.id,
      periodFrom: window.from,
      periodTo: window.to,
      dueDate: window.dueDate,
      payableMinor: existing.payableMinor,
      outputNetMinor: existing.outputNetMinor,
      inputNetMinor: existing.inputNetMinor,
      journalEntryId: existing.journalEntryId,
      journalStatus: existing.journalStatus || "draft",
      journalReference: existing.journalReference,
      alreadyPrepared: true,
    };
  });
}

/**
 * D3: prepare (draft only) the VAT return settlement JV for the tax period.
 * Idempotent: second call returns the same journal. Never posts.
 */
export async function prepareVat201Settlement(
  userId: string,
  clientId: string,
  opts: { from?: string; to?: string; monthEnd?: string },
): Promise<Vat201SettlementStatus> {
  const tableCheck = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const table = await db.query(`SELECT to_regclass('books_vat201_settlements') AS t`);
    return Boolean(table.rows[0]?.t);
  });
  if (!tableCheck) throw new BooksError("vat201_settlement_schema_missing", "invalid");

  // Block while place-of-supply gaps exist (same gate as the draft return).
  await generateVat201Draft(userId, clientId, opts);

  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const window = await resolveVatTaxWindow(db, clientId, opts);

    let existing = await loadExistingSettlement(db, clientId, window.from, window.to);
    if (existing?.deleted) {
      await db.query(`DELETE FROM books_vat201_settlements WHERE id = $1 AND client_id = $2`, [
        existing.id,
        clientId,
      ]);
      existing = null;
    }
    if (existing) {
      return {
        id: existing.id,
        periodFrom: window.from,
        periodTo: window.to,
        dueDate: window.dueDate,
        payableMinor: existing.payableMinor,
        outputNetMinor: existing.outputNetMinor,
        inputNetMinor: existing.inputNetMinor,
        journalEntryId: existing.journalEntryId,
        journalStatus: existing.journalStatus || "draft",
        journalReference: existing.journalReference,
        alreadyPrepared: true,
      };
    }

    const { byCode, bal } = await accountBalancesAsOf(db, clientId, window.to, [
      "1430",
      "2210",
      "2220",
    ]);
    const output = await bal("2210");
    const input = await bal("1430");
    const vatPayable = byCode.get("2220");
    if (!output.accountId || !input.accountId || !vatPayable) {
      throw new BooksError("vat_accounts_missing", "invalid");
    }

    const outNet = Math.max(0, -output.netMinor);
    const inNet = Math.max(0, input.netMinor);
    const built = buildVat201SettlementLines({
      outputAccountId: output.accountId,
      inputAccountId: input.accountId,
      payableAccountId: String(vatPayable.id),
      outputNetMinor: outNet,
      inputNetMinor: inNet,
    });
    if (!built.lines.length) {
      throw new BooksError("vat201_nothing_to_settle", "invalid");
    }

    const periodRow = await db.query(
      `SELECT id, label FROM books_periods
       WHERE client_id = $1
         AND period_start <= $2::date
         AND period_end >= $2::date
       ORDER BY period_start DESC
       LIMIT 1`,
      [clientId, window.to],
    );
    if (!periodRow.rowCount) throw new BooksError("period_not_found", "not_found");
    const periodId = String(periodRow.rows[0].id);
    const periodLabel = String(periodRow.rows[0].label);

    const settlementId = randomUUID();
    const memo = `VAT 201 settlement ${window.from} → ${window.to}`;
    const journal = await createBooksJournal(userId, clientId, {
      periodId,
      entryDate: window.to,
      memo,
      voucherType: "Journal",
      templateKey: "vat201_settlement",
      tags: ["vat", "vat201"],
      allowControlAccounts: true,
      post: false,
      lines: built.lines.map((l) => ({
        accountId: l.accountId,
        debitMinor: l.debitMinor,
        creditMinor: l.creditMinor,
        lineMemo: l.lineMemo,
        tags: ["vat", "vat201"],
      })),
    });

    await db.query(
      `INSERT INTO books_vat201_settlements (
         id, client_id, period_from, period_to, payable_minor, output_net_minor, input_net_minor,
         journal_entry_id, created_by
       ) VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9)`,
      [
        settlementId,
        clientId,
        window.from,
        window.to,
        built.payableMinor,
        built.outputNetMinor,
        built.inputNetMinor,
        journal.id,
        userId,
      ],
    );

    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "vat201_settlement",
      entity: "books_vat201_settlement",
      entityId: settlementId,
      after: {
        periodFrom: window.from,
        periodTo: window.to,
        payableMinor: built.payableMinor,
        journalEntryId: journal.id,
        periodLabel,
        status: "draft",
      },
      source: "vat201",
    });

    return {
      id: settlementId,
      periodFrom: window.from,
      periodTo: window.to,
      dueDate: window.dueDate,
      payableMinor: built.payableMinor,
      outputNetMinor: built.outputNetMinor,
      inputNetMinor: built.inputNetMinor,
      journalEntryId: String(journal.id),
      journalStatus: "draft",
      journalReference: journal.reference ? String(journal.reference) : null,
      alreadyPrepared: false,
    };
  });
}
