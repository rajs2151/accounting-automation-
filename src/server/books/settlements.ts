import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { aedFromOriginal } from "@/lib/fx";
import { writeBooksAudit } from "@/server/books/audit";
import { requireDualControlActor } from "@/server/books/dual-control";
import { BooksError } from "@/server/books/errors";
import {
  createBooksJournal,
  postBooksJournalInTx,
  softDeleteBooksJournalDraft,
} from "@/server/books/journals";
import { applyAllocationToOpenItem } from "@/server/books/open-items";
import { assertSyntheticTenant } from "@/server/security-gate";

export type AllocationInput = {
  openItemId: string;
  allocatedOriginalMinor: number;
};

/** P2A-1: bank fee / FX / discount lines so bank amount reconciles to allocations. */
export type SettlementDifferenceLine = {
  kind: "bank_fee" | "fx_difference" | "discount";
  accountId: string;
  amountOriginalMinor: number;
};

export type ReceiptPaymentInput = {
  docType: "receipt" | "payment";
  partyId: string;
  issueDate: string;
  periodId: string;
  bankAccountId: string;
  currency?: string;
  fxRateScaled?: number;
  /** Gross amount that hit the bank (fils). */
  originalAmountMinor: number;
  memo?: string;
  allocations?: AllocationInput[];
  /** Explicit remainder when not covered by open items (advance / on account). */
  remainderKind?: "advance" | "on_account";
  remainderOriginalMinor?: number;
  differenceLines?: SettlementDifferenceLine[];
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

async function accountCode(db: import("pg").PoolClient, clientId: string, accountId: string) {
  const row = await db.query(
    `SELECT code, is_bank FROM books_accounts WHERE id = $1 AND client_id = $2`,
    [accountId, clientId],
  );
  if (!row.rowCount) throw new BooksError("account_not_found", "not_found");
  return row.rows[0] as { code: string; is_bank: boolean };
}

/**
 * The period a settlement belongs to is the one containing its own date (as for documents), not
 * whatever period the screen had selected — a 20 May receipt must not land in June's books.
 */
async function periodForSettlementDate(userId: string, clientId: string, issueDate: string, fallback: string) {
  return withUser(userId, async (db) => {
    const p = await db.query(
      `SELECT id FROM books_periods
       WHERE client_id = $1 AND period_start <= $2::date AND period_end >= $2::date
       ORDER BY period_start DESC LIMIT 1`,
      [clientId, issueDate],
    );
    return p.rowCount ? String(p.rows[0].id) : fallback;
  });
}

/**
 * Dual control BEFORE anything is created: the poster must be an approver/admin and not the
 * preparer. (QA: a refused post used to leave a postable draft Receipt journal behind.)
 */
async function assertCanPostFor(approverId: string, clientId: string, preparerId: string) {
  if (!preparerId) throw new BooksError("preparer_required", "invalid");
  await withUser(approverId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await requireDualControlActor(db, approverId, preparerId, "post", { clientId });
  });
}

/** Remove the draft journal a failed post created, so it can never be posted on its own. */
async function discardDraftJournal(preparerId: string, clientId: string, entryId: string) {
  try {
    await softDeleteBooksJournalDraft(preparerId, clientId, entryId);
  } catch (cleanupError) {
    console.error(`[settlements] could not discard draft journal ${entryId}`, cleanupError);
  }
}

/**
 * Create the draft journal as the preparer, then — in ONE approver transaction — post it and run
 * `finish` (documents / allocations / advances). If that transaction fails nothing from it is kept
 * and the draft journal is discarded.
 */
async function postSettlementJournal<T>(
  preparerId: string,
  approverId: string,
  clientId: string,
  journal: Parameters<typeof createBooksJournal>[2],
  finish: (db: PoolClient, journalEntryId: string) => Promise<T>,
): Promise<T> {
  const created = await createBooksJournal(preparerId, clientId, {
    ...journal,
    post: false,
    allowControlAccounts: true,
  });
  try {
    return await withUser(approverId, async (db) => {
      await assertSyntheticTenant(db, clientId);
      return finish(db, created.id);
    });
  } catch (error) {
    await discardDraftJournal(preparerId, clientId, created.id);
    throw error;
  }
}

async function postJournalInTx(db: PoolClient, approverId: string, clientId: string, entryId: string) {
  const posted = await postBooksJournalInTx(db, approverId, clientId, entryId);
  return String(posted.entryNo);
}

