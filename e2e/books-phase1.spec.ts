import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const DESERT = "e1000001-0000-4000-8000-000000000001";
const SUPPLIER = "e9000001-0000-4000-8000-000000000002";
const STMT_BALANCED = "e7000001-0000-4000-8000-000000000098";
const STMT_DROPPED = "e7000001-0000-4000-8000-000000000088";
const PHASE1_DIR = path.join(process.cwd(), "docs", "phase1");
const FIXTURE_PDF = path.join(process.cwd(), "fixtures", "extraction", "pdfs", "invoice_02.pdf");

/**
 * e2e profile does not run the Python worker. After upload (status=queued), insert a
 * worker-shaped books_extractions row so review UI can assert fields without waiting.
 */
async function insertWorkerShapedExtraction(args: {
  inboxItemId: string;
  fileId: string;
  clientId: string;
}) {
  const admin = new pg.Client({
    connectionString:
      process.env.DATABASE_URL_SUPER ||
      "postgresql://daftar:daftar-local-only@127.0.0.1:5432/daftar_e2e",
  });
  await admin.connect();
  try {
    const extractionId = randomUUID();
    const fields = {
      invoice_no: {
        value: "INV-SYN-002",
        confidence: 0.95,
        status: "ok",
        source: { page: 1, bbox: [72, 120, 180, 134] },
      },
      document_number: {
        value: "INV-SYN-002",
        confidence: 0.95,
        status: "ok",
        source: { page: 1, bbox: [72, 120, 180, 134] },
      },
      invoice_date: {
        value: "2026-05-15",
        confidence: 0.95,
        status: "ok",
        source: { page: 1, bbox: [72, 140, 160, 154] },
      },
      currency: {
        value: "AED",
        confidence: 0.99,
        status: "ok",
        source: null,
      },
      net: {
        value: 10000,
        confidence: 0.95,
        status: "ok",
        source: { page: 1, bbox: [400, 200, 460, 214] },
      },
      vat: {
        value: 500,
        confidence: 0.95,
        status: "ok",
        source: { page: 1, bbox: [400, 220, 460, 234] },
      },
      gross: {
        value: 10500,
        confidence: 0.95,
        status: "ok",
        source: { page: 1, bbox: [400, 240, 460, 254] },
      },
      // UI FIELD_ORDER still keys on sync names until E5; mirror as display strings.
      subtotal: {
        value: "100.00",
        confidence: 0.95,
        status: "ok",
        source: null,
      },
      vat_total: {
        value: "5.00",
        confidence: 0.95,
        status: "ok",
        source: null,
      },
      grand_total: {
        value: "105.00",
        confidence: 0.95,
        status: "ok",
        source: { page: 1, bbox: [400, 240, 460, 254] },
      },
    };
    await admin.query(`DELETE FROM books_extractions WHERE inbox_item_id = $1`, [
      args.inboxItemId,
    ]);
    await admin.query(
      `INSERT INTO books_extractions (
         id, client_id, file_id, inbox_item_id, doc_type, status,
         fields_json, raw_text, word_boxes, validation_flags, extractor_version
       ) VALUES ($1,$2,$3,$4,'sales_invoice','needs_review',$5::jsonb,$6,'[]'::jsonb,'[]'::jsonb,'phase1-v1')`,
      [
        extractionId,
        args.clientId,
        args.fileId,
        args.inboxItemId,
        JSON.stringify(fields),
        "TAX INVOICE\nInvoice No: INV-SYN-002\nTotal 105.00\n",
      ],
    );
    await admin.query(
      `UPDATE books_inbox_items
       SET status = 'needs_review', detected_type = 'sales_invoice',
           classification_confidence = 0.9, error = NULL, updated_at = now()
       WHERE id = $1`,
      [args.inboxItemId],
    );
  } finally {
    await admin.end();
  }
}

