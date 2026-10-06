import { randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { aedFromOriginal } from "@/lib/fx";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { applyAllocationToOpenItem } from "@/server/books/open-items";
import { assertSyntheticTenant } from "@/server/security-gate";

export type AllocationInput = {
  openItemId: string;
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

async function accountCode(db: import("pg").PoolClient, clientId: string, accountId: string) {
  const row = await db.query(
    `SELECT code, is_bank FROM books_accounts WHERE id = $1 AND client_id = $2`,
    [accountId, clientId],
  );
  if (!row.rowCount) throw new BooksError("account_not_found", "not_found");
  return row.rows[0] as { code: string; is_bank: boolean };
}

export async function createReceiptOrPayment(
  preparerId: string,
  approverId: string,
  clientId: string,
  body: ReceiptPaymentInput,
) {
  const currency = (body.currency || "AED").toUpperCase();
  const fxRateScaled = body.fxRateScaled ?? 100000000;
  const aedTotal = aedFromOriginal(body.originalAmountMinor, fxRateScaled);
  const allocations = body.allocations || [];

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

    if (allocOrigSum > body.originalAmountMinor) {
      throw new BooksError("allocations_exceed_payment", "invalid");
    }

    const unallocatedOrig = body.originalAmountMinor - allocOrigSum;
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
        lines.push({
          accountId: advances,
          creditMinor: advAed,
          currency,
          originalMinor: unallocatedOrig,
          fxRateScaled,
          aedMinor: advAed,
          lineMemo: "Customer advance (VAT policy TBD)",
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
      if (unallocatedOrig > 0) {
        throw new BooksError("unallocated_payment_not_supported", "invalid");
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
      unallocatedOrig,
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
  await withUser(approverId, async (db) => {
    await db.query(
      `INSERT INTO books_documents (
         id, client_id, doc_type, doc_kind, status, party_id, issue_date,
         currency, fx_rate_scaled, original_total_minor, aed_total_minor,
         net_minor, vat_minor, gross_minor, memo, journal_entry_id,
         bank_account_id, voucher_type, created_by, approved_by
       ) VALUES (
         $1,$2,$3,$4,'posted',$5,$6,$7,$8,$9,$10,$10,0,$10,$11,$12,$13,$14,$15,$15
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
      ],
    );

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

    if (body.docType === "receipt" && prepared.unallocatedOrig > 0) {
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
      after: { entryNo: posted.entryNo, voucherType },
    });
  });

  return { documentId, journalEntryId: created.id, entryNo: posted.entryNo };
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

  const created = await createBooksJournal(preparerId, clientId, {
    periodId: body.periodId,
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
    post: false,
  });
  const posted = await postBooksJournal(approverId, clientId, created.id);

  const documentId = randomUUID();
  await withUser(approverId, async (db) => {
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
    await db.query(
      `UPDATE books_party_advances
       SET balance_original_minor = balance_original_minor - $4,
           balance_aed_minor = balance_aed_minor - $5,
           updated_at = now()
       WHERE client_id = $1 AND party_id = $2 AND currency = $3`,
      [clientId, body.partyId, currency, body.amountOriginalMinor, prepared.aed],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: approverId,
      action: "allocate_advance",
      entity: "books_document",
      entityId: documentId,
      after: { entryNo: posted.entryNo, openItemId: body.openItemId },
    });
  });

  return { documentId, journalEntryId: created.id, entryNo: posted.entryNo };
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
