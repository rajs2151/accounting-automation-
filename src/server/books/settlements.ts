import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { aedFromOriginal } from "@/lib/fx";
import { writeBooksAudit } from "@/server/books/audit";
import { requireDualControlActor } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { applyAllocationToOpenItem } from "@/server/books/open-items";
import { assertSyntheticTenant } from "@/server/security-gate";

/**
 * Bill-wise allocation types (Tally: Agst Ref / Advance / On Account).
 *  - agst_ref:   settles an existing open item (invoice/bill).
 *  - advance:    unbilled prepayment from a known party (AR → 2320, AP → 1250).
 *  - on_account: paid, bill not yet identified (AR → 1210, AP → 2110; open item matched later).
 * Advance / on-account parts become books_party_credits rows (one per settlement part) that can be
 * applied to a later invoice/bill with applyPartyCredit.
 */
export type AllocationType = "agst_ref" | "advance" | "on_account";

export type AllocationInput = {
  /** Default agst_ref (back-compat with existing callers). */
  type?: AllocationType;
  /** Required for agst_ref; must be omitted for advance / on_account. */
  openItemId?: string;
  allocatedOriginalMinor: number;
};

export type ReceiptPaymentInput = {
  docType: "receipt" | "payment";
  partyId: string;
  issueDate: string;
  periodId: string;
  bankAccountId: string;
  currency?: string;
  fxRateScaled?: number;
  /** Gross settlement in original currency */
  originalAmountMinor: number;
  memo?: string;
  /**
   * Parts of the settlement. Any receipt remainder not covered here becomes an Advance
   * (pre-TALLY-1 behaviour); a payment remainder is rejected.
   */
  allocations?: AllocationInput[];
};

export type ContraInput = {
  issueDate: string;
  periodId: string;
  fromAccountId: string;
  toAccountId: string;
  currency?: string;
  fxRateScaled?: number;
  originalAmountMinor: number;
  memo?: string;
};

export type PartyCreditRow = {
  id: string;
  partyId: string;
  side: "AR" | "AP";
  creditType: "advance" | "on_account";
  settlementDocumentId: string;
  settlementJournalId: string;
  currency: string;
  fxRateScaled: number;
  originalMinor: number;
  aedMinor: number;
  openOriginalMinor: number;
  openAedMinor: number;
  status: "open" | "partial" | "closed";
  vatPolicyPending: boolean;
};

const ALLOCATION_TYPES: ReadonlySet<string> = new Set(["agst_ref", "advance", "on_account"]);

function assertPositiveFils(n: unknown, code: string): number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) {
    throw new BooksError(code, "invalid");
  }
  return n;
}

async function accountCode(db: PoolClient, clientId: string, accountId: string) {
  const row = await db.query(
    `SELECT code, is_bank FROM books_accounts WHERE id = $1 AND client_id = $2`,
    [accountId, clientId],
  );
  if (!row.rowCount) throw new BooksError("account_not_found", "not_found");
  return row.rows[0] as { code: string; is_bank: boolean };
}