async function savePhase1(name: string, buffer: Buffer) {
  // Committed docs screenshots are only refreshed on purpose (UPDATE_SCREENSHOTS=1).
  // Normal runs write to the gitignored test-results folder so the working tree stays clean.
  const dir =
    process.env.UPDATE_SCREENSHOTS === "1"
      ? PHASE1_DIR
      : path.join(process.cwd(), "test-results", "phase1-screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name);
  fs.writeFileSync(out, buffer);
  console.log(`saved ${out} (${buffer.length} bytes)`);
}

function cookieDomain() {
  const base = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:43123";
  try {
    return new URL(base).hostname;
  } catch {
    return "127.0.0.1";
  }
}

async function setSession(
  context: import("@playwright/test").BrowserContext,
  userId: string,
) {
  const domain = cookieDomain();
  await context.clearCookies();
  await context.addCookies([
    { name: "daftar_user", value: userId, domain, path: "/" },
    { name: "daftar_client", value: DESERT, domain, path: "/" },
  ]);
}

/** Unique PDF bytes (comment after EOF) so sha256 does not collide across runs. */
function uniqueFixturePdf(): { bytes: Buffer; sha256: string } {
  const base = fs.readFileSync(FIXTURE_PDF);
  const bytes = Buffer.concat([base, Buffer.from(`\n% e2e-${Date.now()}-${Math.random()}\n`)]);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

test.beforeEach(async ({ context }) => {
  await setSession(context, OMAR);
});

test("phase1: sales purchases parties inbox visible", async ({ page }) => {
  await page.goto("/books/parties");
  await expect(page.getByRole("heading", { name: "Parties" })).toBeVisible();
  await expect(page.getByText("Oasis Retail LLC")).toBeVisible({ timeout: 15000 });

  await page.goto("/books/sales");
  await expect(page.getByRole("heading", { name: "Sales invoices" })).toBeVisible();
  await expect(page.getByText("Upload Invoices")).toBeVisible();
  await expect(page.getByRole("button", { name: /Record manually/i })).toBeVisible();

  await page.goto("/books/purchases");
  await expect(page.getByRole("heading", { name: "Purchase bills" })).toBeVisible();
  await expect(page.getByTestId("purchase-upload")).toBeVisible();
  await expect(page.getByText("(fils)")).toHaveCount(0);
  await expect(page.getByTestId("purchase-uploads-tab")).toBeVisible();
  await expect(page.getByTestId("purchase-issue-date")).toBeVisible();

  await page.goto("/books/expenses");
  await expect(page.getByText(/Coming in Phase 3/i)).toBeVisible();

  await page.goto("/books/inbox");
  await expect(page.getByRole("heading", { name: /Inbox/ })).toBeVisible();
});

test("phase1 screenshots: review from NEW upload, statement, purchases, settings", async ({
  page,
}) => {
  const { bytes, sha256 } = uniqueFixturePdf();
  const upload = await page.request.post("/api/books/inbox/upload", {
    multipart: {
      files: {
        name: "invoice_02.pdf",
        mimeType: "application/pdf",
        buffer: bytes,
      },
    },
  });
  const uploaded = await upload.json();
  expect(upload.ok(), `upload failed: ${JSON.stringify(uploaded)}`).toBeTruthy();
  const inboxId = uploaded.results?.[0]?.inboxItemId as string;
  expect(inboxId, `upload body: ${JSON.stringify(uploaded)}`).toBeTruthy();
  expect(uploaded.results[0].sha256).toBe(sha256);
  expect(uploaded.results[0].status, `upload status: ${JSON.stringify(uploaded)}`).toBe(
    "queued",
  );

  // e2e has no worker process — seed worker-shaped extraction (see insertWorkerShapedExtraction).
  await insertWorkerShapedExtraction({
    inboxItemId: inboxId,
    fileId: uploaded.results[0].fileId as string,
    clientId: DESERT,
  });

  const apiReview = await page.request.get(`/api/books/inbox/${inboxId}`);
  const reviewBody = await apiReview.json();
  expect(apiReview.ok(), `review API: ${JSON.stringify(reviewBody)}`).toBeTruthy();
  expect(reviewBody.extractionId, `review: ${JSON.stringify(reviewBody)}`).toBeTruthy();
  expect(reviewBody.status).toBe("needs_review");
  expect(reviewBody.fieldsJson?.invoice_no?.value).toBe("INV-SYN-002");
  expect(reviewBody.sha256).toBe(sha256);

  const unknown = await page.request.get(`/api/books/inbox/${crypto.randomUUID()}`);
  expect(unknown.status()).toBe(404);

  // File URL body hash proves preview serves the uploaded object (not a demo raster).
  const fileRes = await page.request.get(reviewBody.fileUrl);
  expect(fileRes.ok()).toBeTruthy();
  const fileBuf = Buffer.from(await fileRes.body());
  expect(createHash("sha256").update(fileBuf).digest("hex")).toBe(sha256);

  await page.goto(`/books/inbox/${inboxId}`);
  await expect(page.getByTestId("review-split-view")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("field-invoice_no")).toHaveValue("INV-SYN-002");
  await expect(page.getByTestId("review-file-meta")).toContainText("invoice_02.pdf");
  const preview = page.getByTestId("review-file-pdf").or(page.getByTestId("review-file-image"));
  await expect(preview).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("validation-flags")).toContainText(/balanced/i);
  await savePhase1("review-split-view.png", await page.screenshot({ fullPage: true }));
  await savePhase1("review-uploaded-invoice-02.png", await page.screenshot({ fullPage: true }));

  const list = await page.request.get("/api/books/statements");
  const rows = (await list.json()) as Array<{ id: string }>;
  expect(Array.isArray(rows), `statements API: ${JSON.stringify(rows)}`).toBeTruthy();
  expect(rows.some((r) => r.id === STMT_BALANCED), "balanced statement seed missing").toBeTruthy();
  expect(rows.some((r) => r.id === STMT_DROPPED), "dropped-row statement seed missing").toBeTruthy();

  await page.goto(`/books/statements/${STMT_BALANCED}`);
  await expect(page.getByTestId("statement-review")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("statement-account")).not.toHaveValue("—");
  await expect(page.getByTestId("statement-iban")).toHaveValue(/AE07/);
  await expect(page.locator('input[value="CLIENT RECEIPT"]')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("statement-balance-status")).toContainText("OK");
  await expect(page.getByTestId("rb-check-0")).toContainText("✓");
  await savePhase1("statement-review.png", await page.screenshot({ fullPage: true }));

  await page.goto(`/books/statements/${STMT_DROPPED}`);
  await expect(page.locator('input[value*="CARD PAYMENT"]')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("rb-check-1")).toContainText("✗");
  await savePhase1("statement-review-dropped.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/purchases");
  await expect(page.getByRole("heading", { name: "Purchase bills" })).toBeVisible();
  await expect(page.getByTestId("purchase-issue-date")).toBeVisible();
  await expect(page.getByTestId("purchase-issue-date")).toHaveValue("16/05/2026");
  await page.getByTestId("purchase-uploads-tab").click();
  await expect(page.getByTestId("purchase-uploads-table")).toBeVisible();
  await savePhase1("purchases.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/receipts");
  await expect(page.getByRole("heading", { name: /Receipt/i })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Post receipt" })).toBeVisible();
  await expect(page.getByText(/as Layla/i)).toHaveCount(0);
  await savePhase1("receipts.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/settings");
  await expect(page.getByTestId("company-profile")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("company-name")).not.toHaveValue("", { timeout: 15000 });
  await expect(page.getByTestId("fiscal-year-start-month")).toBeVisible();
  await expect(page.getByTestId("periods-table")).toContainText("May 2026");
  await expect(page.getByTestId("opening-balances")).toBeVisible();
  await expect(page.getByTestId("about")).toBeVisible();
  await page.getByTestId("opening-balances").scrollIntoViewIfNeeded();
  await savePhase1("settings-ob.png", await page.screenshot({ fullPage: true }));
  await page.getByTestId("company-profile").scrollIntoViewIfNeeded();
  await savePhase1("settings-profile-periods.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/expenses");
  await expect(page.getByText(/Coming in Phase 3/i)).toBeVisible();
  await savePhase1("expenses-phase3.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/sales");
  await expect(page.getByRole("heading", { name: "Sales invoices" })).toBeVisible();
  await savePhase1("sales.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/inbox");
  await expect(page.getByRole("heading", { name: /Inbox/ })).toBeVisible();
  await savePhase1("inbox.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/parties");
  await expect(page.getByRole("heading", { name: "Parties" })).toBeVisible();
  await savePhase1("parties.png", await page.screenshot({ fullPage: true }));
});

test("phase1: upload bill → approve → journal visible", async ({ page, context }) => {
  const periods = await page.request.get("/api/books/periods");
  const periodRows = (await periods.json()) as Array<{ id: string; label: string }>;
  const may = periodRows.find((p) => /May 2026/i.test(p.label));
  expect(may?.id, "May 2026 period required").toBeTruthy();

  const docNo = `E2E-PV-${Date.now()}`;
  const create = await page.request.post("/api/books/documents", {
    data: {
      docType: "purchase_bill",
      partyId: SUPPLIER,
      issueDate: "2026-05-12",
      periodId: may!.id,
      documentNumber: docNo,
      lines: [
        {
          description: "E2E office supplies",
          lineKind: "expense",
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
        },
      ],
    },
  });
  const created = await create.json();
  expect(create.ok(), `create failed: ${JSON.stringify(created)}`).toBeTruthy();
  expect(created.id).toBeTruthy();

  // C1-1: review screen shows journal preview + totals panels before approve
  await page.goto("/books/purchases");
  await expect(page.getByTestId("ap-kpi-row")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Review" }).first().click();
  await expect(page.getByTestId("document-review-panels")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("totals-panel")).toBeVisible();
  await expect(page.getByTestId("journal-preview-panel")).toBeVisible();
  await expect(page.getByTestId("journal-preview-balance")).toContainText(/Balanced/i);

  await setSession(context, LAYLA);
  const approve = await page.request.post(`/api/books/documents/${created.id}/approve`, {
    data: {},
  });
  const posted = await approve.json();
  expect(approve.ok(), `approve failed: ${JSON.stringify(posted)}`).toBeTruthy();
  expect(posted.entryNo || posted.journalEntryId).toBeTruthy();
  const entryHint = String(posted.entryNo || "");
  expect(entryHint, "posted entryNo required").toMatch(/^PV-/);

  const journals = await page.request.get(
    `/api/books/journals?periodId=${encodeURIComponent(may!.id)}`,
  );
  const journalRows = (await journals.json()) as Array<{ entryNo?: string; description?: string }>;
  expect(journals.ok(), `journals API: ${JSON.stringify(journalRows)}`).toBeTruthy();
  expect(
    journalRows.some((r) => r.entryNo === entryHint),
    `posted ${entryHint} missing from May journals`,
  ).toBeTruthy();
});