/** Validate a receipt/payment and build its journal lines (no writes). */
async function prepareSettlementInTx(db: PoolClient, clientId: string, body: ReceiptPaymentInput) {
  const currency = (body.currency || "AED").toUpperCase();
  const fxRateScaled = body.fxRateScaled ?? 100000000;
  if (!Number.isSafeInteger(fxRateScaled) || fxRateScaled <= 0) {
    throw new BooksError("invalid_fx_rate", "invalid");
  }
  if (!Number.isSafeInteger(body.originalAmountMinor) || body.originalAmountMinor <= 0) {
    throw new BooksError("settlement_amount_required", "invalid");
  }
  const aedTotal = aedFromOriginal(body.originalAmountMinor, fxRateScaled);
  const allocations = body.allocations || [];
  const differenceLines = body.differenceLines || [];
  const remainderOrig = Math.max(0, Number(body.remainderOriginalMinor || 0));
  const remainderKind = body.remainderKind;
  for (const a of allocations) {
    if (!Number.isSafeInteger(a.allocatedOriginalMinor) || a.allocatedOriginalMinor <= 0) {
      throw new BooksError("invalid_allocation_amount", "invalid");
    }
  }
  {
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

    for (const a of allocations) {
      const oi = await db.query(
        `SELECT id, open_original_minor, open_aed_minor, fx_rate_scaled, side, party_id
         FROM books_open_items WHERE id = $1 AND client_id = $2`,
        [a.openItemId, clientId],
      );
      if (!oi.rowCount) throw new BooksError("open_item_not_found", "not_found");
      if (String(oi.rows[0].party_id) !== body.partyId) {
        throw new BooksError("party_mismatch", "invalid");
      }
      const wantSide = body.docType === "receipt" ? "AR" : "AP";
      if (String(oi.rows[0].side) !== wantSide) throw new BooksError("side_mismatch", "invalid");
      if (a.allocatedOriginalMinor > Number(oi.rows[0].open_original_minor)) {
        throw new BooksError("allocation_exceeds_open", "invalid");
      }
      const invoiceFx = Number(oi.rows[0].fx_rate_scaled);
      const aedAtInvoice = aedFromOriginal(a.allocatedOriginalMinor, invoiceFx);
      allocOrigSum += a.allocatedOriginalMinor;
      allocAedAtInvoice += aedAtInvoice;
      allocDetails.push({
        openItemId: a.openItemId,
        allocatedOriginalMinor: a.allocatedOriginalMinor,
        allocatedAedAtInvoice: aedAtInvoice,
        invoiceFx,
      });
    }

    let feeOrig = 0;
    let discountOrig = 0;
    const validatedDiffs: Array<SettlementDifferenceLine & { aed: number }> = [];
    for (const d of differenceLines) {
      if (d.amountOriginalMinor <= 0) throw new BooksError("invalid_difference_amount", "invalid");
      await accountCode(db, clientId, d.accountId);
      const aed = aedFromOriginal(d.amountOriginalMinor, fxRateScaled);
      if (d.kind === "discount") discountOrig += d.amountOriginalMinor;
      else feeOrig += d.amountOriginalMinor;
      validatedDiffs.push({ ...d, aed });
    }

    if (remainderOrig > 0 && remainderKind !== "advance" && remainderKind !== "on_account") {
      throw new BooksError("remainder_kind_required", "invalid");
    }

    // Legacy: no diffs / no explicit remainder → leftover after against-items is customer advance.
    const useLegacyRemainder =
      differenceLines.length === 0 && remainderOrig === 0 && !remainderKind;
    const legacyUnallocated = useLegacyRemainder
      ? body.originalAmountMinor - allocOrigSum
      : 0;
    if (legacyUnallocated < 0) throw new BooksError("allocations_exceed_payment", "invalid");

    if (!useLegacyRemainder) {
      // Receipt: bank + fees + discount = against + rem
      // Payment: bank = against + rem + fees - discount
      const explained =
        body.docType === "receipt"
          ? allocOrigSum + remainderOrig - feeOrig - discountOrig
          : allocOrigSum + remainderOrig + feeOrig - discountOrig;
      if (explained !== body.originalAmountMinor) {
        throw new BooksError("settlement_unallocated_nonzero", "invalid");
      }
    }

    const unallocatedOrig = useLegacyRemainder ? legacyUnallocated : remainderOrig;
    const remainderIsAdvance =
      unallocatedOrig > 0 &&
      (remainderKind === "advance" ||
        remainderKind === "on_account" ||
        (useLegacyRemainder && body.docType === "receipt"));
    const aedAtPaymentForAlloc = aedFromOriginal(allocOrigSum, fxRateScaled);
    const fxGainLoss = aedAtPaymentForAlloc - allocAedAtInvoice; // +gain for AR receipt

    const ar = (
      await db.query(`SELECT id FROM books_accounts WHERE client_id = $1 AND code = '1210'`, [
        clientId,
      ])
    ).rows[0].id as string;
    const ap = (
      await db.query(`SELECT id FROM books_accounts WHERE client_id = $1 AND code = '2110'`, [
        clientId,
      ])
    ).rows[0].id as string;
    const advances = (
      await db.query(`SELECT id FROM books_accounts WHERE client_id = $1 AND code = '2320'`, [
        clientId,
      ])
    ).rows[0].id as string;
    const prepaid = (
      await db.query(`SELECT id FROM books_accounts WHERE client_id = $1 AND code = '1410'`, [
        clientId,
      ])
    ).rows[0].id as string;
    const fxAcct = (
      await db.query(`SELECT id FROM books_accounts WHERE client_id = $1 AND code = '7300'`, [
        clientId,
      ])
    ).rows[0].id as string;

    const lines: Array<{
      accountId: string;
      debitMinor?: number;
      creditMinor?: number;
      currency?: string;
      originalMinor?: number;
      fxRateScaled?: number;
      aedMinor?: number;
      lineMemo?: string;
    }> = [];

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
      for (const d of validatedDiffs) {
        lines.push({
          accountId: d.accountId,
          debitMinor: d.aed,
          currency,
          originalMinor: d.amountOriginalMinor,
          fxRateScaled,
          aedMinor: d.aed,
          lineMemo:
            d.kind === "bank_fee"
              ? "Bank fee"
              : d.kind === "fx_difference"
                ? "FX difference"
                : "Discount allowed",
        });
      }
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
      if (unallocatedOrig > 0) {
        const advAed = aedFromOriginal(unallocatedOrig, fxRateScaled);
        // Owner decision open: VAT on customer advances — never invent VAT here.
        lines.push({
          accountId: advances,
          creditMinor: advAed,
          currency,
          originalMinor: unallocatedOrig,
          fxRateScaled,
          aedMinor: advAed,
          lineMemo:
            remainderKind === "on_account"
              ? "On account (VAT on advances TBD — owner)"
              : "Customer advance (VAT on advances TBD — owner)",
        });
      }
      if (fxGainLoss !== 0) {
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
      if (unallocatedOrig > 0) {
        if (!remainderIsAdvance) {
          throw new BooksError("unallocated_payment_not_supported", "invalid");
        }
        const prepaidAed = aedFromOriginal(unallocatedOrig, fxRateScaled);
        lines.push({
          accountId: prepaid,
          debitMinor: prepaidAed,
          currency,
          originalMinor: unallocatedOrig,
          fxRateScaled,
          aedMinor: prepaidAed,
          lineMemo:
            remainderKind === "on_account" ? "On account (supplier)" : "Supplier prepaid / advance",
        });
      }
      for (const d of validatedDiffs) {
        if (d.kind === "discount") {
          lines.push({
            accountId: d.accountId,
            creditMinor: d.aed,
            currency,
            originalMinor: d.amountOriginalMinor,
            fxRateScaled,
            aedMinor: d.aed,
            lineMemo: "Discount received",
          });
        } else {
          lines.push({
            accountId: d.accountId,
            debitMinor: d.aed,
            currency,
            originalMinor: d.amountOriginalMinor,
            fxRateScaled,
            aedMinor: d.aed,
            lineMemo: d.kind === "bank_fee" ? "Bank fee" : "FX difference",
          });
        }
      }
      if (fxGainLoss !== 0) {
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
      unallocatedOrig,
      remainderKind: remainderKind || (legacyUnallocated > 0 ? "advance" : null),
      trackPartyAdvance: body.docType === "receipt" && unallocatedOrig > 0,
      aedTotal,
      fxRateScaled,
      currency,
      fxGainLoss,
    };
  }
}

/**
 * Post a receipt/payment. preparerId = the person who recorded it, approverId = the person posting
 * (must be a different approver/admin). With `draftDocumentId`, the draft document recorded by the
 * preparer is claimed (draft → posted, once) instead of inserting a new document.
 */
export async function createReceiptOrPayment(
  preparerId: string,
  approverId: string,
  clientId: string,
  body: ReceiptPaymentInput,
  opts?: { draftDocumentId?: string },
) {
  await assertCanPostFor(approverId, clientId, preparerId);

  const prepared = await withUser(preparerId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    return prepareSettlementInTx(db, clientId, body);
  });

  const voucherType = body.docType === "receipt" ? "Receipt" : "Payment";
  const journal = {
    periodId: await periodForSettlementDate(preparerId, clientId, body.issueDate, body.periodId),
    entryDate: body.issueDate,
    memo: body.memo || voucherType,
    voucherType,
    lines: prepared.lines,
  };

  return postSettlementJournal(preparerId, approverId, clientId, journal, async (db, journalEntryId) => {
    const created = { id: journalEntryId };
    const documentId = opts?.draftDocumentId || randomUUID();
    if (opts?.draftDocumentId) {
      // Conditional claim: a second post of the same draft (double click, two approvers) finds
      // no draft row and fails cleanly — the whole transaction (journal post included) rolls back.
      const claimed = await db.query(
        `UPDATE books_documents SET
           status = 'posted', journal_entry_id = $3, approved_by = $4, voucher_type = $5,
           updated_at = now()
         WHERE id = $1 AND client_id = $2 AND status = 'draft' AND deleted_at IS NULL
           AND doc_type IN ('receipt', 'payment') AND created_by = $6
         RETURNING id`,
        [documentId, clientId, journalEntryId, approverId, voucherType, preparerId],
      );
      if (!claimed.rowCount) throw new BooksError("not_draft", "conflict");
    }
    const entryNo = await postJournalInTx(db, approverId, clientId, journalEntryId);
    const posted = { entryNo };
    if (!opts?.draftDocumentId) {
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
    }

    for (const a of prepared.allocDetails) {
      const payAed = aedFromOriginal(a.allocatedOriginalMinor, prepared.fxRateScaled);
      const gainLoss = payAed - a.allocatedAedAtInvoice;
      await db.query(
        `INSERT INTO books_allocations (
           client_id, settlement_document_id, settlement_journal_id, open_item_id,
           allocated_original_minor, allocated_aed_minor, fx_gain_loss_aed_minor
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
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
      void gainLoss;
    }

    if (prepared.trackPartyAdvance && prepared.unallocatedOrig > 0) {
      const advAed = aedFromOriginal(prepared.unallocatedOrig, prepared.fxRateScaled);
      await db.query(
        `INSERT INTO books_party_advances (client_id, party_id, currency, balance_original_minor, balance_aed_minor)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (client_id, party_id, currency) DO UPDATE SET
           balance_original_minor = books_party_advances.balance_original_minor + EXCLUDED.balance_original_minor,
           balance_aed_minor = books_party_advances.balance_aed_minor + EXCLUDED.balance_aed_minor,
           updated_at = now()`,
        [clientId, body.partyId, prepared.currency, prepared.unallocatedOrig, advAed],
      );
    }

    await writeBooksAudit(db, {
      clientId,
      actor: approverId,
      action: "create_settlement",
      entity: "books_document",
      entityId: documentId,
      after: { entryNo: posted.entryNo, voucherType, preparedBy: preparerId },
    });

    return { documentId, journalEntryId: created.id, entryNo: posted.entryNo };
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

/**
 * Apply an existing 2320 customer advance to an open AR invoice later
 * (Dr 2320 / Cr 1210; reduce books_party_advances; allocate open item).
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
  await assertCanPostFor(approverId, clientId, preparerId);
  if (!Number.isSafeInteger(body.amountOriginalMinor) || body.amountOriginalMinor <= 0) {
    throw new BooksError("invalid_allocation_amount", "invalid");
  }
  const prepared = await withUser(preparerId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const adv = await db.query(
      `SELECT balance_original_minor, balance_aed_minor
       FROM books_party_advances
       WHERE client_id = $1 AND party_id = $2 AND currency = $3`,
      [clientId, body.partyId, currency],
    );
    if (!adv.rowCount) throw new BooksError("advance_not_found", "not_found");
    if (body.amountOriginalMinor > Number(adv.rows[0].balance_original_minor)) {
      throw new BooksError("advance_insufficient", "invalid");
    }
    const oi = await db.query(
      `SELECT id, open_original_minor, open_aed_minor, fx_rate_scaled, side, party_id
       FROM books_open_items WHERE id = $1 AND client_id = $2`,
      [body.openItemId, clientId],
    );
    if (!oi.rowCount) throw new BooksError("open_item_not_found", "not_found");
    if (String(oi.rows[0].party_id) !== body.partyId) {
      throw new BooksError("party_mismatch", "invalid");
    }
    if (String(oi.rows[0].side) !== "AR") throw new BooksError("side_mismatch", "invalid");
    if (body.amountOriginalMinor > Number(oi.rows[0].open_original_minor)) {
      throw new BooksError("allocation_exceeds_open", "invalid");
    }
    const invoiceFx = Number(oi.rows[0].fx_rate_scaled);
    const aed = aedFromOriginal(body.amountOriginalMinor, invoiceFx);
    const ar = (
      await db.query(`SELECT id FROM books_accounts WHERE client_id = $1 AND code = '1210'`, [
        clientId,
      ])
    ).rows[0].id as string;
    const advances = (
      await db.query(`SELECT id FROM books_accounts WHERE client_id = $1 AND code = '2320'`, [
        clientId,
      ])
    ).rows[0].id as string;
    return { aed, ar, advances, invoiceFx };
  });

  const journal = {
    periodId: await periodForSettlementDate(preparerId, clientId, body.issueDate, body.periodId),
    entryDate: body.issueDate,
    memo: "Allocate customer advance",
    voucherType: "Journal",
    lines: [
      {
        accountId: prepared.advances,
        debitMinor: prepared.aed,
        currency,
        originalMinor: body.amountOriginalMinor,
        fxRateScaled: prepared.invoiceFx,
        aedMinor: prepared.aed,
        lineMemo: "Apply advance",
      },
      {
        accountId: prepared.ar,
        creditMinor: prepared.aed,
        currency,
        originalMinor: body.amountOriginalMinor,
        fxRateScaled: prepared.invoiceFx,
        aedMinor: prepared.aed,
        lineMemo: "Settle AR from advance",
      },
    ],
  };

  return postSettlementJournal(preparerId, approverId, clientId, journal, async (db, journalEntryId) => {
    const created = { id: journalEntryId };
    const posted = { entryNo: await postJournalInTx(db, approverId, clientId, journalEntryId) };
    const documentId = randomUUID();
    await db.query(
      `INSERT INTO books_documents (
         id, client_id, doc_type, status, party_id, issue_date, currency, fx_rate_scaled,
         original_total_minor, aed_total_minor, net_minor, vat_minor, gross_minor,
         memo, journal_entry_id, voucher_type, created_by, approved_by
       ) VALUES (
         $1,$2,'receipt','posted',$3,$4,$5,$6,$7,$8,$7,0,$7,'Advance allocation',$9,'Journal',$10,$11
       )`,
      [
        documentId,
        clientId,
        body.partyId,
        body.issueDate,
        currency,
        prepared.invoiceFx,
        body.amountOriginalMinor,
        prepared.aed,
        created.id,
        preparerId,
        approverId,
      ],
    );
    await db.query(
      `INSERT INTO books_allocations (
         client_id, settlement_document_id, settlement_journal_id, open_item_id,
         allocated_original_minor, allocated_aed_minor, fx_gain_loss_aed_minor
       ) VALUES ($1,$2,$3,$4,$5,$6,0)`,
      [
        clientId,
        documentId,
        created.id,
        body.openItemId,
        body.amountOriginalMinor,
        prepared.aed,
      ],
    );
    await applyAllocationToOpenItem(
      db,
      body.openItemId,
      clientId,
      body.amountOriginalMinor,
      prepared.aed,
    );
    // Guarded: two allocations racing on one advance must not drive the balance negative.
    const reduced = await db.query(
      `UPDATE books_party_advances
       SET balance_original_minor = balance_original_minor - $4,
           balance_aed_minor = balance_aed_minor - $5,
           updated_at = now()
       WHERE client_id = $1 AND party_id = $2 AND currency = $3
         AND balance_original_minor >= $4`,
      [clientId, body.partyId, currency, body.amountOriginalMinor, prepared.aed],
    );
    if (!reduced.rowCount) throw new BooksError("advance_insufficient", "invalid");
    await writeBooksAudit(db, {
      clientId,
      actor: approverId,
      action: "allocate_advance",
      entity: "books_document",
      entityId: documentId,
      after: { entryNo: posted.entryNo, openItemId: body.openItemId, preparedBy: preparerId },
    });

    return { documentId, journalEntryId: created.id, entryNo: posted.entryNo };
  });
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
  await assertCanPostFor(approverId, clientId, preparerId);

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

  const journal = {
    periodId: await periodForSettlementDate(preparerId, clientId, body.issueDate, body.periodId),
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
  };

  return postSettlementJournal(preparerId, approverId, clientId, journal, async (db, journalEntryId) => {
    const created = { id: journalEntryId };
    const posted = { entryNo: await postJournalInTx(db, approverId, clientId, journalEntryId) };
    const documentId = randomUUID();
    await db.query(
      `INSERT INTO books_documents (
         id, client_id, doc_type, status, issue_date, currency, fx_rate_scaled,
         original_total_minor, aed_total_minor, net_minor, vat_minor, gross_minor,
         memo, journal_entry_id, bank_account_id, contra_account_id, voucher_type,
         created_by, approved_by
       ) VALUES (
         $1,$2,'contra','posted',$3,$4,$5,$6,$7,$7,0,$7,$8,$9,$10,$11,'Contra',$12,$13
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
        approverId,
      ],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: approverId,
      action: "create_contra",
      entity: "books_document",
      entityId: documentId,
      after: { entryNo: posted.entryNo, preparedBy: preparerId },
    });

    return { documentId, journalEntryId: created.id, entryNo: posted.entryNo };
  });
}