async function accountIdByCode(db: PoolClient, clientId: string, code: string) {
  const row = await db.query(
    `SELECT id FROM books_accounts WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  if (!row.rowCount) throw new BooksError(`account_${code}_missing`, "not_found");
  return String(row.rows[0].id);
}

/** Account that holds an unapplied credit until it is matched to a bill. */
function creditAccountCode(side: "AR" | "AP", creditType: "advance" | "on_account") {
  if (creditType === "advance") return side === "AR" ? "2320" : "1250";
  return side === "AR" ? "1210" : "2110";
}

type JournalLine = {
  accountId: string;
  debitMinor?: number;
  creditMinor?: number;
  currency?: string;
  originalMinor?: number;
  fxRateScaled?: number;
  aedMinor?: number;
  lineMemo?: string;
};

export async function createReceiptOrPayment(
  preparerId: string,
  approverId: string,
  clientId: string,
  body: ReceiptPaymentInput,
) {
  const currency = (body.currency || "AED").toUpperCase();
  const fxRateScaled = body.fxRateScaled ?? 100000000;
  assertPositiveFils(body.originalAmountMinor, "invalid_amount");
  const aedTotal = aedFromOriginal(body.originalAmountMinor, fxRateScaled);
  const allocations = body.allocations || [];
  const side: "AR" | "AP" = body.docType === "receipt" ? "AR" : "AP";

  const prepared = await withUser(preparerId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const party = await db.query(
      `SELECT id FROM books_parties WHERE id = $1 AND client_id = $2`,
      [body.partyId, clientId],
    );
    if (!party.rowCount) throw new BooksError("party_not_found", "not_found");
    await accountCode(db, clientId, body.bankAccountId);

    let allocOrigSum = 0;
    let allocAedAtInvoice = 0;
    const allocDetails: Array<{
      openItemId: string;
      allocatedOriginalMinor: number;
      allocatedAedAtInvoice: number;
      invoiceFx: number;
    }> = [];
    // Explicit advance / on-account parts (original currency, keyed by type).
    const creditParts: Array<{ creditType: "advance" | "on_account"; originalMinor: number }> = [];
    let explicitCreditSum = 0;

    for (const a of allocations) {
      const type = a.type ?? "agst_ref";
      if (!ALLOCATION_TYPES.has(type)) throw new BooksError("invalid_allocation_type", "invalid");
      const amount = assertPositiveFils(a.allocatedOriginalMinor, "invalid_allocation_amount");
      if (type !== "agst_ref") {
        if (a.openItemId) throw new BooksError("allocation_type_takes_no_open_item", "invalid");
        creditParts.push({ creditType: type, originalMinor: amount });
        explicitCreditSum += amount;
        continue;
      }
      if (!a.openItemId) throw new BooksError("open_item_required", "invalid");
      const oi = await db.query(
        `SELECT id, open_original_minor, open_aed_minor, fx_rate_scaled, side, party_id, currency
         FROM books_open_items WHERE id = $1 AND client_id = $2`,
        [a.openItemId, clientId],
      );
      if (!oi.rowCount) throw new BooksError("open_item_not_found", "not_found");
      if (String(oi.rows[0].party_id) !== body.partyId) {
        throw new BooksError("party_mismatch", "invalid");
      }
      if (String(oi.rows[0].side) !== side) throw new BooksError("side_mismatch", "invalid");
      if (amount > Number(oi.rows[0].open_original_minor)) {
        throw new BooksError("allocation_exceeds_open", "invalid");
      }
      const invoiceFx = Number(oi.rows[0].fx_rate_scaled);
      const aedAtInvoice = aedFromOriginal(amount, invoiceFx);
      allocOrigSum += amount;
      allocAedAtInvoice += aedAtInvoice;
      allocDetails.push({
        openItemId: a.openItemId,
        allocatedOriginalMinor: amount,
        allocatedAedAtInvoice: aedAtInvoice,
        invoiceFx,
      });
    }

    if (allocOrigSum + explicitCreditSum > body.originalAmountMinor) {
      throw new BooksError("allocations_exceed_payment", "invalid");
    }

    const remainder = body.originalAmountMinor - allocOrigSum - explicitCreditSum;
    if (remainder > 0) {
      // Pre-TALLY-1 behaviour: receipt remainder → customer advance; payments must be fully typed.
      if (body.docType === "payment") {
        throw new BooksError("unallocated_payment_not_supported", "invalid");
      }
      creditParts.push({ creditType: "advance", originalMinor: remainder });
    }

    const aedAtPaymentForAlloc = aedFromOriginal(allocOrigSum, fxRateScaled);
    const fxGainLoss = aedAtPaymentForAlloc - allocAedAtInvoice; // +gain for AR receipt

    const ar = await accountIdByCode(db, clientId, "1210");
    const ap = await accountIdByCode(db, clientId, "2110");
    const fxAcct = await accountIdByCode(db, clientId, "7300");

    // Credit AED at the settlement rate; the last part absorbs rounding so bank = Σ lines.
    const creditAedTotal = aedTotal - aedAtPaymentForAlloc;
    let creditAedLeft = creditAedTotal;
    const credits: Array<{
      creditType: "advance" | "on_account";
      originalMinor: number;
      aedMinor: number;
      accountId: string;
    }> = [];
    for (let i = 0; i < creditParts.length; i += 1) {
      const p = creditParts[i];
      const aed =
        i === creditParts.length - 1 ? creditAedLeft : aedFromOriginal(p.originalMinor, fxRateScaled);
      creditAedLeft -= aed;
      credits.push({
        ...p,
        aedMinor: aed,
        accountId: await accountIdByCode(db, clientId, creditAccountCode(side, p.creditType)),
      });
    }

    const lines: JournalLine[] = [];
    if (body.docType === "receipt") {
      lines.push({
        accountId: body.bankAccountId,
        debitMinor: aedTotal,
        currency,
        originalMinor: body.originalAmountMinor,
        fxRateScaled,
        aedMinor: aedTotal,
        lineMemo: "Receipt",
      });
      if (allocAedAtInvoice > 0) {
        lines.push({
          accountId: ar,
          creditMinor: allocAedAtInvoice,
          currency,
          originalMinor: allocOrigSum,
          fxRateScaled,
          aedMinor: allocAedAtInvoice,
          lineMemo: "Settle AR",
        });
      }
      for (const c of credits) {
        if (c.aedMinor <= 0) continue;
        lines.push({
          accountId: c.accountId,
          creditMinor: c.aedMinor,
          currency,
          originalMinor: c.originalMinor,
          fxRateScaled,
          aedMinor: c.aedMinor,
          // TODO(owner): VAT on customer advances undecided — no VAT line is posted here.
          lineMemo:
            c.creditType === "advance" ? "Customer advance (VAT policy TBD)" : "On account (unmatched)",
        });
      }
      if (fxGainLoss !== 0) {
        // Receipt: payment AED vs invoice AED — gain credits 7300 (negative expense) via credit; loss debit
        if (fxGainLoss > 0) {
          lines.push({
            accountId: fxAcct,
            creditMinor: fxGainLoss,
            aedMinor: fxGainLoss,
            lineMemo: "Realised FX gain",
          });
        } else {
          lines.push({
            accountId: fxAcct,
            debitMinor: -fxGainLoss,
            aedMinor: -fxGainLoss,
            lineMemo: "Realised FX loss",
          });
        }
      }
    } else {
      lines.push({
        accountId: body.bankAccountId,
        creditMinor: aedTotal,
        currency,
        originalMinor: body.originalAmountMinor,
        fxRateScaled,
        aedMinor: aedTotal,
        lineMemo: "Payment",
      });
      if (allocAedAtInvoice > 0) {
        lines.push({
          accountId: ap,
          debitMinor: allocAedAtInvoice,
          currency,
          originalMinor: allocOrigSum,
          fxRateScaled,
          aedMinor: allocAedAtInvoice,
          lineMemo: "Settle AP",
        });
      }
      for (const c of credits) {
        if (c.aedMinor <= 0) continue;
        lines.push({
          accountId: c.accountId,
          debitMinor: c.aedMinor,
          currency,
          originalMinor: c.originalMinor,
          fxRateScaled,
          aedMinor: c.aedMinor,
          lineMemo: c.creditType === "advance" ? "Supplier advance" : "On account (unmatched)",
        });
      }
      if (fxGainLoss !== 0) {
        // Payment: if we pay more AED than invoice AED → loss
        const loss = -fxGainLoss;
        if (loss > 0) {
          lines.push({
            accountId: fxAcct,
            debitMinor: loss,
            aedMinor: loss,
            lineMemo: "Realised FX loss",
          });
        } else if (loss < 0) {
          lines.push({
            accountId: fxAcct,
            creditMinor: -loss,
            aedMinor: -loss,
            lineMemo: "Realised FX gain",
          });
        }
      }
    }

    return {
      lines,
      allocDetails,
      credits,
      aedTotal,
      fxRateScaled,
      currency,
      fxGainLoss,
    };
  });

  const voucherType = body.docType === "receipt" ? "Receipt" : "Payment";
  const created = await createBooksJournal(preparerId, clientId, {
    periodId: body.periodId,
    entryDate: body.issueDate,
    memo: body.memo || voucherType,
    voucherType,
    lines: prepared.lines,
    post: false,
  });
  const posted = await postBooksJournal(approverId, clientId, created.id);

  const documentId = randomUUID();
  const partyCreditIds: string[] = [];
  await withUser(approverId, async (db) => {
    await db.query(
      `INSERT INTO books_documents (
         id, client_id, doc_type, doc_kind, status, party_id, issue_date,
         currency, fx_rate_scaled, original_total_minor, aed_total_minor,
         net_minor, vat_minor, gross_minor, memo, journal_entry_id,
         bank_account_id, voucher_type, created_by, approved_by
       ) VALUES (
         $1,$2,$3,$4,'posted',$5,$6,$7,$8,$9,$10,$10,0,$10,$11,$12,$13,$14,$15,$16
       )`,
      [
        documentId,
        clientId,
        body.docType,
        body.docType === "receipt" ? "customer" : "supplier",
        body.partyId,
        body.issueDate,
        prepared.currency,
        prepared.fxRateScaled,
        body.originalAmountMinor,
        prepared.aedTotal,
        body.memo || "",
        created.id,
        body.bankAccountId,
        voucherType,
        preparerId,
        approverId,
      ],
    );

    for (const a of prepared.allocDetails) {
      const payAed = aedFromOriginal(a.allocatedOriginalMinor, prepared.fxRateScaled);
      await db.query(
        `INSERT INTO books_allocations (
           client_id, settlement_document_id, settlement_journal_id, open_item_id,
           allocated_original_minor, allocated_aed_minor, fx_gain_loss_aed_minor, allocation_type
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'agst_ref')`,
        [
          clientId,
          documentId,
          created.id,
          a.openItemId,
          a.allocatedOriginalMinor,
          a.allocatedAedAtInvoice,
          body.docType === "receipt" ? payAed - a.allocatedAedAtInvoice : a.allocatedAedAtInvoice - payAed,
        ],
      );
      await applyAllocationToOpenItem(
        db,
        a.openItemId,
        clientId,
        a.allocatedOriginalMinor,
        a.allocatedAedAtInvoice,
      );
    }

    for (const c of prepared.credits) {
      const credit = await db.query(
        `INSERT INTO books_party_credits (
           client_id, party_id, side, credit_type, settlement_document_id, settlement_journal_id,
           currency, fx_rate_scaled, original_minor, aed_minor, open_original_minor, open_aed_minor,
           status, vat_policy_pending
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$10,'open',$11)
         RETURNING id`,
        [
          clientId,
          body.partyId,
          side,
          c.creditType,
          documentId,
          created.id,
          prepared.currency,
          prepared.fxRateScaled,
          c.originalMinor,
          c.aedMinor,
          // TODO(owner): VAT on customer advances is not decided — flag, never compute.
          side === "AR" && c.creditType === "advance",
        ],
      );
      const creditId = String(credit.rows[0].id);
      partyCreditIds.push(creditId);
      if (c.aedMinor > 0) {
        // Creation row: this settlement produced an unapplied credit (open_item_id NULL).
        await db.query(
          `INSERT INTO books_allocations (
             client_id, settlement_document_id, settlement_journal_id, open_item_id,
             allocated_original_minor, allocated_aed_minor, fx_gain_loss_aed_minor,
             allocation_type, party_credit_id
           ) VALUES ($1,$2,$3,NULL,$4,$5,0,$6,$7)`,
          [clientId, documentId, created.id, c.originalMinor, c.aedMinor, c.creditType, creditId],
        );
      }
      if (side === "AR" && c.creditType === "advance") {
        // Running balance kept for the C1b-2 "apply advance" UI; per-receipt detail is in books_party_credits.
        await db.query(
          `INSERT INTO books_party_advances (client_id, party_id, currency, balance_original_minor, balance_aed_minor)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (client_id, party_id, currency) DO UPDATE SET
             balance_original_minor = books_party_advances.balance_original_minor + EXCLUDED.balance_original_minor,
             balance_aed_minor = books_party_advances.balance_aed_minor + EXCLUDED.balance_aed_minor,
             updated_at = now()`,
          [clientId, body.partyId, prepared.currency, c.originalMinor, c.aedMinor],
        );
      }
    }

    await writeBooksAudit(db, {
      clientId,
      actor: approverId,
      action: "create_settlement",
      entity: "books_document",
      entityId: documentId,
      after: {
        entryNo: posted.entryNo,
        voucherType,
        allocations: prepared.allocDetails.length,
        partyCredits: prepared.credits.map((c) => ({ type: c.creditType, originalMinor: c.originalMinor })),
      },
    });
  });

  return { documentId, journalEntryId: created.id, entryNo: posted.entryNo, partyCreditIds };
}

function mapCredit(r: Record<string, unknown>): PartyCreditRow {
  return {
    id: String(r.id),
    partyId: String(r.party_id),
    side: String(r.side) as "AR" | "AP",
    creditType: String(r.credit_type) as "advance" | "on_account",
    settlementDocumentId: String(r.settlement_document_id),
    settlementJournalId: String(r.settlement_journal_id),
    currency: String(r.currency),
    fxRateScaled: Number(r.fx_rate_scaled),
    originalMinor: Number(r.original_minor),
    aedMinor: Number(r.aed_minor),
    openOriginalMinor: Number(r.open_original_minor),
    openAedMinor: Number(r.open_aed_minor),
    status: String(r.status) as PartyCreditRow["status"],
    vatPolicyPending: Boolean(r.vat_policy_pending),
  };
}

/** Unapplied advance / on-account credits, oldest first (traceable per settlement document). */
export async function listPartyCredits(
  userId: string,
  clientId: string,
  opts?: {
    partyId?: string;
    side?: "AR" | "AP";
    creditType?: "advance" | "on_account";
    openOnly?: boolean;
  },
): Promise<PartyCreditRow[]> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT * FROM books_party_credits
       WHERE client_id = $1
         AND ($2::uuid IS NULL OR party_id = $2)
         AND ($3::text IS NULL OR side = $3)
         AND ($4::text IS NULL OR credit_type = $4)
         AND (NOT $5::boolean OR status <> 'closed')
       ORDER BY created_at, id`,
      [
        clientId,
        opts?.partyId || null,
        opts?.side || null,
        opts?.creditType || null,
        Boolean(opts?.openOnly),
      ],
    );
    return rows.rows.map(mapCredit);
  });
}

