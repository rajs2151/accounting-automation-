import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { MoneyTypeError } from "@/lib/money";
import { requireSession, SessionError } from "@/lib/session";
import {
  booksCoaTree,
  createBooksAccount,
  deactivateBooksAccount,
  getBooksCompanyProfile,
  inviteBooksUser,
  listBooksAccounts,
  listBooksInvites,
  listBooksUsers,
  updateBooksAccount,
  updateBooksCompanyProfile,
  updateBooksUserRole,
} from "@/server/books/accounts";
import {
  listBooksJournalAttachments,
  uploadBooksAttachmentStaging,
  uploadBooksJournalAttachment,
} from "@/server/books/attachments";
import { listBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import {
  beginBooksJournalCorrection,
  bulkAddBooksJournalTags,
  bulkPostBooksJournals,
  bulkRemoveBooksJournalTags,
  bulkReverseBooksJournals,
  bulkTagBooksJournals,
  createBooksJournal,
  getBooksJournal,
  listBooksJournals,
  postBooksJournal,
  replaceBooksJournalDraft,
  reverseBooksJournal,
  softDeleteBooksJournalDraft,
  updateBooksJournalMemo,
  updateBooksJournalNote,
  updateBooksJournalTags,
} from "@/server/books/journals";
import {
  createBooksSavedView,
  deleteBooksSavedView,
  listBooksSavedViews,
  updateBooksSavedView,
} from "@/server/books/saved-views";
import {
  createBooksTag,
  deleteBooksTag,
  listBooksTags,
  mergeBooksTags,
  updateBooksTag,
} from "@/server/books/tags";
import {
  listBooksBankAccounts,
  updateBooksBankAccountSetup,
} from "@/server/books/bank-accounts";
import {
  createBooksBankRule,
  createBooksBankRuleFromTxn,
  listBooksBankRules,
  previewBooksBankRule,
} from "@/server/books/bank-rules";
import {
  excludeBooksBankTransaction,
  linkBooksBankTransferPair,
  listBooksBankTxnAllocations,
  listBooksBankTxnMatchCandidates,
  listBooksBankTxnTransferCandidates,
  listBooksBankTransactions,
  markBooksBankTransactionReviewed,
  matchBooksBankTransaction,
  materializeBooksBankTransactions,
  postBooksBankTransaction,
  rejectBooksBankTxnMatchSuggestion,
  setBooksBankTxnAllocations,
  unlinkBooksBankTransferPair,
  updateBooksBankTransaction,
  type BankTxnAllocInput,
} from "@/server/books/bank-transactions";
import {
  acknowledgeBooksDocumentCheckVat,
  approveAndPostBooksDocument,
  createBooksDocument,
  getBooksDocument,
  listBooksDocuments,
  previewBooksDocumentJournal,
  softDeleteBooksDocumentDraft,
  voidBooksDocument,
  updateBooksDocumentPrintedFields,
} from "@/server/books/documents";
import {
  confirmInboxAsDocument,
  getBooksInboxReview,
  listBooksInbox,
  retryBooksInboxExtract,
  routeInboxItem,
  setInboxDocType,
  uploadBooksInboxFiles,
} from "@/server/books/inbox";
import {
  createOpeningImport,
  parseOpeningTbCsv,
  postOpeningImport,
} from "@/server/books/opening-import";
import {
  assertOpenItemsMatchRebuild,
  getBooksOpenItemKpis,
  listBooksOpenItems,
} from "@/server/books/open-items";
import {
  createBooksParty,
  listBooksParties,
  partyDisbursementNet,
  suggestPartyDuplicates,
  updateBooksParty,
} from "@/server/books/parties";
import {
  createBooksPeriod,
  listBooksPeriods,
  lockBooksPeriod,
  reopenBooksPeriod,
} from "@/server/books/periods";
import {
  allocatePartyAdvance,
  createContra,
  createReceiptOrPayment,
  getPartyAdvanceBalance,
} from "@/server/books/settlements";
import {
  listPlaceOfSupplyGaps,
  reapplyPlaceOfSupplyRule,
  setDocumentPlaceOfSupply,
} from "@/server/books/place-of-supply";
import { getBankReconciliation, listBankReconciliations } from "@/server/books/bank-recon";
import { getCompanyVatSettings, setCompanyVatSettings } from "@/server/books/company-vat-settings";
import { booksAgeing } from "@/server/books/ageing";
import { getBooksMonthChecklist, listBooksIssues } from "@/server/books/dashboard";
import { booksDayBook } from "@/server/books/day-book";
import { generateVat201Draft, VatReturnBlockedError } from "@/server/books/vat201";
import {
  getStatementExtraction,
  ingestCsvToStatement,
  listCsvProfiles,
  listStatementExtractions,
  listStatementLogs,
  saveCsvProfile,
  updateStatementLines,
} from "@/server/books/statement-extractions";
import { booksAccountLedger, booksTrialBalance } from "@/server/books/trial-balance";
import { listBooksVatCodes } from "@/server/books/vat-codes";
import { booksVatSettlementPreview } from "@/server/books/vat-settlement";
import { listBooksVoucherSequences, updateBooksVoucherSequence } from "@/server/books/vouchers";
import { LedgerError } from "@/server/errors";
import { assertSessionTenantAllowed } from "@/server/security-gate";

type Ctx = { params: Promise<{ path: string[] }> };

function fail(error: unknown) {
  if (error instanceof SessionError) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (error instanceof MoneyTypeError) {
    return NextResponse.json({ error: "invalid_money", message: error.message }, { status: 400 });
  }
  if (error instanceof LedgerError || error instanceof BooksError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "forbidden"
          ? 403
          : error.code === "period_closed" || error.code === "conflict"
            ? 409
            : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  // Unexpected error: log it under a short ref the user can quote; never show a bare "request failed".
  const ref = randomUUID().slice(0, 8);
  console.error(`[books-api ref=${ref}]`, error);
  return NextResponse.json({ error: "internal_error", ref }, { status: 500 });
}

async function context() {
  const session = await requireSession();
  await assertSessionTenantAllowed(session.userId, session.clientId);
  return session;
}

function journalListFilters(url: URL) {
  const amountMin = url.searchParams.get("amountMinMinor");
  const amountMax = url.searchParams.get("amountMaxMinor");
  const tags = url.searchParams.get("tags");
  const accountIds = url.searchParams.get("accountIds");
  const hasAttachment = url.searchParams.get("hasAttachment");
  return {
    periodId: url.searchParams.get("periodId") || undefined,
    status: url.searchParams.get("status") || undefined,
    tag: url.searchParams.get("tag") || undefined,
    tags: tags ? tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    reference: url.searchParams.get("reference") || undefined,
    q: url.searchParams.get("q") || undefined,
    entryType: url.searchParams.get("entryType") || undefined,
    voucherType: url.searchParams.get("voucherType") || undefined,
    fromDate: url.searchParams.get("fromDate") || undefined,
    toDate: url.searchParams.get("toDate") || undefined,
    accountIds: accountIds ? accountIds.split(",").filter(Boolean) : undefined,
    amountMinMinor: amountMin != null && amountMin !== "" ? Number(amountMin) : undefined,
    amountMaxMinor: amountMax != null && amountMax !== "" ? Number(amountMax) : undefined,
    createdBy: url.searchParams.get("createdBy") || undefined,
    postedBy: url.searchParams.get("postedBy") || undefined,
    hasAttachment:
      hasAttachment === "1" ? true : hasAttachment === "0" ? false : undefined,
  };
}

export async function GET(request: Request, ctx: Ctx) {
  try {
    const session = await context();
    const path = (await ctx.params).path || [];
    const url = new URL(request.url);

    if (path[0] === "periods" && path.length === 1) {
      return NextResponse.json(await listBooksPeriods(session.userId, session.clientId));
    }
    if (path[0] === "accounts" && path.length === 1) {
      const postableOnly = url.searchParams.get("postableOnly") === "1";
      return NextResponse.json(
        await listBooksAccounts(session.userId, session.clientId, { postableOnly }),
      );
    }
    if (path[0] === "coa" && path.length === 1) {
      const periodId = url.searchParams.get("periodId") || undefined;
      return NextResponse.json(await booksCoaTree(session.userId, session.clientId, periodId));
    }
    if (path[0] === "account-ledger" && path.length === 1) {
      const periodId = url.searchParams.get("periodId");
      const accountId = url.searchParams.get("accountId");
      if (!periodId || !accountId) {
        return NextResponse.json({ error: "periodId_and_accountId_required" }, { status: 400 });
      }
      return NextResponse.json(
        await booksAccountLedger(session.userId, session.clientId, periodId, accountId),
      );
    }
    if (path[0] === "company" && path.length === 1) {
      return NextResponse.json(await getBooksCompanyProfile(session.userId, session.clientId));
    }
    if (path[0] === "users" && path.length === 1) {
      return NextResponse.json(await listBooksUsers(session.userId, session.clientId));
    }
    if (path[0] === "invites" && path.length === 1) {
      return NextResponse.json(await listBooksInvites(session.userId, session.clientId));
    }
    if (path[0] === "voucher-sequences" && path.length === 1) {
      return NextResponse.json(await listBooksVoucherSequences(session.userId, session.clientId));
    }
    if (path[0] === "vat-settlement" && path.length === 1) {
      const periodId = url.searchParams.get("periodId");
      if (!periodId) return NextResponse.json({ error: "periodId_required" }, { status: 400 });
      return NextResponse.json(
        await booksVatSettlementPreview(session.userId, session.clientId, periodId),
      );
    }
    if (path[0] === "tags" && path.length === 1) {
      return NextResponse.json(await listBooksTags(session.userId, session.clientId));
    }
    if (path[0] === "saved-views" && path.length === 1) {
      return NextResponse.json(await listBooksSavedViews(session.userId, session.clientId));
    }
    if (path[0] === "journals" && path.length === 1) {
      return NextResponse.json(
        await listBooksJournals(session.userId, session.clientId, journalListFilters(url)),
      );
    }
    if (path[0] === "journals" && path.length === 2) {
      return NextResponse.json(await getBooksJournal(session.userId, session.clientId, path[1]));
    }
    if (path[0] === "journals" && path[2] === "audit" && path.length === 3) {
      return NextResponse.json(await listBooksAudit(session.userId, session.clientId, path[1]));
    }
    if (path[0] === "journals" && path[2] === "attachments" && path.length === 3) {
      return NextResponse.json(
        await listBooksJournalAttachments(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "trial-balance" && path.length === 1) {
      const periodId = url.searchParams.get("periodId");
      if (!periodId) return NextResponse.json({ error: "periodId_required" }, { status: 400 });
      const includeZeroBalances = url.searchParams.get("includeZero") === "1";
      return NextResponse.json(
        await booksTrialBalance(session.userId, session.clientId, periodId, {
          includeZeroBalances,
        }),
      );
    }
    if (path[0] === "vat-codes" && path.length === 1) {
      return NextResponse.json(await listBooksVatCodes(session.userId, session.clientId));
    }
    if (path[0] === "parties" && path.length === 1) {
      return NextResponse.json(
        await listBooksParties(session.userId, session.clientId, {
          partyType: url.searchParams.get("partyType") || undefined,
          q: url.searchParams.get("q") || undefined,
        }),
      );
    }
    if (path[0] === "parties" && path[2] === "disbursement-net" && path.length === 3) {
      return NextResponse.json(
        await partyDisbursementNet(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "parties" && path[2] === "advances" && path.length === 3) {
      return NextResponse.json(
        await getPartyAdvanceBalance(
          session.userId,
          session.clientId,
          path[1],
          url.searchParams.get("currency") || "AED",
        ),
      );
    }
    if (path[0] === "documents" && path.length === 1) {
      return NextResponse.json(
        await listBooksDocuments(session.userId, session.clientId, {
          docType: url.searchParams.get("docType") || undefined,
          status: url.searchParams.get("status") || undefined,
          q: url.searchParams.get("q") || undefined,
        }),
      );
    }
    if (path[0] === "documents" && path.length === 2) {
      return NextResponse.json(await getBooksDocument(session.userId, session.clientId, path[1]));
    }
    if (path[0] === "company" && path[1] === "vat-settings" && path.length === 2) {
      return NextResponse.json(await getCompanyVatSettings(session.userId, session.clientId));
    }
    if (path[0] === "vat201" && path[1] === "draft" && path.length === 2) {
      try {
        return NextResponse.json(
          await generateVat201Draft(session.userId, session.clientId, {
            from: url.searchParams.get("from") || undefined,
            to: url.searchParams.get("to") || undefined,
            monthEnd: url.searchParams.get("monthEnd") || undefined,
          }),
        );
      } catch (error) {
        if (error instanceof VatReturnBlockedError) {
          return NextResponse.json(
            { error: error.message, code: error.code, gaps: error.gaps },
            { status: 409 },
          );
        }
        throw error;
      }
    }
    if (path[0] === "reports" && path[1] === "day-book" && path.length === 2) {
      return NextResponse.json(
        await booksDayBook(session.userId, session.clientId, {
          from: url.searchParams.get("from") || "",
          to: url.searchParams.get("to") || "",
          type: url.searchParams.get("type") || null,
        }),
      );
    }
    if (path[0] === "reports" && path[1] === "ageing" && path.length === 2) {
      const side = (url.searchParams.get("side") || "ar").toUpperCase();
      return NextResponse.json(
        await booksAgeing(session.userId, session.clientId, {
          side: side === "AP" ? "AP" : side === "AR" ? "AR" : (side as "AR"),
          asOf: url.searchParams.get("asOf") || "",
        }),
      );
    }
    if (path[0] === "dashboard" && path.length === 1) {
      return NextResponse.json(
        await getBooksMonthChecklist(session.userId, session.clientId, {
          periodId: url.searchParams.get("periodId") || null,
        }),
      );
    }
    if (path[0] === "dashboard" && path[1] === "issues" && path.length === 2) {
      return NextResponse.json(
        await listBooksIssues(session.userId, session.clientId, {
          periodId: url.searchParams.get("periodId") || null,
        }),
      );
    }
    if (path[0] === "bank-recon" && (path.length === 1 || path.length === 2)) {
      const periodId = url.searchParams.get("periodId") || "";
      if (!periodId) throw new BooksError("period_required", "invalid");
      return NextResponse.json(
        path.length === 1
          ? await listBankReconciliations(session.userId, session.clientId, { periodId })
          : await getBankReconciliation(session.userId, session.clientId, {
              accountId: path[1],
              periodId,
            }),
      );
    }
    if (path[0] === "place-of-supply" && path[1] === "gaps" && path.length === 2) {
      return NextResponse.json(
        await listPlaceOfSupplyGaps(session.userId, session.clientId, {
          from: url.searchParams.get("from") || undefined,
          to: url.searchParams.get("to") || undefined,
        }),
      );
    }
    if (path[0] === "documents" && path[2] === "journal-preview" && path.length === 3) {
      return NextResponse.json(
        await previewBooksDocumentJournal(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "open-items" && path.length === 1) {
      return NextResponse.json(
        await listBooksOpenItems(session.userId, session.clientId, {
          partyId: url.searchParams.get("partyId") || undefined,
          side: url.searchParams.get("side") || undefined,
          status: url.searchParams.get("status") || undefined,
        }),
      );
    }
    if (path[0] === "open-items" && path[1] === "kpis" && path.length === 2) {
      const side = url.searchParams.get("side") === "AR" ? "AR" : "AP";
      const partyId = url.searchParams.get("partyId") || undefined;
      return NextResponse.json(
        await getBooksOpenItemKpis(session.userId, session.clientId, side, { partyId }),
      );
    }
    if (path[0] === "open-items" && path[1] === "rebuild-check" && path.length === 2) {
      return NextResponse.json(
        await assertOpenItemsMatchRebuild(session.userId, session.clientId),
      );
    }
    if (path[0] === "inbox" && path.length === 1) {
      const unassigned = url.searchParams.get("unassigned") === "1";
      return NextResponse.json(
        await listBooksInbox(session.userId, unassigned ? null : session.clientId, {
          unassignedOnly: unassigned,
        }),
      );
    }
    if (path[0] === "inbox" && path.length === 2) {
      return NextResponse.json(
        await getBooksInboxReview(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "bank-accounts" && path.length === 1) {
      return NextResponse.json(await listBooksBankAccounts(session.userId, session.clientId));
    }
    if (path[0] === "bank-transactions" && path.length === 1) {
      return NextResponse.json(
        await listBooksBankTransactions(session.userId, session.clientId, {
          accountId: url.searchParams.get("accountId") || undefined,
          status: url.searchParams.get("status") || undefined,
          q: url.searchParams.get("q") || undefined,
          unmatchedOnly: url.searchParams.get("unmatched") === "1",
        }),
      );
    }
    if (path[0] === "bank-rules" && path.length === 1) {
      return NextResponse.json(await listBooksBankRules(session.userId, session.clientId));
    }
    if (path[0] === "bank-rules" && path[2] === "preview" && path.length === 3) {
      return NextResponse.json(
        await previewBooksBankRule(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "match-candidates" && path.length === 3) {
      return NextResponse.json(
        await listBooksBankTxnMatchCandidates(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "transfer-candidates" && path.length === 3) {
      return NextResponse.json(
        await listBooksBankTxnTransferCandidates(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "allocations" && path.length === 3) {
      return NextResponse.json(
        await listBooksBankTxnAllocations(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "statements" && path.length === 1) {
      return NextResponse.json(await listStatementExtractions(session.userId, session.clientId));
    }
    if (path[0] === "statements" && path[2] === "logs" && path.length === 3) {
      return NextResponse.json(
        await listStatementLogs(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "statements" && path.length === 2) {
      return NextResponse.json(
        await getStatementExtraction(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "csv-profiles" && path.length === 1) {
      return NextResponse.json(await listCsvProfiles(session.userId, session.clientId));
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request, ctx: Ctx) {
  try {
    const session = await context();
    const path = (await ctx.params).path || [];
    const contentType = request.headers.get("content-type") || "";

    if (path[0] === "attachments" && path.length === 1 && contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) {
        return NextResponse.json({ error: "file_required" }, { status: 400 });
      }
      const filename = typeof form.get("filename") === "string" ? String(form.get("filename")) : "upload";
      const buffer = Buffer.from(await file.arrayBuffer());
      return NextResponse.json(
        await uploadBooksAttachmentStaging(
          session.userId,
          session.clientId,
          buffer,
          filename,
          file.type || "application/octet-stream",
        ),
      );
    }

    if (path[0] === "inbox" && path[1] === "upload" && contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const unassigned = String(form.get("unassigned") || "") === "1";
      // Statements UI sends userDocType=bank_statement; sales/purchases still use intendedType.
      const userDocRaw = String(form.get("userDocType") || "");
      const intendedRaw = String(form.get("intendedType") || userDocRaw || "");
      const allowedIntended = new Set([
        "purchase_bill",
        "sales_invoice",
        "bank_statement",
        "card_statement",
        "gateway_statement",
      ]);
      const intendedType = allowedIntended.has(intendedRaw)
        ? (intendedRaw as
            | "purchase_bill"
            | "sales_invoice"
            | "bank_statement"
            | "card_statement"
            | "gateway_statement")
        : null;
      const userDocType =
        userDocRaw ||
        (intendedType === "bank_statement" ||
        intendedType === "card_statement" ||
        intendedType === "gateway_statement"
          ? intendedType
          : null);
      const uploaded: Array<{ filename: string; contentType: string; bytes: Buffer }> = [];
      for (const [key, value] of form.entries()) {
        if (key !== "file" && key !== "files") continue;
        if (!(value instanceof Blob)) continue;
        const filename = "name" in value && typeof value.name === "string" ? value.name : "upload";
        uploaded.push({
          filename,
          contentType: value.type || "application/octet-stream",
          bytes: Buffer.from(await value.arrayBuffer()),
        });
      }
      if (!uploaded.length) return NextResponse.json({ error: "file_required" }, { status: 400 });
      const accountIdRaw = String(form.get("accountId") || "").trim();
      return NextResponse.json(
        await uploadBooksInboxFiles(
          session.userId,
          unassigned ? null : session.clientId,
          uploaded,
          {
            intendedType,
            userDocType,
            accountId: accountIdRaw || null,
          },
        ),
      );
    }

    if (
      path[0] === "journals" &&
      path.length === 3 &&
      path[2] === "attachments" &&
      contentType.includes("multipart/form-data")
    ) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) {
        return NextResponse.json({ error: "file_required" }, { status: 400 });
      }
      const filename = typeof form.get("filename") === "string" ? String(form.get("filename")) : "upload";
      const buffer = Buffer.from(await file.arrayBuffer());
      return NextResponse.json(
        await uploadBooksJournalAttachment(
          session.userId,
          session.clientId,
          path[1],
          buffer,
          filename,
          file.type || "application/octet-stream",
        ),
      );
    }

    const body = await request.json().catch(() => ({}));

    if (path[0] === "periods" && path.length === 1) {
      return NextResponse.json(
        await createBooksPeriod(session.userId, session.clientId, {
          label: String(body.label || ""),
          periodStart: String(body.periodStart || ""),
          periodEnd: String(body.periodEnd || ""),
        }),
      );
    }
    if (path[0] === "periods" && path[2] === "lock" && path.length === 3) {
      return NextResponse.json(await lockBooksPeriod(session.userId, session.clientId, path[1]));
    }
    if (path[0] === "periods" && path[2] === "reopen" && path.length === 3) {
      return NextResponse.json(
        await reopenBooksPeriod(session.userId, session.clientId, path[1], String(body.reason || "")),
      );
    }
    if (path[0] === "company" && path.length === 1) {
      return NextResponse.json(
        await updateBooksCompanyProfile(session.userId, session.clientId, {
          name: body.name != null ? String(body.name) : undefined,
          trn: body.trn === undefined ? undefined : body.trn == null ? null : String(body.trn),
          defaultCurrency: body.defaultCurrency != null ? String(body.defaultCurrency) : undefined,
          fiscalYearStartMonth:
            body.fiscalYearStartMonth != null ? Number(body.fiscalYearStartMonth) : undefined,
        }),
      );
    }
    if (path[0] === "accounts" && path.length === 1) {
      return NextResponse.json(
        await createBooksAccount(session.userId, session.clientId, {
          code: String(body.code || ""),
          name: String(body.name || ""),
          accountType: String(body.accountType || "expense"),
          parentId: body.parentId ? String(body.parentId) : null,
          normalBalance: body.normalBalance ? String(body.normalBalance) : undefined,
          statementLine: body.statementLine ? String(body.statementLine) : undefined,
          defaultVatCode:
            body.defaultVatCode === undefined
              ? undefined
              : body.defaultVatCode == null
                ? null
                : String(body.defaultVatCode),
          isPostable: body.isPostable === undefined ? undefined : Boolean(body.isPostable),
        }),
      );
    }
    if (path[0] === "accounts" && path[2] === "deactivate" && path.length === 3) {
      return NextResponse.json(
        await deactivateBooksAccount(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "tags" && path[1] === "merge" && path.length === 2) {
      return NextResponse.json(
        await mergeBooksTags(
          session.userId,
          session.clientId,
          String(body.sourceTagId || ""),
          String(body.targetTagId || ""),
        ),
      );
    }
    if (path[0] === "tags" && path.length === 1) {
      return NextResponse.json(
        await createBooksTag(session.userId, session.clientId, {
          name: String(body.name || ""),
          colour: body.colour ? String(body.colour) : undefined,
        }),
      );
    }
    if (path[0] === "saved-views" && path.length === 1) {
      return NextResponse.json(
        await createBooksSavedView(session.userId, session.clientId, {
          name: String(body.name || ""),
          scope: body.scope === "shared" ? "shared" : "personal",
          config: typeof body.config === "object" && body.config ? body.config : {},
        }),
      );
    }
    if (path[0] === "journals" && path[1] === "bulk" && path[2] === "post") {
      const entryIds = Array.isArray(body.entryIds) ? body.entryIds.map(String) : [];
      return NextResponse.json(await bulkPostBooksJournals(session.userId, session.clientId, entryIds));
    }
    if (path[0] === "journals" && path[1] === "bulk" && path[2] === "reverse") {
      const entryIds = Array.isArray(body.entryIds) ? body.entryIds.map(String) : [];
      return NextResponse.json(
        await bulkReverseBooksJournals(
          session.userId,
          session.clientId,
          entryIds,
          String(body.entryDate || new Date().toISOString().slice(0, 10)),
        ),
      );
    }
    if (path[0] === "journals" && path[1] === "bulk" && path[2] === "tag") {
      const entryIds = Array.isArray(body.entryIds) ? body.entryIds.map(String) : [];
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
      return NextResponse.json(await bulkTagBooksJournals(session.userId, session.clientId, entryIds, tags));
    }
    if (path[0] === "journals" && path[1] === "bulk" && path[2] === "add-tag") {
      const entryIds = Array.isArray(body.entryIds) ? body.entryIds.map(String) : [];
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
      return NextResponse.json(
        await bulkAddBooksJournalTags(session.userId, session.clientId, entryIds, tags),
      );
    }
    if (path[0] === "journals" && path[1] === "bulk" && path[2] === "remove-tag") {
      const entryIds = Array.isArray(body.entryIds) ? body.entryIds.map(String) : [];
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
      return NextResponse.json(
        await bulkRemoveBooksJournalTags(session.userId, session.clientId, entryIds, tags),
      );
    }
    if (path[0] === "users" && path[2] === "role" && path.length === 3) {
      return NextResponse.json(
        await updateBooksUserRole(
          session.userId,
          session.clientId,
          path[1],
          String(body.role || ""),
        ),
      );
    }
    if (path[0] === "invites" && path.length === 1) {
      return NextResponse.json(
        await inviteBooksUser(session.userId, session.clientId, {
          email: String(body.email || ""),
          role: String(body.role || "accountant"),
        }),
      );
    }
    if (path[0] === "voucher-sequences" && path.length === 1) {
      return NextResponse.json(
        await updateBooksVoucherSequence(session.userId, session.clientId, {
          voucherType: String(body.voucherType || ""),
          year: body.year != null ? Number(body.year) : undefined,
          prefix: body.prefix != null ? String(body.prefix) : undefined,
          lastN: body.lastN != null ? Number(body.lastN) : undefined,
        }),
      );
    }
    if (path[0] === "journals" && path.length === 1) {
      return NextResponse.json(
        await createBooksJournal(session.userId, session.clientId, {
          periodId: String(body.periodId || ""),
          entryDate: String(body.entryDate || ""),
          memo: body.memo ? String(body.memo) : body.description ? String(body.description) : "",
          reference: body.reference ? String(body.reference) : "",
          tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
          voucherType: body.voucherType ? String(body.voucherType) : undefined,
          correctsEntryId: body.correctsEntryId ? String(body.correctsEntryId) : null,
          lines: Array.isArray(body.lines) ? body.lines : [],
          post: Boolean(body.post),
          scheduledFor: body.scheduledFor ? String(body.scheduledFor) : null,
          autoReverseNextPeriod: Boolean(body.autoReverseNextPeriod),
          templateKey: body.templateKey ? String(body.templateKey) : null,
          recurring: body.recurring ?? null,
          attachmentFileIds: Array.isArray(body.attachmentFileIds)
            ? body.attachmentFileIds.map(String)
            : [],
        }),
      );
    }
    if (path[0] === "journals" && path[2] === "post" && path.length === 3) {
      return NextResponse.json(await postBooksJournal(session.userId, session.clientId, path[1]));
    }
    if (path[0] === "journals" && path[2] === "reverse" && path.length === 3) {
      return NextResponse.json(
        await reverseBooksJournal(
          session.userId,
          session.clientId,
          path[1],
          String(body.entryDate || new Date().toISOString().slice(0, 10)),
        ),
      );
    }
    if (path[0] === "journals" && path[2] === "correct" && path.length === 3) {
      return NextResponse.json(
        await beginBooksJournalCorrection(
          session.userId,
          session.clientId,
          path[1],
          String(body.entryDate || new Date().toISOString().slice(0, 10)),
        ),
      );
    }
    if (path[0] === "journals" && path[2] === "memo" && path.length === 3) {
      return NextResponse.json(
        await updateBooksJournalMemo(session.userId, session.clientId, path[1], String(body.memo || "")),
      );
    }
    if (path[0] === "journals" && path[2] === "note" && path.length === 3) {
      return NextResponse.json(
        await updateBooksJournalNote(session.userId, session.clientId, path[1], String(body.note || "")),
      );
    }
    if (path[0] === "journals" && path[2] === "tags" && path.length === 3) {
      return NextResponse.json(
        await updateBooksJournalTags(
          session.userId,
          session.clientId,
          path[1],
          Array.isArray(body.tags) ? body.tags.map(String) : [],
        ),
      );
    }
    if (path[0] === "parties" && path[1] === "suggest" && path.length === 2) {
      return NextResponse.json(
        await suggestPartyDuplicates(
          session.userId,
          session.clientId,
          String(body.partyType || "customer"),
          String(body.name || ""),
          body.trn ? String(body.trn) : null,
        ),
      );
    }
    if (path[0] === "parties" && path.length === 1) {
      return NextResponse.json(await createBooksParty(session.userId, session.clientId, body));
    }
    if (path[0] === "documents" && path.length === 1) {
      return NextResponse.json(await createBooksDocument(session.userId, session.clientId, body));
    }
    if (path[0] === "documents" && path[2] === "approve" && path.length === 3) {
      const applyAdvanceOriginalMinor =
        body.applyAdvanceOriginalMinor != null
          ? Number(body.applyAdvanceOriginalMinor)
          : undefined;
      return NextResponse.json(
        await approveAndPostBooksDocument(session.userId, session.clientId, path[1], {
          applyAdvanceOriginalMinor:
            applyAdvanceOriginalMinor != null && Number.isFinite(applyAdvanceOriginalMinor)
              ? applyAdvanceOriginalMinor
              : undefined,
        }),
      );
    }
    if (path[0] === "company" && path[1] === "vat-settings" && path.length === 2) {
      return NextResponse.json(
        await setCompanyVatSettings(session.userId, session.clientId, {
          establishmentEmirate:
            body.establishmentEmirate === undefined ? undefined : (body.establishmentEmirate as string | null),
          vatReturnFrequency:
            body.vatReturnFrequency === undefined
              ? undefined
              : body.vatReturnFrequency === "monthly" || body.vatReturnFrequency === "quarterly"
                ? body.vatReturnFrequency
                : null,
          vatPeriodEndMonth:
            body.vatPeriodEndMonth === undefined
              ? undefined
              : body.vatPeriodEndMonth == null
                ? null
                : Number(body.vatPeriodEndMonth),
        }),
      );
    }
    if (path[0] === "place-of-supply" && path[1] === "reapply" && path.length === 2) {
      return NextResponse.json(await reapplyPlaceOfSupplyRule(session.userId, session.clientId));
    }
    if (path[0] === "documents" && path[2] === "place-of-supply" && path.length === 3) {
      return NextResponse.json(
        await setDocumentPlaceOfSupply(session.userId, session.clientId, path[1], {
          placeOfSupply: body.placeOfSupply == null ? null : String(body.placeOfSupply),
          reason: body.reason == null ? null : String(body.reason),
        }),
      );
    }
    if (path[0] === "documents" && path[2] === "void" && path.length === 3) {
      // Actor = signed-in user; reverseBooksJournal enforces approver role + preparer ≠ approver.
      return NextResponse.json(
        await voidBooksDocument(session.userId, session.clientId, path[1], {
          reason: String(body.reason || ""),
        }),
      );
    }
    if (path[0] === "documents" && path[2] === "ack-check-vat" && path.length === 3) {
      return NextResponse.json(
        await acknowledgeBooksDocumentCheckVat(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "inbox" && path[2] === "confirm" && path.length === 3) {
      return NextResponse.json(
        await confirmInboxAsDocument(session.userId, session.clientId, path[1], {
          partyId: String(body.partyId || ""),
          periodId: String(body.periodId || ""),
          docType:
            body.docType === "purchase_bill" || body.docType === "sales_invoice"
              ? body.docType
              : undefined,
          issueDate: body.issueDate ? String(body.issueDate) : undefined,
          dueDate: body.dueDate === undefined ? undefined : body.dueDate ? String(body.dueDate) : null,
          lines: Array.isArray(body.lines) ? body.lines : undefined,
        }),
      );
    }
    if (path[0] === "settlements" && path.length === 1) {
      // Approver = session user. Preparer must differ (dual control). Synthetic stub:
      // default preparer to Omar when the signed-in user is not Omar.
      const OMAR = "55555555-5555-4555-8555-555555555555";
      const preparerId = String(
        body.preparerId || (session.userId === OMAR ? "" : OMAR) || session.userId,
      );
      return NextResponse.json(
        await createReceiptOrPayment(preparerId, session.userId, session.clientId, {
          docType: body.docType === "payment" ? "payment" : "receipt",
          partyId: String(body.partyId || ""),
          issueDate: String(body.issueDate || ""),
          periodId: String(body.periodId || ""),
          bankAccountId: String(body.bankAccountId || ""),
          currency: body.currency ? String(body.currency) : undefined,
          fxRateScaled: body.fxRateScaled != null ? Number(body.fxRateScaled) : undefined,
          originalAmountMinor: Number(body.originalAmountMinor || 0),
          memo: body.memo ? String(body.memo) : undefined,
          allocations: Array.isArray(body.allocations) ? body.allocations : [],
        }),
      );
    }
    if (path[0] === "settlements" && path[1] === "allocate-advance" && path.length === 2) {
      const OMAR = "55555555-5555-4555-8555-555555555555";
      const preparerId = String(
        body.preparerId || (session.userId === OMAR ? "" : OMAR) || session.userId,
      );
      return NextResponse.json(
        await allocatePartyAdvance(preparerId, session.userId, session.clientId, {
          partyId: String(body.partyId || ""),
          openItemId: String(body.openItemId || ""),
          periodId: String(body.periodId || ""),
          issueDate: String(body.issueDate || ""),
          amountOriginalMinor: Number(body.amountOriginalMinor || 0),
          currency: body.currency ? String(body.currency) : undefined,
        }),
      );
    }
    if (path[0] === "contra" && path.length === 1) {
      const preparerId = String(body.preparerId || session.userId);
      return NextResponse.json(
        await createContra(preparerId, session.userId, session.clientId, {
          issueDate: String(body.issueDate || ""),
          periodId: String(body.periodId || ""),
          fromAccountId: String(body.fromAccountId || ""),
          toAccountId: String(body.toAccountId || ""),
          currency: body.currency ? String(body.currency) : undefined,
          fxRateScaled: body.fxRateScaled != null ? Number(body.fxRateScaled) : undefined,
          originalAmountMinor: Number(body.originalAmountMinor || 0),
          memo: body.memo ? String(body.memo) : undefined,
        }),
      );
    }
    if (path[0] === "inbox" && path[2] === "route" && path.length === 3) {
      return NextResponse.json(await routeInboxItem(session.userId, path[1], session.clientId));
    }
    if (path[0] === "inbox" && path[2] === "retry" && path.length === 3) {
      return NextResponse.json(
        await retryBooksInboxExtract(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "inbox" && path[2] === "type" && path.length === 3) {
      return NextResponse.json(
        await setInboxDocType(session.userId, session.clientId, path[1], String(body.docType || "")),
      );
    }
    if (path[0] === "bank-transactions" && path[1] === "materialize" && path.length === 2) {
      return NextResponse.json(
        await materializeBooksBankTransactions(session.userId, session.clientId, {
          accountId: body.accountId ? String(body.accountId) : undefined,
        }),
      );
    }
    if (path[0] === "bank-rules" && path.length === 1) {
      return NextResponse.json(
        await createBooksBankRule(session.userId, session.clientId, {
          name: String(body.name || ""),
          priority: body.priority != null ? Number(body.priority) : undefined,
          active: body.active !== false,
          counterpartyContains: body.counterpartyContains
            ? String(body.counterpartyContains)
            : null,
          narrationRegex: body.narrationRegex ? String(body.narrationRegex) : null,
          amountMinMinor: body.amountMinMinor != null ? Number(body.amountMinMinor) : null,
          amountMaxMinor: body.amountMaxMinor != null ? Number(body.amountMaxMinor) : null,
          accountId: body.accountId ? String(body.accountId) : null,
          direction: body.direction === "in" || body.direction === "out" ? body.direction : null,
          setTxnType: body.setTxnType ? String(body.setTxnType) : null,
          setCategoryAccountId: body.setCategoryAccountId
            ? String(body.setCategoryAccountId)
            : null,
          setVatCode: body.setVatCode ? String(body.setVatCode) : null,
          setTags: Array.isArray(body.setTags) ? body.setTags.map(String) : [],
          setCounterparty: body.setCounterparty ? String(body.setCounterparty) : null,
        }),
      );
    }
    if (path[0] === "bank-rules" && path[1] === "from-txn" && path.length === 2) {
      return NextResponse.json(
        await createBooksBankRuleFromTxn(session.userId, session.clientId, String(body.txnId || ""), {
          name: body.name ? String(body.name) : undefined,
          priority: body.priority != null ? Number(body.priority) : undefined,
        }),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "mark-reviewed" && path.length === 3) {
      return NextResponse.json(
        await markBooksBankTransactionReviewed(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "exclude" && path.length === 3) {
      return NextResponse.json(
        await excludeBooksBankTransaction(
          session.userId,
          session.clientId,
          path[1],
          String(body.reason || body.excludeReason || ""),
        ),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "match" && path.length === 3) {
      return NextResponse.json(
        await matchBooksBankTransaction(
          session.userId,
          session.clientId,
          path[1],
          body.openItemId == null || body.openItemId === ""
            ? null
            : String(body.openItemId),
        ),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "reject-match" && path.length === 3) {
      return NextResponse.json(
        await rejectBooksBankTxnMatchSuggestion(
          session.userId,
          session.clientId,
          path[1],
          String(body.openItemId || ""),
        ),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "transfer-link" && path.length === 3) {
      return NextResponse.json(
        await linkBooksBankTransferPair(
          session.userId,
          session.clientId,
          path[1],
          String(body.counterpartId || ""),
        ),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "allocations" && path.length === 3) {
      const lines = Array.isArray(body.lines) ? body.lines : [];
      return NextResponse.json(
        await setBooksBankTxnAllocations(
          session.userId,
          session.clientId,
          path[1],
          lines.map(
            (l: Record<string, unknown>): BankTxnAllocInput => ({
              allocKind: String(l.allocKind || l.kind || "") as BankTxnAllocInput["allocKind"],
              openItemId: l.openItemId == null || l.openItemId === "" ? null : String(l.openItemId),
              accountId: l.accountId == null || l.accountId === "" ? null : String(l.accountId),
              partyId: l.partyId == null || l.partyId === "" ? null : String(l.partyId),
              amountOriginalMinor: Number(l.amountOriginalMinor),
              note: l.note == null ? "" : String(l.note),
            }),
          ),
        ),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "post" && path.length === 3) {
      return NextResponse.json(
        await postBooksBankTransaction(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "statements" && path[1] === "csv" && path.length === 2) {
      return NextResponse.json(
        await ingestCsvToStatement(session.userId, session.clientId, {
          csvText: String(body.csvText || ""),
          issuerKey: body.issuerKey ? String(body.issuerKey) : "stripe",
          openingBalanceMinor:
            body.openingBalanceMinor != null ? Number(body.openingBalanceMinor) : undefined,
          closingBalanceMinor:
            body.closingBalanceMinor != null ? Number(body.closingBalanceMinor) : undefined,
        }),
      );
    }
    if (path[0] === "csv-profiles" && path.length === 1) {
      return NextResponse.json(
        await saveCsvProfile(session.userId, session.clientId, {
          issuerKey: String(body.issuerKey || ""),
          docType: String(body.docType || "gateway_statement"),
          fileType: body.fileType ? String(body.fileType) : "csv",
          headerFingerprint: body.headerFingerprint ? String(body.headerFingerprint) : "",
          columnMap: typeof body.columnMap === "object" && body.columnMap ? body.columnMap : {},
          dateFormat: body.dateFormat ? String(body.dateFormat) : undefined,
        }),
      );
    }
    if (path[0] === "opening-imports" && path.length === 1) {
      let lines = Array.isArray(body.lines) ? body.lines : [];
      if (body.csvText) lines = parseOpeningTbCsv(String(body.csvText));
      return NextResponse.json(
        await createOpeningImport(session.userId, session.clientId, {
          lines,
          partyOpenItems: Array.isArray(body.partyOpenItems) ? body.partyOpenItems : [],
          forceBooksStartPeriodId: body.forceBooksStartPeriodId
            ? String(body.forceBooksStartPeriodId)
            : undefined,
        }),
      );
    }
    if (path[0] === "opening-imports" && path[2] === "post" && path.length === 3) {
      return NextResponse.json(await postOpeningImport(session.userId, session.clientId, path[1]));
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const session = await context();
    const path = (await ctx.params).path || [];
    const body = await request.json().catch(() => ({}));

    if (path[0] === "tags" && path.length === 2) {
      return NextResponse.json(
        await updateBooksTag(session.userId, session.clientId, path[1], {
          name: body.name != null ? String(body.name) : undefined,
          colour: body.colour != null ? String(body.colour) : undefined,
        }),
      );
    }
    if (path[0] === "accounts" && path.length === 2) {
      return NextResponse.json(
        await updateBooksAccount(session.userId, session.clientId, path[1], {
          name: body.name != null ? String(body.name) : undefined,
          statementLine:
            body.statementLine === undefined
              ? undefined
              : body.statementLine == null
                ? null
                : String(body.statementLine),
          defaultVatCode:
            body.defaultVatCode === undefined
              ? undefined
              : body.defaultVatCode == null
                ? null
                : String(body.defaultVatCode),
          normalBalance: body.normalBalance != null ? String(body.normalBalance) : undefined,
        }),
      );
    }
    if (path[0] === "saved-views" && path.length === 2) {
      return NextResponse.json(
        await updateBooksSavedView(session.userId, session.clientId, path[1], {
          name: body.name != null ? String(body.name) : undefined,
          scope: body.scope === "shared" ? "shared" : body.scope === "personal" ? "personal" : undefined,
          config: typeof body.config === "object" && body.config ? body.config : undefined,
        }),
      );
    }
    if (path[0] === "journals" && path.length === 2) {
      return NextResponse.json(
        await replaceBooksJournalDraft(session.userId, session.clientId, path[1], {
          periodId: body.periodId ? String(body.periodId) : undefined,
          entryDate: String(body.entryDate || ""),
          memo: body.memo != null ? String(body.memo) : undefined,
          note: body.note != null ? String(body.note) : undefined,
          reference: body.reference != null ? String(body.reference) : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
          voucherType: body.voucherType ? String(body.voucherType) : undefined,
          scheduledFor:
            body.scheduledFor === undefined
              ? undefined
              : body.scheduledFor == null
                ? null
                : String(body.scheduledFor),
          lines: Array.isArray(body.lines) ? body.lines : [],
        }),
      );
    }
    if (path[0] === "parties" && path.length === 2) {
      return NextResponse.json(await updateBooksParty(session.userId, session.clientId, path[1], body));
    }
    if (path[0] === "documents" && path.length === 2) {
      return NextResponse.json(
        await updateBooksDocumentPrintedFields(session.userId, session.clientId, path[1], {
          printedNetMinor:
            body.printedNetMinor === undefined
              ? undefined
              : body.printedNetMinor == null
                ? null
                : Number(body.printedNetMinor),
          printedVatMinor:
            body.printedVatMinor === undefined
              ? undefined
              : body.printedVatMinor == null
                ? null
                : Number(body.printedVatMinor),
          printedGrossMinor:
            body.printedGrossMinor === undefined
              ? undefined
              : body.printedGrossMinor == null
                ? null
                : Number(body.printedGrossMinor),
          printedPaidMinor:
            body.printedPaidMinor === undefined
              ? undefined
              : body.printedPaidMinor == null
                ? null
                : Number(body.printedPaidMinor),
          printedBalanceDueMinor:
            body.printedBalanceDueMinor === undefined
              ? undefined
              : body.printedBalanceDueMinor == null
                ? null
                : Number(body.printedBalanceDueMinor),
        }),
      );
    }
    if (path[0] === "statements" && path.length === 2) {
      return NextResponse.json(
        await updateStatementLines(session.userId, session.clientId, path[1], {
          openingBalanceMinor:
            body.openingBalanceMinor != null ? Number(body.openingBalanceMinor) : undefined,
          closingBalanceMinor:
            body.closingBalanceMinor != null ? Number(body.closingBalanceMinor) : undefined,
          lines: Array.isArray(body.lines) ? body.lines : [],
        }),
      );
    }
    if (path[0] === "bank-accounts" && path.length === 2) {
      return NextResponse.json(
        await updateBooksBankAccountSetup(session.userId, session.clientId, path[1], {
          bankName: body.bankName === undefined ? undefined : body.bankName ? String(body.bankName) : null,
          iban: body.iban === undefined ? undefined : body.iban ? String(body.iban) : null,
          ibanLast4:
            body.ibanLast4 === undefined
              ? undefined
              : body.ibanLast4
                ? String(body.ibanLast4)
                : null,
        }),
      );
    }
    if (path[0] === "bank-transactions" && path.length === 2) {
      return NextResponse.json(
        await updateBooksBankTransaction(session.userId, session.clientId, path[1], {
          txnType: body.txnType === undefined ? undefined : body.txnType ? String(body.txnType) : null,
          categoryAccountId:
            body.categoryAccountId === undefined
              ? undefined
              : body.categoryAccountId
                ? String(body.categoryAccountId)
                : null,
          note: body.note === undefined ? undefined : String(body.note),
          payoutGroupKey:
            body.payoutGroupKey === undefined
              ? undefined
              : body.payoutGroupKey
                ? String(body.payoutGroupKey)
                : null,
        }),
      );
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const session = await context();
    const path = (await ctx.params).path || [];

    if (path[0] === "tags" && path.length === 2) {
      return NextResponse.json(await deleteBooksTag(session.userId, session.clientId, path[1]));
    }
    if (path[0] === "saved-views" && path.length === 2) {
      return NextResponse.json(await deleteBooksSavedView(session.userId, session.clientId, path[1]));
    }
    if (path[0] === "journals" && path.length === 2) {
      return NextResponse.json(
        await softDeleteBooksJournalDraft(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "documents" && path.length === 2) {
      return NextResponse.json(
        await softDeleteBooksDocumentDraft(session.userId, session.clientId, path[1]),
      );
    }
    if (path[0] === "bank-transactions" && path[2] === "transfer-link" && path.length === 3) {
      return NextResponse.json(
        await unlinkBooksBankTransferPair(session.userId, session.clientId, path[1]),
      );
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return fail(error);
  }
}