// ---------------------------------------------------------------------------
// Manual receipts & payments: two-step dual control (record draft → a different approver posts).
// The draft is a books_documents row (status 'draft', doc_type receipt/payment, no lines and no
// journal). Its full posting plan (allocations, remainder, differences) is kept in the draft's
// creation audit event, which the app never edits; posting re-validates it against the live open
// items and runs createReceiptOrPayment(preparer = draft creator, approver = poster) atomically.
// ---------------------------------------------------------------------------

const SETTLEMENT_DRAFT_ACTION = "settlement_draft_create";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeSettlementPlan(body: ReceiptPaymentInput): ReceiptPaymentInput {
  return {
    docType: body.docType === "payment" ? "payment" : "receipt",
    partyId: String(body.partyId || ""),
    issueDate: String(body.issueDate || "").slice(0, 10),
    periodId: String(body.periodId || ""),
    bankAccountId: String(body.bankAccountId || ""),
    currency: (body.currency || "AED").toUpperCase(),
    fxRateScaled: body.fxRateScaled ?? 100000000,
    originalAmountMinor: Number(body.originalAmountMinor),
    memo: body.memo ? String(body.memo) : undefined,
    allocations: (body.allocations || []).map((a) => ({
      openItemId: String(a.openItemId || ""),
      allocatedOriginalMinor: Number(a.allocatedOriginalMinor),
    })),
    remainderKind:
      body.remainderKind === "advance" || body.remainderKind === "on_account"
        ? body.remainderKind
        : undefined,
    remainderOriginalMinor:
      body.remainderOriginalMinor != null ? Number(body.remainderOriginalMinor) : undefined,
    differenceLines: (body.differenceLines || []).map((d) => ({
      kind: d.kind,
      accountId: String(d.accountId || ""),
      amountOriginalMinor: Number(d.amountOriginalMinor),
    })),
  };
}