/** Unallocated customer advance balance for a party + currency (C1b-2 UI). */
export async function getPartyAdvanceBalance(
  userId: string,
  clientId: string,
  partyId: string,
  currency = "AED",
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const cur = currency.toUpperCase();
    const row = await db.query(
      `SELECT balance_original_minor AS "balanceOriginalMinor",
              balance_aed_minor AS "balanceAedMinor", currency
       FROM books_party_advances
       WHERE client_id = $1 AND party_id = $2 AND currency = $3`,
      [clientId, partyId, cur],
    );
    if (!row.rowCount) {
      return {
        partyId,
        currency: cur,
        balanceOriginalMinor: 0,
        balanceAedMinor: 0,
      };
    }
    return {
      partyId,
      currency: cur,
      balanceOriginalMinor: Number(row.rows[0].balanceOriginalMinor),
      balanceAedMinor: Number(row.rows[0].balanceAedMinor),
    };
  });
}

type CreditPiece = { credit: PartyCreditRow; amountOriginalMinor: number; creditAedMinor: number };

/**
 * Apply one or more unapplied credits (same party, side, type, currency) to one open item.
 * Reduces both the credits and the open item. Posts a reclass journal only when the GL needs it:
 *  - advance:    AR Dr 2320 / Cr 1210, AP Dr 2110 / Cr 1250 (+ FX difference to 7300)
 *  - on_account: already sits in 1210/2110 — journal only for an FX difference.
 * Dual control: preparer prepares, approver (≠ preparer) posts.
 */
