/**
 * QA regressions — manual Receipts & payments:
 *  1. dual control: preparer is the signed-in user, posting needs a different approver/admin
 *  2. a double post creates one receipt
 *  3. a refused post leaves no journal behind (GL 2320 can't drift from the advances subledger)
 *  4. a supplier payment against a part-paid bill works
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import { approveAndPostBooksDocument, createBooksDocument } from "@/server/books/documents";
import { assertOpenItemsMatchRebuild, listBooksOpenItems } from "@/server/books/open-items";
import { createBooksParty } from "@/server/books/parties";
import * as settlements from "@/server/books/settlements";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555"; // accountant
const LAYLA = "44444444-4444-4444-8444-444444444444"; // approver
const RAJ = "77777777-7777-4777-8777-777777777777"; // admin

type Fn = (...args: never[]) => Promise<unknown>;
function api<T extends Fn = Fn>(name: string): T {
  const fn = (settlements as unknown as Record<string, unknown>)[name];
  assert.equal(typeof fn, "function", `settlements.${name} is missing`);
  return fn as T;
}
const createSettlementDraft = (...a: unknown[]) => api("createSettlementDraft")(...(a as never[])) as Promise<{
  documentId: string;
  status: string;
  duplicate: boolean;
}>;
const postSettlementDraft = (...a: unknown[]) => api("postSettlementDraft")(...(a as never[])) as Promise<{
  documentId: string;
  journalEntryId: string;
  entryNo: string;
}>;
const listSettlementDrafts = (...a: unknown[]) =>
  api("listSettlementDrafts")(...(a as never[])) as Promise<Array<{ id: string; canPost: boolean }>>;

async function withAdmin(t: test.TestContext) {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const adminUrl = process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return null;
  }
  const ready = await admin.query(`SELECT to_regclass('books_documents') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("phase1 schema not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

async function setup(admin: pg.Client, label: string) {
  const company = await createTestCompany(admin, label);
  // Raj (admin) as a second approver for this company.
  await admin.query(
    `INSERT INTO user_client_access (user_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [RAJ, company.clientId],
  );
  return company;
}

function acct(company: TestCompany, code: string) {
  const id = company.accountIdByCode[code];
  assert.ok(id, `missing account ${code}`);
  return id;
}

async function party(clientId: string, partyType: "customer" | "supplier", tag: string) {
  const created = await createBooksParty(OMAR, clientId, {
    partyType,
    name: `Rcpt ${partyType} ${tag} ${Date.now()}`,
    trn: partyType === "supplier" ? `100${Date.now().toString().slice(-10)}003` : undefined,
    force: true,
  });
  return String(created.id);
}

/** Posted sales invoice / purchase bill of 1,050.00 (1,000 + 5% VAT); returns its open item id. */
async function postedItem(
  company: TestCompany,
  partyId: string,
  docType: "sales_invoice" | "purchase_bill",
) {
  const doc = await createBooksDocument(OMAR, company.clientId, {
    docType,
    partyId,
    issueDate: "2026-05-05",
    periodId: company.periods["May 2026"],
    documentNumber: `RH-${docType}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    lines: [
      {
        description: docType === "sales_invoice" ? "Service" : "Supplies",
        lineKind: docType === "sales_invoice" ? "revenue" : "expense",
        vatCode: "SR",
        netMinor: 100000,
        vatMinor: 5000,
      },
    ],
  });
  await approveAndPostBooksDocument(LAYLA, company.clientId, String(doc.id));
  const items = await listBooksOpenItems(OMAR, company.clientId, { partyId });
  const item = items.find((x: { documentId: string }) => x.documentId === doc.id);
  assert.ok(item, "open item created");
  return String(item!.id);
}

async function journalCounts(admin: pg.Client, clientId: string) {
  const r = await admin.query(
    `SELECT COUNT(*)::int AS all_n,
            COUNT(*) FILTER (WHERE deleted_at IS NULL AND status IN ('draft','scheduled'))::int AS live_drafts
     FROM books_journal_entries WHERE client_id = $1`,
    [clientId],
  );
  return { all: Number(r.rows[0].all_n), liveDrafts: Number(r.rows[0].live_drafts) };
}

async function rejects(p: Promise<unknown>, code: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.match(String((e as Error).message), code);
    return true;
  });
}

test("refused post creates nothing: preparer = approver, and accountant as approver", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await setup(admin, "rh-refuse");
    const { clientId } = company;
    const customerId = await party(clientId, "customer", "refuse");
    const before = await journalCounts(admin, clientId);
    const input = {
      docType: "receipt" as const,
      partyId: customerId,
      issueDate: "2026-05-20",
      periodId: company.periods["May 2026"],
      bankAccountId: acct(company, "1120"),
      originalAmountMinor: 10500,
      allocations: [],
    };
    // QA: Omar clicking Post was refused (post_requires_approver) but a Dr 1120 / Cr 2320 draft
    // journal had already been created and could be posted from Journals.
    await rejects(settlements.createReceiptOrPayment(OMAR, OMAR, clientId, input), /post_requires_approver/);
    assert.equal(
      (await journalCounts(admin, clientId)).all,
      before.all,
      "refused post left a (postable) draft journal behind",
    );
    await rejects(
      settlements.createReceiptOrPayment(LAYLA, LAYLA, clientId, input),
      /post_preparer_cannot_approve/,
    );
    await rejects(
      settlements.allocatePartyAdvance(LAYLA, LAYLA, clientId, {
        partyId: customerId,
        openItemId: "00000000-0000-4000-8000-000000000000",
        periodId: company.periods["May 2026"],
        issueDate: "2026-05-20",
        amountOriginalMinor: 100,
      }),
      /post_preparer_cannot_approve/,
    );
    const after = await journalCounts(admin, clientId);
    assert.equal(after.all, before.all, "no journal (draft or otherwise) left behind");
    const adv = await admin.query(
      `SELECT 1 FROM books_party_advances WHERE client_id = $1 AND party_id = $2`,
      [clientId, customerId],
    );
    assert.equal(adv.rowCount, 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("draft flow: preparer is the signer (body preparerId ignored), a different approver posts", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await setup(admin, "rh-dual");
    const { clientId } = company;
    const customerId = await party(clientId, "customer", "dual");
    const openItemId = await postedItem(company, customerId, "sales_invoice");
    const before = await journalCounts(admin, clientId);

    const input = {
      docType: "receipt",
      partyId: customerId,
      issueDate: "2026-05-20",
      periodId: company.periods["May 2026"],
      bankAccountId: acct(company, "1120"),
      originalAmountMinor: 105000,
      allocations: [{ openItemId, allocatedOriginalMinor: 105000 }],
    };
    // An approver is not a preparer role (journals: admin/accountant), so Layla can't record one
    // and then name someone else as its preparer.
    await rejects(createSettlementDraft(LAYLA, clientId, { ...input, preparerId: RAJ }), /settlement_prepare_forbidden/);

    // Raj records it; a forged preparerId in the body must not change who prepared it.
    const draft = await createSettlementDraft(RAJ, clientId, { ...input, preparerId: OMAR });
    assert.equal(draft.status, "draft");
    const doc = await admin.query(
      `SELECT status, created_by, journal_entry_id FROM books_documents WHERE id = $1`,
      [draft.documentId],
    );
    assert.equal(doc.rows[0].status, "draft");
    assert.equal(String(doc.rows[0].created_by), RAJ);
    assert.equal(doc.rows[0].journal_entry_id, null);
    assert.equal((await journalCounts(admin, clientId)).all, before.all, "a draft writes no journal");

    const forRaj = await listSettlementDrafts(RAJ, clientId);
    assert.equal(forRaj.find((d) => d.id === draft.documentId)?.canPost, false);
    const forLayla = await listSettlementDrafts(LAYLA, clientId);
    assert.equal(forLayla.find((d) => d.id === draft.documentId)?.canPost, true);
    const forOmar = await listSettlementDrafts(OMAR, clientId);
    assert.equal(forOmar.find((d) => d.id === draft.documentId)?.canPost, false);

    // Preparer can't post their own; an accountant can't post at all — and neither leaves a journal.
    await rejects(postSettlementDraft(RAJ, clientId, draft.documentId), /post_preparer_cannot_approve/);
    await rejects(postSettlementDraft(OMAR, clientId, draft.documentId), /post_requires_approver/);
    // The generic document approve must not post a settlement draft either.
    await assert.rejects(approveAndPostBooksDocument(LAYLA, clientId, draft.documentId));
    assert.equal((await journalCounts(admin, clientId)).all, before.all);
    const still = await admin.query(`SELECT status FROM books_documents WHERE id = $1`, [draft.documentId]);
    assert.equal(still.rows[0].status, "draft");

    const posted = await postSettlementDraft(LAYLA, clientId, draft.documentId);
    assert.equal(posted.documentId, draft.documentId);
    assert.match(String(posted.entryNo), /^RV-2026-\d+$/);
    const row = await admin.query(
      `SELECT d.status, d.created_by, d.approved_by, d.journal_entry_id, e.created_by AS je_created_by,
              e.status AS je_status
       FROM books_documents d JOIN books_journal_entries e ON e.id = d.journal_entry_id
       WHERE d.id = $1`,
      [draft.documentId],
    );
    assert.equal(row.rows[0].status, "posted");
    assert.equal(String(row.rows[0].created_by), RAJ, "audit names the real preparer");
    assert.equal(String(row.rows[0].approved_by), LAYLA);
    assert.equal(String(row.rows[0].je_created_by), RAJ);
    assert.equal(row.rows[0].je_status, "posted");
    const oi = await admin.query(`SELECT open_original_minor, status FROM books_open_items WHERE id = $1`, [
      openItemId,
    ]);
    assert.equal(Number(oi.rows[0].open_original_minor), 0);
    assert.equal(oi.rows[0].status, "closed");
    await assertOpenItemsMatchRebuild(OMAR, clientId);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("double submit / double post creates one receipt", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await setup(admin, "rh-double");
    const { clientId } = company;
    const customerId = await party(clientId, "customer", "double");
    const openItemId = await postedItem(company, customerId, "sales_invoice");
    const requestId = "0f8e5a8c-1d2b-4c3d-9e4f-5a6b7c8d9e0f";
    const input = {
      docType: "receipt",
      partyId: customerId,
      issueDate: "2026-05-21",
      periodId: company.periods["May 2026"],
      bankAccountId: acct(company, "1120"),
      originalAmountMinor: 50000,
      allocations: [{ openItemId, allocatedOriginalMinor: 40000 }],
      remainderKind: "advance",
      remainderOriginalMinor: 10000,
    };
    const first = await createSettlementDraft(OMAR, clientId, input, { requestId });
    const second = await createSettlementDraft(OMAR, clientId, input, { requestId });
    assert.equal(second.documentId, first.documentId);
    assert.equal(second.duplicate, true);

    const results = await Promise.allSettled([
      postSettlementDraft(LAYLA, clientId, first.documentId),
      postSettlementDraft(LAYLA, clientId, first.documentId),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1, "exactly one post succeeds");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0].reason?.message), /not_draft/);
    // A later retry is refused cleanly too.
    await rejects(postSettlementDraft(LAYLA, clientId, first.documentId), /not_draft/);

    const docs = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_documents
       WHERE client_id = $1 AND doc_type = 'receipt' AND deleted_at IS NULL`,
      [clientId],
    );
    assert.equal(docs.rows[0].n, 1, "one receipt document");
    const allocs = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_allocations WHERE client_id = $1`,
      [clientId],
    );
    assert.equal(allocs.rows[0].n, 1);
    const receipts = await admin.query(
      `SELECT COUNT(*)::int AS n FROM books_journal_entries
       WHERE client_id = $1 AND voucher_type = 'Receipt' AND status = 'posted'`,
      [clientId],
    );
    assert.equal(receipts.rows[0].n, 1, "one posted receipt journal");
    assert.equal((await journalCounts(admin, clientId)).liveDrafts, 0, "no postable orphan draft");
    const oi = await admin.query(`SELECT open_original_minor, status FROM books_open_items WHERE id = $1`, [
      openItemId,
    ]);
    assert.equal(Number(oi.rows[0].open_original_minor), 65000);
    assert.equal(oi.rows[0].status, "partial");
    // GL 2320 agrees with the party-advances subledger.
    const gl = await admin.query(
      `SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0)::bigint AS bal
       FROM books_journal_lines l
       JOIN books_journal_entries e ON e.id = l.entry_id
       JOIN books_accounts a ON a.id = l.account_id
       WHERE e.client_id = $1 AND e.status = 'posted' AND a.code = '2320'`,
      [clientId],
    );
    const sub = await admin.query(
      `SELECT COALESCE(SUM(balance_aed_minor), 0)::bigint AS bal FROM books_party_advances WHERE client_id = $1`,
      [clientId],
    );
    assert.equal(Number(gl.rows[0].bal), 10000);
    assert.equal(Number(sub.rows[0].bal), 10000);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("post that fails validation at post time leaves no journal and keeps the draft", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await setup(admin, "rh-stale");
    const { clientId } = company;
    const customerId = await party(clientId, "customer", "stale");
    const openItemId = await postedItem(company, customerId, "sales_invoice");
    const base = {
      docType: "receipt",
      partyId: customerId,
      issueDate: "2026-05-22",
      periodId: company.periods["May 2026"],
      bankAccountId: acct(company, "1120"),
      originalAmountMinor: 105000,
      allocations: [{ openItemId, allocatedOriginalMinor: 105000 }],
    };
    const a = await createSettlementDraft(OMAR, clientId, base);
    const b = await createSettlementDraft(OMAR, clientId, base);
    await postSettlementDraft(LAYLA, clientId, a.documentId);
    const before = await journalCounts(admin, clientId);
    await rejects(postSettlementDraft(LAYLA, clientId, b.documentId), /allocation_exceeds_open/);
    const after = await journalCounts(admin, clientId);
    assert.equal(after.liveDrafts, 0);
    assert.equal(after.all - before.all, 0, "no journal created for the refused post");
    const row = await admin.query(`SELECT status FROM books_documents WHERE id = $1`, [b.documentId]);
    assert.equal(row.rows[0].status, "draft");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("supplier payment against a part-paid bill, remainder as supplier advance", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await setup(admin, "rh-supplier");
    const { clientId } = company;
    const supplierId = await party(clientId, "supplier", "pay");
    const billItem = await postedItem(company, supplierId, "purchase_bill");
    const common = {
      docType: "payment",
      partyId: supplierId,
      issueDate: "2026-05-23",
      periodId: company.periods["May 2026"],
      bankAccountId: acct(company, "1120"),
    };
    const p1 = await createSettlementDraft(OMAR, clientId, {
      ...common,
      originalAmountMinor: 30000,
      allocations: [{ openItemId: billItem, allocatedOriginalMinor: 30000 }],
    });
    await postSettlementDraft(LAYLA, clientId, p1.documentId);
    const partial = await listBooksOpenItems(OMAR, clientId, { partyId: supplierId, status: "partial" });
    assert.equal(partial.length, 1, "bill is part-paid");
    assert.equal(Number(partial[0].openOriginalMinor), 75000);

    // Pay the rest of the part-paid bill plus 100.00 extra kept as a supplier advance.
    const p2 = await createSettlementDraft(OMAR, clientId, {
      ...common,
      originalAmountMinor: 85000,
      allocations: [{ openItemId: billItem, allocatedOriginalMinor: 75000 }],
      remainderKind: "advance",
      remainderOriginalMinor: 10000,
    });
    const posted = await postSettlementDraft(RAJ, clientId, p2.documentId);
    assert.match(String(posted.entryNo), /^PY-2026-\d+$/);
    const lines = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor FROM books_journal_lines l
       JOIN books_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY a.code`,
      [posted.journalEntryId],
    );
    const by = Object.fromEntries(
      lines.rows.map((r) => [String(r.code), Number(r.debit_minor) - Number(r.credit_minor)]),
    );
    assert.equal(by["1120"], -85000);
    assert.equal(by["2110"], 75000);
    assert.equal(by["1410"], 10000);
    const oi = await admin.query(`SELECT status, open_original_minor FROM books_open_items WHERE id = $1`, [
      billItem,
    ]);
    assert.equal(oi.rows[0].status, "closed");
    await assertOpenItemsMatchRebuild(OMAR, clientId);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("settlement routes never take the preparer from the request body", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/app/api/books/[...path]/route.ts"),
    "utf8",
  );
  const blocks = src
    .split(/\n\s*if \(/)
    .filter((b) => /^path\[0\] === "settlements"/.test(b.trim()));
  assert.ok(blocks.length >= 2, "settlement handlers found");
  for (const b of blocks) {
    assert.doesNotMatch(b, /body\.preparerId/, "body.preparerId must be ignored");
    assert.doesNotMatch(b, /55555555-5555-4555-8555-555555555555/, "no hard-coded preparer");
  }
});