/**
 * Step 1 — the signed-in preparer records a receipt/payment as a draft. Nothing reaches the
 * ledger. `requestId` (a uuid the screen generates per form) makes a repeated submit return the
 * same draft instead of creating a second one.
 */
export async function createSettlementDraft(
  preparerId: string,
  clientId: string,
  input: ReceiptPaymentInput,
  opts?: { requestId?: string },
) {
  const body = normalizeSettlementPlan(input);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.issueDate)) throw new BooksError("issue_date_required", "invalid");
  const documentId = opts?.requestId && UUID_RE.test(opts.requestId) ? opts.requestId : randomUUID();

  return withUser(preparerId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const roleRow = await db.query(`SELECT role FROM users WHERE id = $1`, [preparerId]);
    if (!roleRow.rowCount) throw new BooksError("user_not_found", "forbidden");
    // Same preparer roles as journals (an approver cannot create the draft journal at post time).
    if (!["admin", "accountant"].includes(String(roleRow.rows[0].role))) {
      throw new BooksError("settlement_prepare_forbidden", "forbidden");
    }

    const existing = await db.query(
      `SELECT id, status, created_by FROM books_documents WHERE id = $1 AND client_id = $2`,
      [documentId, clientId],
    );
    if (existing.rowCount) {
      if (String(existing.rows[0].created_by) !== preparerId) {
        throw new BooksError("request_id_conflict", "conflict");
      }
      return { documentId, status: String(existing.rows[0].status), duplicate: true };
    }

    const prepared = await prepareSettlementInTx(db, clientId, body);
    const period = await db.query(
      `SELECT id, status FROM books_periods
       WHERE client_id = $1 AND period_start <= $2::date AND period_end >= $2::date
       ORDER BY period_start DESC LIMIT 1`,
      [clientId, body.issueDate],
    );
    if (!period.rowCount) throw new BooksError("period_not_found", "not_found");
    if (!["OPEN", "REOPENED"].includes(String(period.rows[0].status))) {
      throw new BooksError("period_locked", "period_closed");
    }

    const voucherType = body.docType === "receipt" ? "Receipt" : "Payment";
    const inserted = await db.query(
      `INSERT INTO books_documents (
         id, client_id, doc_type, doc_kind, status, party_id, issue_date,
         currency, fx_rate_scaled, original_total_minor, aed_total_minor,
         net_minor, vat_minor, gross_minor, memo, bank_account_id, voucher_type, created_by
       ) VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$10,0,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
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
        body.bankAccountId,
        voucherType,
        preparerId,
      ],
    );
    if (!inserted.rowCount) {
      // Same requestId submitted twice at once: the other request created it.
      throw new BooksError("request_id_conflict", "conflict");
    }
    await writeBooksAudit(db, {
      clientId,
      actor: preparerId,
      action: SETTLEMENT_DRAFT_ACTION,
      entity: "books_document",
      entityId: documentId,
      after: { status: "draft", plan: body },
    });
    return { documentId, status: "draft", duplicate: false };
  });
}

async function loadSettlementDraft(db: PoolClient, clientId: string, documentId: string) {
  const doc = await db.query(
    `SELECT id, doc_type, status, party_id, original_total_minor, currency, bank_account_id,
            issue_date, created_by, deleted_at
     FROM books_documents WHERE id = $1 AND client_id = $2`,
    [documentId, clientId],
  );
  if (!doc.rowCount || !["receipt", "payment"].includes(String(doc.rows[0].doc_type))) {
    throw new BooksError("settlement_draft_not_found", "not_found");
  }
  const d = doc.rows[0];
  if (d.deleted_at || String(d.status) !== "draft") throw new BooksError("not_draft", "conflict");
  const ev = await db.query(
    `SELECT after_json FROM books_audit_events
     WHERE client_id = $1 AND entity = 'books_document' AND entity_id = $2 AND action = $3
     ORDER BY at ASC LIMIT 1`,
    [clientId, documentId, SETTLEMENT_DRAFT_ACTION],
  );
  const plan = ev.rows[0]?.after_json?.plan as ReceiptPaymentInput | undefined;
  if (!plan) throw new BooksError("settlement_draft_plan_missing", "conflict");
  // The header shown to the approver must be what gets posted.
  if (
    plan.docType !== String(d.doc_type) ||
    plan.partyId !== String(d.party_id) ||
    plan.bankAccountId !== String(d.bank_account_id) ||
    Number(plan.originalAmountMinor) !== Number(d.original_total_minor) ||
    String(plan.currency || "AED").toUpperCase() !== String(d.currency).toUpperCase() ||
    plan.issueDate !== String(d.issue_date).slice(0, 10)
  ) {
    throw new BooksError("settlement_draft_changed", "conflict");
  }
  return { createdBy: String(d.created_by), plan: normalizeSettlementPlan(plan) };
}

/**
 * Step 2 — a different approver/admin posts the draft. Dual control is checked before anything is
 * created; the draft can be posted once (conditional draft → posted claim inside the post
 * transaction), so a double click or a second approver gets `not_draft`.
 */
export async function postSettlementDraft(approverId: string, clientId: string, documentId: string) {
  const draft = await withUser(approverId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const loaded = await loadSettlementDraft(db, clientId, documentId);
    await requireDualControlActor(db, approverId, loaded.createdBy, "post", { clientId });
    return loaded;
  });
  return createReceiptOrPayment(draft.createdBy, approverId, clientId, draft.plan, {
    draftDocumentId: documentId,
  });
}

/** Receipts/payments recorded but not yet posted, with whether the viewer may post each one. */
export async function listSettlementDrafts(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const roleRow = await db.query(`SELECT role FROM users WHERE id = $1`, [userId]);
    const canApprove = ["admin", "approver"].includes(String(roleRow.rows[0]?.role || ""));
    const rows = await db.query(
      `SELECT d.id, d.doc_type AS "docType", d.issue_date AS "issueDate", d.currency,
              d.original_total_minor AS "originalAmountMinor", d.aed_total_minor AS "aedAmountMinor",
              d.memo, d.created_by AS "createdBy", d.created_at AS "createdAt",
              p.id AS "partyId", p.name AS "partyName",
              a.code AS "bankAccountCode", a.name AS "bankAccountName",
              u.name AS "createdByName",
              (SELECT ev.after_json->'plan' FROM books_audit_events ev
               WHERE ev.client_id = d.client_id AND ev.entity = 'books_document'
                 AND ev.entity_id = d.id AND ev.action = $2
               ORDER BY ev.at ASC LIMIT 1) AS plan
       FROM books_documents d
       LEFT JOIN books_parties p ON p.id = d.party_id
       LEFT JOIN books_accounts a ON a.id = d.bank_account_id
       LEFT JOIN users u ON u.id = d.created_by
       WHERE d.client_id = $1 AND d.doc_type IN ('receipt', 'payment')
         AND d.status = 'draft' AND d.deleted_at IS NULL
       ORDER BY d.created_at DESC`,
      [clientId, SETTLEMENT_DRAFT_ACTION],
    );
    return rows.rows.map((r) => {
      const plan = (r.plan || {}) as Partial<ReceiptPaymentInput>;
      const allocations = Array.isArray(plan.allocations) ? plan.allocations : [];
      const allocatedMinor = allocations.reduce(
        (sum, a) => sum + Number(a.allocatedOriginalMinor || 0),
        0,
      );
      return {
        id: String(r.id),
        docType: String(r.docType),
        issueDate: String(r.issueDate).slice(0, 10),
        currency: String(r.currency),
        originalAmountMinor: Number(r.originalAmountMinor),
        aedAmountMinor: Number(r.aedAmountMinor),
        memo: String(r.memo || ""),
        partyId: r.partyId ? String(r.partyId) : null,
        partyName: r.partyName ? String(r.partyName) : null,
        bankAccountCode: r.bankAccountCode ? String(r.bankAccountCode) : null,
        bankAccountName: r.bankAccountName ? String(r.bankAccountName) : null,
        createdBy: String(r.createdBy),
        createdByName: r.createdByName ? String(r.createdByName) : null,
        createdAt: r.createdAt,
        allocationCount: allocations.length,
        allocatedMinor,
        remainderMinor: Math.max(0, Number(r.originalAmountMinor) - allocatedMinor),
        remainderKind: plan.remainderKind ?? null,
        canPost: canApprove && String(r.createdBy) !== userId,
      };
    });
  });
}

/** Discard a draft receipt/payment (creator or an approver/admin). Posted ones are never touched. */
export async function discardSettlementDraft(userId: string, clientId: string, documentId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const draft = await loadSettlementDraft(db, clientId, documentId).catch((e) => {
      // A changed/plan-less draft can still be discarded.
      if (e instanceof BooksError && /settlement_draft_(changed|plan_missing)/.test(e.message)) {
        return null;
      }
      throw e;
    });
    const roleRow = await db.query(`SELECT role FROM users WHERE id = $1`, [userId]);
    const role = String(roleRow.rows[0]?.role || "");
    const creator = draft
      ? draft.createdBy
      : String(
          (
            await db.query(`SELECT created_by FROM books_documents WHERE id = $1 AND client_id = $2`, [
              documentId,
              clientId,
            ])
          ).rows[0]?.created_by || "",
        );
    if (creator !== userId && !["admin", "approver"].includes(role)) {
      throw new BooksError("settlement_discard_forbidden", "forbidden");
    }
    const upd = await db.query(
      `UPDATE books_documents SET deleted_at = now(), status = 'void', updated_at = now()
       WHERE id = $1 AND client_id = $2 AND status = 'draft' AND deleted_at IS NULL
         AND doc_type IN ('receipt', 'payment')`,
      [documentId, clientId],
    );
    if (!upd.rowCount) throw new BooksError("not_draft", "conflict");
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "soft_delete_draft",
      entity: "books_document",
      entityId: documentId,
      before: { status: "draft" },
      after: { status: "void", deleted_at: "set" },
    });
    return { ok: true, documentId };
  });
}