async function applyCreditPieces(
  preparerId: string,
  approverId: string,
  clientId: string,
  args: {
    openItemId: string;
    periodId: string;
    issueDate: string;
    creditType: "advance" | "on_account";
    pieces: CreditPiece[];
    invoiceAedMinor: number;
    invoiceFx: number;
    side: "AR" | "AP";
    partyId: string;
    currency: string;
    memo: string;
  },
) {
  const { side, creditType, pieces } = args;
  const amountOriginal = pieces.reduce((s, p) => s + p.amountOriginalMinor, 0);
  const creditAed = pieces.reduce((s, p) => s + p.creditAedMinor, 0);

  // Signed (debit +) per account code.
  const signed = new Map<string, number>();
  const add = (code: string, v: number) => signed.set(code, (signed.get(code) ?? 0) + v);
  const holding = creditAccountCode(side, creditType);
  if (side === "AR") {
    add(holding, creditAed);
    add("1210", -args.invoiceAedMinor);
    add("7300", -(creditAed - args.invoiceAedMinor));
  } else {
    add(holding, -creditAed);
    add("2110", args.invoiceAedMinor);
    add("7300", creditAed - args.invoiceAedMinor);
  }

  const accountIds = await withUser(preparerId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireDualControlActor(db, approverId, preparerId, "post");
    const ids: Record<string, string> = {};
    for (const code of signed.keys()) ids[code] = await accountIdByCode(db, clientId, code);
    return ids;
  });

  const lines: JournalLine[] = [];
  for (const [code, v] of signed) {
    if (v === 0) continue;
    const memo =
      code === "7300"
        ? v < 0
          ? "Realised FX gain"
          : "Realised FX loss"
        : code === holding
          ? creditType === "advance"
            ? "Apply advance"
            : "Apply on-account"
          : side === "AR"
            ? "Settle AR from credit"
            : "Settle AP from credit";
    const isFx = code === "7300";
    lines.push({
      accountId: accountIds[code],
      ...(v > 0 ? { debitMinor: v } : { creditMinor: -v }),
      ...(isFx
        ? {}
        : {
            currency: args.currency,
            originalMinor: amountOriginal,
            fxRateScaled: code === holding ? pieces[0].credit.fxRateScaled : args.invoiceFx,
          }),
      aedMinor: Math.abs(v),
      lineMemo: memo,
    });
  }

  let journalId: string | null = null;
  let entryNo: string | null = null;
  let documentId: string | null = null;
  if (lines.length > 0) {
    const created = await createBooksJournal(preparerId, clientId, {
      periodId: args.periodId,
      entryDate: args.issueDate,
      memo: args.memo,
      voucherType: "Journal",
      lines,
      post: false,
    });
    const posted = await postBooksJournal(approverId, clientId, created.id);
    journalId = created.id;
    entryNo = String(posted.entryNo);
    documentId = randomUUID();
  }

  await withUser(approverId, async (db) => {
    if (documentId && journalId) {
      await db.query(
        `INSERT INTO books_documents (
           id, client_id, doc_type, status, party_id, issue_date, currency, fx_rate_scaled,
           original_total_minor, aed_total_minor, net_minor, vat_minor, gross_minor,
           memo, journal_entry_id, voucher_type, created_by, approved_by
         ) VALUES (
           $1,$2,$3,'posted',$4,$5,$6,$7,$8,$9,$8,0,$8,$10,$11,'Journal',$12,$13
         )`,
        [
          documentId,
          clientId,
          side === "AR" ? "receipt" : "payment",
          args.partyId,
          args.issueDate,
          args.currency,
          args.invoiceFx,
          amountOriginal,
          args.invoiceAedMinor,
          args.memo,
          journalId,
          preparerId,
          approverId,
        ],
      );
    }

    let invoiceAedLeft = args.invoiceAedMinor;
    for (let i = 0; i < pieces.length; i += 1) {
      const p = pieces[i];
      const lockRow = await db.query(
        `SELECT open_original_minor, open_aed_minor FROM books_party_credits
         WHERE id = $1 AND client_id = $2 FOR UPDATE`,
        [p.credit.id, clientId],
      );
      if (!lockRow.rowCount) throw new BooksError("party_credit_not_found", "not_found");
      const openOrig = Number(lockRow.rows[0].open_original_minor);
      const openAed = Number(lockRow.rows[0].open_aed_minor);
      if (p.amountOriginalMinor > openOrig) throw new BooksError("credit_insufficient", "conflict");
      const nextOrig = openOrig - p.amountOriginalMinor;
      await db.query(
        `UPDATE books_party_credits SET
           open_original_minor = $3::bigint,
           open_aed_minor = $4::bigint,
           status = CASE WHEN $3::bigint = 0 THEN 'closed' ELSE 'partial' END,
           updated_at = now()
         WHERE id = $1 AND client_id = $2`,
        [p.credit.id, clientId, nextOrig, nextOrig === 0 ? 0 : Math.max(0, openAed - p.creditAedMinor)],
      );

      const pieceInvoiceAed =
        i === pieces.length - 1
          ? invoiceAedLeft
          : aedFromOriginal(p.amountOriginalMinor, args.invoiceFx);
      invoiceAedLeft -= pieceInvoiceAed;
      const gainLoss =
        side === "AR" ? p.creditAedMinor - pieceInvoiceAed : pieceInvoiceAed - p.creditAedMinor;
      await db.query(
        `INSERT INTO books_allocations (
           client_id, settlement_document_id, settlement_journal_id, open_item_id,
           allocated_original_minor, allocated_aed_minor, fx_gain_loss_aed_minor,
           allocation_type, party_credit_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          clientId,
          documentId ?? p.credit.settlementDocumentId,
          journalId ?? p.credit.settlementJournalId,
          args.openItemId,
          p.amountOriginalMinor,
          pieceInvoiceAed,
          gainLoss,
          creditType,
          p.credit.id,
        ],
      );
    }

    await applyAllocationToOpenItem(
      db,
      args.openItemId,
      clientId,
      amountOriginal,
      args.invoiceAedMinor,
    );

    if (side === "AR" && creditType === "advance") {
      await db.query(
        `UPDATE books_party_advances
         SET balance_original_minor = balance_original_minor - $4,
             balance_aed_minor = balance_aed_minor - $5,
             updated_at = now()
         WHERE client_id = $1 AND party_id = $2 AND currency = $3`,
        [clientId, args.partyId, args.currency, amountOriginal, creditAed],
      );
    }

    await writeBooksAudit(db, {
      clientId,
      actor: approverId,
      action: creditType === "advance" ? "allocate_advance" : "allocate_on_account",
      entity: "books_open_item",
      entityId: args.openItemId,
      after: {
        entryNo,
        documentId,
        amountOriginalMinor: amountOriginal,
        partyCreditIds: pieces.map((p) => p.credit.id),
      },
    });
  });

  return { documentId, journalEntryId: journalId, entryNo, amountOriginalMinor: amountOriginal };
}

async function loadOpenItemForCredit(
  db: PoolClient,
  clientId: string,
  openItemId: string,
  partyId: string,
  side: "AR" | "AP",
  currency: string,
  amountOriginalMinor: number,
) {
  const oi = await db.query(
    `SELECT id, open_original_minor, open_aed_minor, fx_rate_scaled, side, party_id, currency
     FROM books_open_items WHERE id = $1 AND client_id = $2`,
    [openItemId, clientId],
  );
  if (!oi.rowCount) throw new BooksError("open_item_not_found", "not_found");
  const row = oi.rows[0];
  if (String(row.party_id) !== partyId) throw new BooksError("party_mismatch", "invalid");
  if (String(row.side) !== side) throw new BooksError("side_mismatch", "invalid");
  if (String(row.currency).toUpperCase() !== currency) {
    throw new BooksError("currency_mismatch", "invalid");
  }
  const openOrig = Number(row.open_original_minor);
  if (amountOriginalMinor > openOrig) throw new BooksError("allocation_exceeds_open", "invalid");
  const invoiceFx = Number(row.fx_rate_scaled);
  // Closing the item uses its exact remaining AED so the subledger lands on zero.
  const invoiceAed =
    amountOriginalMinor === openOrig
      ? Number(row.open_aed_minor)
      : aedFromOriginal(amountOriginalMinor, invoiceFx);
  return { invoiceFx, invoiceAed };
}

function creditAedFor(credit: PartyCreditRow, amountOriginalMinor: number) {
  return amountOriginalMinor === credit.openOriginalMinor
    ? credit.openAedMinor
    : aedFromOriginal(amountOriginalMinor, credit.fxRateScaled);
}

/**
 * Apply one specific advance / on-account credit (from a given receipt or payment) to a later
 * invoice or bill. Partial amounts leave both the credit and the open item partially open.
 */
export async function applyPartyCredit(
  preparerId: string,
  approverId: string,
  clientId: string,
  body: {
    partyCreditId: string;
    openItemId: string;
    periodId: string;
    issueDate: string;
    amountOriginalMinor: number;
  },
) {
  const amount = assertPositiveFils(body.amountOriginalMinor, "invalid_amount");
  const prepared = await withUser(preparerId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const c = await db.query(`SELECT * FROM books_party_credits WHERE id = $1 AND client_id = $2`, [
      body.partyCreditId,
      clientId,
    ]);
    if (!c.rowCount) throw new BooksError("party_credit_not_found", "not_found");
    const credit = mapCredit(c.rows[0]);
    if (amount > credit.openOriginalMinor) throw new BooksError("credit_insufficient", "invalid");
    const inv = await loadOpenItemForCredit(
      db,
      clientId,
      body.openItemId,
      credit.partyId,
      credit.side,
      credit.currency,
      amount,
    );
    return { credit, ...inv };
  });
  const { credit } = prepared;
  return applyCreditPieces(preparerId, approverId, clientId, {
    openItemId: body.openItemId,
    periodId: body.periodId,
    issueDate: body.issueDate,
    creditType: credit.creditType,
    pieces: [{ credit, amountOriginalMinor: amount, creditAedMinor: creditAedFor(credit, amount) }],
    invoiceAedMinor: prepared.invoiceAed,
    invoiceFx: prepared.invoiceFx,
    side: credit.side,
    partyId: credit.partyId,
    currency: credit.currency,
    memo: credit.creditType === "advance" ? "Advance allocation" : "On-account allocation",
  });
}

/**
 * Apply an existing 2320 customer advance to an open AR invoice later
 * (Dr 2320 / Cr 1210; reduce books_party_advances; allocate open item).
 * Consumes the party's advance credits oldest-first (per receipt, traceable).
 */
export async function allocatePartyAdvance(
  preparerId: string,
  approverId: string,
  clientId: string,
  body: {
    partyId: string;
    openItemId: string;
    periodId: string;
    issueDate: string;
    amountOriginalMinor: number;
    currency?: string;
  },
) {
  const currency = (body.currency || "AED").toUpperCase();
  const amount = assertPositiveFils(body.amountOriginalMinor, "invalid_amount");
  const prepared = await withUser(preparerId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT * FROM books_party_credits
       WHERE client_id = $1 AND party_id = $2 AND currency = $3
         AND side = 'AR' AND credit_type = 'advance' AND open_original_minor > 0
       ORDER BY created_at, id`,
      [clientId, body.partyId, currency],
    );
    if (!rows.rowCount) throw new BooksError("advance_not_found", "not_found");
    const credits = rows.rows.map(mapCredit);
    const available = credits.reduce((s, c) => s + c.openOriginalMinor, 0);
    if (amount > available) throw new BooksError("advance_insufficient", "invalid");
    const inv = await loadOpenItemForCredit(
      db,
      clientId,
      body.openItemId,
      body.partyId,
      "AR",
      currency,
      amount,
    );
    const pieces: CreditPiece[] = [];
    let left = amount;
    for (const c of credits) {
      if (left <= 0) break;
      const take = Math.min(left, c.openOriginalMinor);
      pieces.push({ credit: c, amountOriginalMinor: take, creditAedMinor: creditAedFor(c, take) });
      left -= take;
    }
    return { pieces, ...inv };
  });

  const result = await applyCreditPieces(preparerId, approverId, clientId, {
    openItemId: body.openItemId,
    periodId: body.periodId,
    issueDate: body.issueDate,
    creditType: "advance",
    pieces: prepared.pieces,
    invoiceAedMinor: prepared.invoiceAed,
    invoiceFx: prepared.invoiceFx,
    side: "AR",
    partyId: body.partyId,
    currency,
    memo: "Advance allocation",
  });
  return { documentId: result.documentId, journalEntryId: result.journalEntryId, entryNo: result.entryNo };
}

/** Contra: own-account transfer / cash deposit-withdrawal only. No allocations. */
export async function createContra(
  preparerId: string,
  approverId: string,
  clientId: string,
  body: ContraInput,
) {
  const currency = (body.currency || "AED").toUpperCase();
  const fxRateScaled = body.fxRateScaled ?? 100000000;
  const aed = aedFromOriginal(body.originalAmountMinor, fxRateScaled);

  await withUser(preparerId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    if (body.fromAccountId === body.toAccountId) {
      throw new BooksError("same_account", "invalid");
    }
    const from = await accountCode(db, clientId, body.fromAccountId);
    const to = await accountCode(db, clientId, body.toAccountId);
    const allowed = new Set(["1110", "1120", "1121", "1130", "1340"]);
    if (!allowed.has(String(from.code)) || !allowed.has(String(to.code))) {
      throw new BooksError("contra_accounts_must_be_cash_bank", "invalid");
    }
    void from.is_bank;
  });

  const created = await createBooksJournal(preparerId, clientId, {
    periodId: body.periodId,
    entryDate: body.issueDate,
    memo: body.memo || "Contra transfer",
    voucherType: "Contra",
    lines: [
      {
        accountId: body.toAccountId,
        debitMinor: aed,
        currency,
        originalMinor: body.originalAmountMinor,
        fxRateScaled,
        aedMinor: aed,
        lineMemo: "Contra in",
      },
      {
        accountId: body.fromAccountId,
        creditMinor: aed,
        currency,
        originalMinor: body.originalAmountMinor,
        fxRateScaled,
        aedMinor: aed,
        lineMemo: "Contra out",
      },
    ],
    post: false,
  });
  const posted = await postBooksJournal(approverId, clientId, created.id);

  const documentId = randomUUID();
  await withUser(approverId, async (db) => {
    await db.query(
      `INSERT INTO books_documents (
         id, client_id, doc_type, status, issue_date, currency, fx_rate_scaled,
         original_total_minor, aed_total_minor, net_minor, vat_minor, gross_minor,
         memo, journal_entry_id, bank_account_id, contra_account_id, voucher_type,
         created_by, approved_by
       ) VALUES (
         $1,$2,'contra','posted',$3,$4,$5,$6,$7,$7,0,$7,$8,$9,$10,$11,'Contra',$12,$12
       )`,
      [
        documentId,
        clientId,
        body.issueDate,
        currency,
        fxRateScaled,
        body.originalAmountMinor,
        aed,
        body.memo || "",
        created.id,
        body.fromAccountId,
        body.toAccountId,
        preparerId,
      ],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: approverId,
      action: "create_contra",
      entity: "books_document",
      entityId: documentId,
      after: { entryNo: posted.entryNo },
    });
  });

  return { documentId, journalEntryId: created.id, entryNo: posted.entryNo };
}
