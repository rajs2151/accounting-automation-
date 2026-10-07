import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const DESERT = "e1000001-0000-4000-8000-000000000001";
const CUSTOMER = "e9000001-0000-4000-8000-000000000001";
const SUPPLIER = "e9000001-0000-4000-8000-000000000002";
const STMT_BALANCED = "e7000001-0000-4000-8000-000000000098";
const STMT_DROPPED = "e7000001-0000-4000-8000-000000000088";
const PHASE1_DIR = path.join(process.cwd(), "docs", "phase1");
const FIXTURE_PDF = path.join(process.cwd(), "fixtures", "extraction", "pdfs", "invoice_02.pdf");
const BANK_A_PDF = path.join(process.cwd(), "fixtures", "extraction", "pdfs", "bank_a.pdf");
const INVOICE_2PAGE_PDF = path.join(
  process.cwd(),
  "fixtures",
  "extraction",
  "pdfs",
  "invoice_2page.pdf",
);

/**
 * e2e profile does not run the Python worker. After upload (status=queued), insert a
 * worker-shaped books_extractions row so review UI can assert fields without waiting.
 * Shape matches workerInvoiceFieldsJson / process_extract_document (fils ints; no UI mirrors).
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
    // ONLY keys the worker writes — money as integer fils, dates as ISO.
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
      document_date: {
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
      supplier_trn: {
        value: "100000000000001",
        confidence: 0.95,
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
      grand_total: {
        value: 10500,
        confidence: 0.95,
        status: "ok",
        source: { page: 1, bbox: [400, 240, 460, 254] },
      },
      _line_items: [
        {
          description: "Professional services",
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
        },
      ],
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
  await expect(page.getByRole("heading", { name: "Customers & suppliers" })).toBeVisible();
  await expect(page.getByText("Oasis Retail LLC")).toBeVisible({ timeout: 15000 });

  // UI-1 shell: searchable company switcher, period Select, Ctrl+K search focus
  await page.getByTestId("books-company-switcher").click();
  await page.getByPlaceholder("Search companies…").fill("Gulf");
  await page.getByTestId("company-option-e1000001-0000-4000-8000-000000000002").click();
  await expect(page.getByTestId("books-company-switcher")).toContainText(/Gulf Crest/i, {
    timeout: 15000,
  });
  await page.getByTestId("books-company-switcher").click();
  await page.getByPlaceholder("Search companies…").fill("Desert");
  await page.getByTestId("company-option-e1000001-0000-4000-8000-000000000001").click();
  await expect(page.getByTestId("books-company-switcher")).toContainText(/Desert Falcon/i, {
    timeout: 15000,
  });

  const periodTrigger = page.getByTestId("topbar-period");
  await expect(periodTrigger).toBeVisible();
  // P2A-5: show label, never the raw period UUID.
  await expect(periodTrigger).toContainText(/\d{4}/);
  await expect(periodTrigger).not.toContainText(/e2000001-/i);
  await periodTrigger.click();
  await page.keyboard.press("Escape");

  const search = page.getByTestId("topbar-search");
  await search.blur();
  await page.keyboard.press("Control+k");
  // Focus shortcut can race with period popover teardown — retry once.
  if (!(await search.evaluate((el) => el === document.activeElement))) {
    await page.keyboard.press("Control+k");
  }
  await expect(search).toBeFocused({ timeout: 5000 });

  await page.goto("/books/inbox");
  await page.getByTestId("inbox-upload").click();
  await expect(page.getByTestId("upload-dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/books/sales");
  await expect(page.getByRole("heading", { name: "Sales invoices" })).toBeVisible();
  await expect(page.getByText("Upload Invoices")).toBeVisible();
  await page.getByTestId("sales-upload").click();
  await expect(page.getByTestId("upload-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Record manually/i })).toBeVisible();
  await expect(page.getByTestId("sales-uploads-tab")).toBeVisible();
  await expect(page.getByTestId("sales-issue-date")).toBeVisible();

  await page.goto("/books/purchases");
  await expect(page.getByRole("heading", { name: "Purchase bills" })).toBeVisible();
  await expect(page.getByTestId("purchase-upload")).toBeVisible();
  await page.getByTestId("purchase-upload").click();
  await expect(page.getByTestId("upload-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("(fils)")).toHaveCount(0);
  await expect(page.getByTestId("purchase-uploads-tab")).toBeVisible();
  await expect(page.getByTestId("purchase-issue-date")).toBeVisible();

  await page.goto("/books/expenses");
  await expect(page.getByRole("heading", { name: "Expenses" })).toBeVisible();
  await expect(page.getByTestId("expenses-new")).toBeVisible();
  await expect(page.getByText("(Phase 3)")).toHaveCount(0);

  await page.goto("/books/banking");
  await expect(page.getByRole("heading", { name: "Bank accounts" })).toBeVisible();
  await expect(page.getByTestId("banking-accounts-table")).toBeVisible();

  await page.goto("/books/transactions");
  await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();
  await expect(page.getByTestId("txn-tab-needs-review")).toBeVisible();
  await expect(page.getByTestId("txn-table")).toBeVisible();

  await page.goto("/books/journals");
  await expect(page.getByTestId("ledger-page-chrome")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Journals" })).toBeVisible();
  await expect(page.getByText("Beta")).toBeVisible();
  await expect(page.getByTestId("create-journal-open")).toBeVisible();
  await expect(page.getByRole("link", { name: "Journals" })).toBeVisible();

  // P4-3: Create Entry templates — accrual auto-reverse; prepayment asset warning
  await page.getByTestId("create-journal-open").click();
  const createSheet = page.getByTestId("create-entry-sheet");
  await expect(createSheet).toBeVisible({ timeout: 15_000 });
  await createSheet.getByTestId("create-entry-template-accrual").click();
  await expect(createSheet.getByTestId("create-entry-auto-reverse-checkbox")).toBeChecked();
  await expect(createSheet.getByTestId("create-entry-template-hint")).toContainText(/auto-reverse/i);
  await createSheet.getByTestId("create-entry-template-prepayment").click();
  await expect(createSheet.getByTestId("create-entry-template-warning")).toContainText(/1410|asset/i);
  await expect(createSheet.getByTestId("create-entry-auto-reverse-checkbox")).not.toBeChecked();

  // P4-4: schedule for later → Save draft creates scheduled status (excluded from TB until job posts)
  await createSheet.getByTestId("create-entry-template-blank").click();
  await createSheet.getByTestId("create-entry-schedule-checkbox").check();
  await expect(createSheet.getByTestId("create-entry-scheduled-for")).toBeVisible();
  await createSheet.getByRole("button", { name: "Cancel" }).click();

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
  await expect(page.getByTestId("review-field-invoice_no")).toContainText("INV-SYN-002");
  await expect(page.getByTestId("review-field-subtotal")).toContainText("100.00");
  await expect(page.getByTestId("review-field-vat_total")).toContainText("5.00");
  await expect(page.getByTestId("review-field-grand_total")).toContainText("105.00");
  await expect(page.getByTestId("review-field-invoice_date")).toContainText("15/05/2026");
  // Read-first → click to edit exposes field-* input with the same value.
  await page.getByTestId("review-field-invoice_no").click();
  await expect(page.getByTestId("field-invoice_no")).toHaveValue("INV-SYN-002");
  await page.getByTestId("field-invoice_no").fill("INV-SYN-002-EDIT");
  await page.getByTestId("field-invoice_no").press("Enter");
  await expect(page.getByTestId("review-field-invoice_no")).toContainText("INV-SYN-002-EDIT");
  await expect(page.getByTestId("review-file-meta")).toContainText("invoice_02.pdf");
  const preview = page.getByTestId("review-file-pdf").or(page.getByTestId("review-file-image"));
  await expect(preview).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("validation-flags")).toContainText(/balanced/i);
  await expect(page.getByTestId("totals-panel")).toBeVisible();
  await expect(page.getByTestId("totals-balance-badge")).toContainText(/Balanced/i);
  await expect(page.getByTestId("vat-by-code-SR")).toContainText(/SR 5% on 100\.00 = 5\.00/);
  await expect(page.getByTestId("confirm-fields")).toBeVisible();
  await expect(page.getByTestId("review-approve-next")).toBeVisible();
  await expect(page.getByTestId("review-back")).toBeVisible();
  await savePhase1("review-split-view.png", await page.screenshot({ fullPage: true }));
  await savePhase1("review-uploaded-invoice-02.png", await page.screenshot({ fullPage: true }));

  // Multi-page viewer (E5): 2-page fixture, total on page 2.
  {
    const base2 = fs.readFileSync(INVOICE_2PAGE_PDF);
    const bytes2 = Buffer.concat([
      base2,
      Buffer.from(`\n% e2e-2pg-${Date.now()}-${Math.random()}\n`),
    ]);
    const upload2 = await page.request.post("/api/books/inbox/upload", {
      multipart: {
        files: {
          name: "invoice_2page.pdf",
          mimeType: "application/pdf",
          buffer: bytes2,
        },
      },
    });
    const uploaded2 = await upload2.json();
    expect(upload2.ok(), `2page upload: ${JSON.stringify(uploaded2)}`).toBeTruthy();
    const inbox2 = uploaded2.results?.[0]?.inboxItemId as string;
    const file2 = uploaded2.results?.[0]?.fileId as string;
    expect(inbox2).toBeTruthy();

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
          value: "INV-SYN-2PG",
          confidence: 0.95,
          status: "ok",
          source: { page: 1, bbox: [72, 120, 200, 134] },
        },
        invoice_date: {
          value: "2026-05-15",
          confidence: 0.95,
          status: "ok",
          source: { page: 1, bbox: [72, 140, 160, 154] },
        },
        currency: { value: "AED", confidence: 0.99, status: "ok", source: null },
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
          source: { page: 2, bbox: [120, 80, 180, 94] },
        },
        gross: {
          value: 10500,
          confidence: 0.95,
          status: "ok",
          source: { page: 2, bbox: [120, 110, 190, 128] },
        },
        grand_total: {
          value: 10500,
          confidence: 0.95,
          status: "ok",
          source: { page: 2, bbox: [120, 110, 190, 128] },
        },
      };
      await admin.query(`DELETE FROM books_extractions WHERE inbox_item_id = $1`, [inbox2]);
      await admin.query(
        `INSERT INTO books_extractions (
           id, client_id, file_id, inbox_item_id, doc_type, status,
           fields_json, raw_text, word_boxes, validation_flags, extractor_version
         ) VALUES ($1,$2,$3,$4,'sales_invoice','needs_review',$5::jsonb,$6,
           $7::jsonb,'[]'::jsonb,'phase1-v1')`,
        [
          extractionId,
          DESERT,
          file2,
          inbox2,
          JSON.stringify(fields),
          "TAX INVOICE INV-SYN-2PG\nTotal 105.00\n",
          JSON.stringify([
            { page: 1, width: 595, height: 842 },
            { page: 2, width: 595, height: 842 },
            {
              page: 2,
              x0: 120,
              y0: 110,
              x1: 190,
              y1: 128,
              text: "105.00",
              conf: 1,
            },
          ]),
        ],
      );
      await admin.query(
        `UPDATE books_inbox_items
         SET status = 'needs_review', detected_type = 'sales_invoice',
             classification_confidence = 0.9, error = NULL, updated_at = now()
         WHERE id = $1`,
        [inbox2],
      );
    } finally {
      await admin.end();
    }

    await page.goto(`/books/inbox/${inbox2}`);
    await expect(page.getByTestId("review-split-view")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("review-page-indicator")).toHaveText("1 / 2", {
      timeout: 20000,
    });
    await expect(page.getByTestId("review-page-thumbnails")).toBeVisible();
    await expect(page.getByTestId("review-thumb-1")).toBeVisible();
    await expect(page.getByTestId("review-thumb-2")).toBeVisible();

    const canvas = page.getByTestId("review-file-pdf");
    await expect(canvas).toBeVisible({ timeout: 20000 });
    const widthBefore = await canvas.evaluate((el) => (el as HTMLCanvasElement).width);
    await page.getByTestId("review-zoom-in").click();
    await expect
      .poll(async () => canvas.evaluate((el) => (el as HTMLCanvasElement).width), {
        timeout: 10000,
      })
      .toBeGreaterThan(widthBefore);
    await page.getByTestId("review-zoom-fit").click();
    await expect
      .poll(async () => canvas.evaluate((el) => (el as HTMLCanvasElement).width), {
        timeout: 10000,
      })
      .toBe(widthBefore);

    // UI-3: hover total → page 2 + labelled chip containing the total.
    await page.getByTestId("review-field-grand_total").hover();
    await expect(page.getByTestId("review-page-indicator")).toHaveText("2 / 2", {
      timeout: 10000,
    });
    await expect(page.getByTestId("bbox-grand_total")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("source-highlight")).toContainText(/105\.00/);
    await expect(page.getByTestId("location-missing-currency")).toBeVisible();

    // UI-3-fix1: no page scroll; preview scrolls; Confirm visible immediately.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("confirm-fields")).toBeVisible();
    const scrollMetrics = await page.evaluate(() => {
      const docEl = document.documentElement;
      const preview = document.querySelector(
        '[data-testid="review-preview-scroll"]',
      ) as HTMLElement | null;
      return {
        pageScrollHeight: docEl.scrollHeight,
        pageClientHeight: docEl.clientHeight,
        previewScrollHeight: preview?.scrollHeight ?? 0,
        previewClientHeight: preview?.clientHeight ?? 0,
      };
    });
    expect(scrollMetrics.pageScrollHeight).toBeLessThanOrEqual(
      scrollMetrics.pageClientHeight + 2,
    );
    expect(scrollMetrics.previewScrollHeight).toBeGreaterThan(
      scrollMetrics.previewClientHeight,
    );

    // Queue next: newest 2-page doc → older needs-review in the same company list.
    await expect(page.getByTestId("review-queue-next")).toBeEnabled();
    const beforeUrl = page.url();
    await page.getByTestId("review-queue-next").click();
    await expect.poll(() => page.url()).not.toBe(beforeUrl);
    await expect(page).toHaveURL(/\/books\/inbox\/[0-9a-f-]+/i);
    await expect(page.getByTestId("review-split-view")).toBeVisible({ timeout: 15000 });
  }

  const list = await page.request.get("/api/books/statements");
  const rows = (await list.json()) as Array<{ id: string }>;
  expect(Array.isArray(rows), `statements API: ${JSON.stringify(rows)}`).toBeTruthy();
  expect(rows.some((r) => r.id === STMT_BALANCED), "balanced statement seed missing").toBeTruthy();
  expect(rows.some((r) => r.id === STMT_DROPPED), "dropped-row statement seed missing").toBeTruthy();

  await page.goto(`/books/statements/${STMT_BALANCED}`);
  await expect(page.getByTestId("statement-review")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("statement-account")).not.toHaveText("—");
  await expect(page.getByTestId("statement-iban")).toContainText(/AE07 \*{4} 3456/);
  await expect(page.getByTestId("statement-currency")).toHaveText("AED");
  await expect(page.getByText("CLIENT RECEIPT")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("statement-balance-status")).toContainText("Balanced");
  await expect(page.getByTestId("rb-check-0")).toContainText("✓");

  // Edit opening → Off by; restore → Balanced again.
  const opening = page.getByTestId("statement-opening");
  await opening.click();
  await page.getByTestId("statement-opening").fill("999.00");
  await page.getByTestId("statement-opening").press("Enter");
  await expect(page.getByTestId("statement-balance-status")).toContainText(/Off by/);
  await page.getByTestId("statement-opening").click();
  await page.getByTestId("statement-opening").fill("1,000.00");
  await page.getByTestId("statement-opening").press("Enter");
  await expect(page.getByTestId("statement-balance-status")).toContainText("Balanced");

  await savePhase1("statement-review.png", await page.screenshot({ fullPage: true }));

  await page.goto(`/books/statements/${STMT_DROPPED}`);
  await expect(page.getByText(/CARD PAYMENT/)).toBeVisible({ timeout: 15000 });
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
  await expect(page.getByTestId("receipts-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("receipt-record")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Expenses" })).toBeVisible();
  await expect(page.getByTestId("expenses-table")).toBeVisible();
  await savePhase1("expenses-phase3.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/sales");
  await expect(page.getByRole("heading", { name: "Sales invoices" })).toBeVisible();
  await savePhase1("sales.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/inbox");
  await expect(page.getByRole("heading", { name: /Inbox/ })).toBeVisible();
  await savePhase1("inbox.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/parties");
  await expect(page.getByRole("heading", { name: "Customers & suppliers" })).toBeVisible();
  await savePhase1("parties.png", await page.screenshot({ fullPage: true }));
});

/**
 * e2e has no Python worker process. After bank_statement upload, seed the same
 * books_statement_extractions + lines shape process_extract_document writes for bank_a.
 */
async function insertWorkerShapedStatement(args: {
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
    const stmtId = randomUUID();
    await admin.query(`DELETE FROM books_extractions WHERE inbox_item_id = $1`, [
      args.inboxItemId,
    ]);
    await admin.query(
      `INSERT INTO books_extractions (
         id, client_id, file_id, inbox_item_id, doc_type, status,
         fields_json, raw_text, word_boxes, validation_flags, extractor_version
       ) VALUES ($1,$2,$3,$4,'bank_statement','ready',$5::jsonb,$6,'[]'::jsonb,
                 '["balance_ok"]'::jsonb,'phase1-v1')`,
      [
        extractionId,
        args.clientId,
        args.fileId,
        args.inboxItemId,
        JSON.stringify({
          currency: { value: "AED", confidence: 0.99, status: "ok", source: null },
        }),
        "ACCOUNT STATEMENT\nIBAN AE070331234567890123456\n",
      ],
    );
    await admin.query(
      `INSERT INTO books_statement_extractions (
         id, client_id, file_id, inbox_item_id, account_label, iban, bank_name, currency,
         period_from, period_to, opening_balance_minor, closing_balance_minor,
         status, validation_flags
       ) VALUES ($1,$2,$3,$4,'Synthetic UAE Bank A','AE070331234567890123456',
                 'Synthetic UAE Bank A','AED','2026-05-01','2026-05-31',
                 100000,130000,'ready','["balance_ok"]'::jsonb)`,
      [stmtId, args.clientId, args.fileId, args.inboxItemId],
    );
    await admin.query(
      `INSERT INTO books_statement_lines (
         id, statement_id, client_id, line_date, description,
         debit_minor, credit_minor, running_balance_minor, currency, confidence, flags, sort_index
       ) VALUES
         ($1,$2,$3,'2026-05-05','CLIENT RECEIPT',0,50000,NULL,'AED',0.99,'{}',0),
         ($4,$2,$3,'2026-05-10','OFFICE RENT',20000,0,NULL,'AED',0.99,'{}',1)`,
      [randomUUID(), stmtId, args.clientId, randomUUID()],
    );
    await admin.query(
      `UPDATE books_inbox_items
       SET status = 'ready', detected_type = 'bank_statement',
           classification_confidence = 1, error = NULL, updated_at = now()
       WHERE id = $1`,
      [args.inboxItemId],
    );
    return stmtId;
  } finally {
    await admin.end();
  }
}

test("phase1: upload bank statement from /books/statements", async ({ page }) => {
  await page.goto("/books/statements");
  await expect(page.getByRole("heading", { name: "Bank statements" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByTestId("statement-upload")).toBeVisible();
  await expect(page.getByTestId("statements-table")).toBeVisible();
  await expect(page.getByTestId("stripe-csv-textarea")).toBeVisible();

  // Unique bytes so per-company hash does not collide with prior runs.
  const base = fs.readFileSync(BANK_A_PDF);
  const bytes = Buffer.concat([
    base,
    Buffer.from(`\n% e2e-bank-${Date.now()}-${Math.random()}\n`),
  ]);
  const tmpPdf = path.join(process.cwd(), "e2e", "artifacts", `bank_a-${Date.now()}.pdf`);
  fs.mkdirSync(path.dirname(tmpPdf), { recursive: true });
  fs.writeFileSync(tmpPdf, bytes);

  // Prove the shared Upload dialog (not a bare API call).
  await page.getByTestId("statement-upload").click();
  await expect(page.getByTestId("upload-dialog")).toBeVisible();
  await page.getByTestId("upload-dialog-input").setInputFiles(tmpPdf);
  await expect(page.getByTestId("upload-file-list")).toContainText(/Uploaded/i, {
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("bank_a-").or(page.getByText("bank_a.pdf"))).toBeVisible({
    timeout: 20000,
  });

  // Resolve the pending inbox row from the list API (queued before worker finishes).
  let inboxId = "";
  let fileId = "";
  await expect
    .poll(
      async () => {
        const list = await page.request.get("/api/books/statements");
        const rows = (await list.json()) as Array<{
          id: string;
          filename?: string;
          status: string;
          rowKind?: string;
          fileId?: string;
        }>;
        const pending = rows.find(
          (r) =>
            (r.rowKind === "pending" || r.status === "queued" || r.status === "extracting") &&
            String(r.filename || "").includes("bank_a"),
        );
        if (!pending) return null;
        inboxId = pending.id;
        fileId = String(pending.fileId || "");
        return pending.status;
      },
      { timeout: 20000 },
    )
    .toMatch(/queued|extracting/i);
  expect(inboxId).toBeTruthy();
  await expect(page.getByTestId(`statement-status-${inboxId}`)).toContainText(/Queued|Extracting/i);

  // e2e Playwright profile does not run the Python worker. Seed the same
  // books_statement_extractions + lines shape process_extract_document writes for bank_a.
  if (!fileId) {
    const admin = new pg.Client({
      connectionString:
        process.env.DATABASE_URL_SUPER ||
        "postgresql://daftar:daftar-local-only@127.0.0.1:5432/daftar_e2e",
    });
    await admin.connect();
    try {
      const f = await admin.query(`SELECT file_id FROM books_inbox_items WHERE id = $1`, [inboxId]);
      fileId = String(f.rows[0]?.file_id || "");
    } finally {
      await admin.end();
    }
  }
  expect(fileId, "fileId required to seed worker-shaped statement").toBeTruthy();

  const stmtId = await insertWorkerShapedStatement({
    inboxItemId: inboxId,
    fileId,
    clientId: DESERT,
  });

  await page.reload();
  await expect(page.getByTestId(`statement-row-${stmtId}`)).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId(`statement-status-${stmtId}`)).toContainText(/Extracted|Ready/i);
  const row = page.getByTestId(`statement-row-${stmtId}`);
  await expect(row).toContainText(/bank_a/);
  await expect(row).toContainText("2"); // line count
  await expect(page.getByTestId(`balance-check-${stmtId}`)).toContainText(/Balanced|ok/i);
  await expect(row).toContainText(/AE07/);
  await expect(row).toContainText("1,000.00");
  await expect(row).toContainText("1,300.00");

  try {
    fs.unlinkSync(tmpPdf);
  } catch {
    /* ignore */
  }
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
  await expect(page.getByTestId("document-totals-panel")).toBeVisible();
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

test("P2A-4: Unmatched → pick invoice → post → journal link back", async ({ page, context }) => {
  const periods = await page.request.get("/api/books/periods");
  const periodRows = (await periods.json()) as Array<{ id: string; label: string }>;
  const may = periodRows.find((p) => /May 2026/i.test(p.label));
  expect(may?.id, "May 2026 period required").toBeTruthy();

  const banksRes = await page.request.get("/api/books/bank-accounts");
  const banks = (await banksRes.json()) as Array<{ id: string; code: string; iban?: string | null }>;
  expect(banksRes.ok()).toBeTruthy();
  const bank = banks.find((b) => b.code === "1120") || banks[0];
  expect(bank?.id, "bank account required").toBeTruthy();

  const docNo = `E2E-RV-${Date.now()}`;
  const create = await page.request.post("/api/books/documents", {
    data: {
      docType: "sales_invoice",
      partyId: CUSTOMER,
      issueDate: "2026-05-14",
      periodId: may!.id,
      documentNumber: docNo,
      lines: [
        {
          description: "E2E consulting",
          lineKind: "revenue",
          vatCode: "SR",
          netMinor: 20000,
          vatMinor: 1000,
        },
      ],
    },
  });
  const created = await create.json();
  expect(create.ok(), `create invoice: ${JSON.stringify(created)}`).toBeTruthy();

  await setSession(context, LAYLA);
  const approve = await page.request.post(`/api/books/documents/${created.id}/approve`, {
    data: {},
  });
  const approved = await approve.json();
  expect(approve.ok(), `approve: ${JSON.stringify(approved)}`).toBeTruthy();
  await setSession(context, OMAR);

  const admin = new pg.Client({
    connectionString:
      process.env.DATABASE_URL_SUPER ||
      "postgresql://daftar:daftar-local-only@127.0.0.1:5432/daftar_e2e",
  });
  await admin.connect();
  let txnId = "";
  try {
    const oi = await admin.query(
      `SELECT id FROM books_open_items WHERE document_id = $1 AND client_id = $2`,
      [created.id, DESERT],
    );
    expect(oi.rowCount).toBeTruthy();
    const openItemId = String(oi.rows[0].id);

    await admin.query(
      `UPDATE books_accounts SET bank_name = COALESCE(bank_name, 'E2E Bank'),
         iban = COALESCE(iban, 'AE070331234567890123456'),
         iban_last4 = COALESCE(iban_last4, '3456')
       WHERE id = $1`,
      [bank!.id],
    );

    const fileId = randomUUID();
    const stmtId = randomUUID();
    const lineId = randomUUID();
    const desc = `E2E receipt ${docNo}`;
    await admin.query(
      `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
       VALUES ($1,$2,$3,$4,'e2e-txn.pdf','application/pdf',10,$5)`,
      [fileId, DESERT, `e2e-txn-${randomUUID()}`, `books/${DESERT}/${fileId}/e2e.pdf`, OMAR],
    );
    await admin.query(
      `INSERT INTO books_statement_extractions (
         id, client_id, file_id, account_id, iban, period_from, period_to,
         opening_balance_minor, closing_balance_minor, status, validation_flags
       ) VALUES (
         $1,$2,$3,$4,'AE070331234567890123456','2026-05-01','2026-05-31',
         0,21000,'ready','["balance_ok"]'::jsonb
       )`,
      [stmtId, DESERT, fileId, bank!.id],
    );
    await admin.query(
      `INSERT INTO books_statement_lines (
         id, statement_id, client_id, line_date, description, reference,
         debit_minor, credit_minor, currency, sort_index
       ) VALUES ($1,$2,$3,'2026-05-15',$4,$5,0,21000,'AED',0)`,
      [lineId, stmtId, DESERT, desc, docNo],
    );

    const mat = await page.request.post("/api/books/bank-transactions/materialize", { data: {} });
    expect(mat.ok(), `materialize: ${await mat.text()}`).toBeTruthy();

    const list = await page.request.get(
      "/api/books/bank-transactions?status=needs_review&unmatched=1",
    );
    const rows = (await list.json()) as Array<{ id: string; description: string }>;
    expect(list.ok()).toBeTruthy();
    const txn = rows.find((r) => r.description === desc);
    expect(txn?.id, `txn missing: ${JSON.stringify(rows)}`).toBeTruthy();
    txnId = txn!.id;

    const typed = await page.request.patch(`/api/books/bank-transactions/${txnId}`, {
      data: { txnType: "customer_receipt" },
    });
    expect(typed.ok(), `type: ${await typed.text()}`).toBeTruthy();

    await page.goto("/books/transactions");
    await expect(page.getByTestId("txn-filter-unmatched")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("txn-filter-unmatched").click();
    await expect(page.getByTestId(`txn-row-${txnId}`)).toBeVisible({ timeout: 15000 });

    // Pick invoice in the Unmatched grid
    await page.getByTestId(`txn-match-${txnId}`).click();
    await page.getByRole("option", { name: new RegExp(docNo) }).click();
    await expect
      .poll(async () => {
        const res = await page.request.get("/api/books/bank-transactions?status=needs_review");
        const rows2 = (await res.json()) as Array<{ id: string; openItemId?: string | null }>;
        return rows2.find((r) => r.id === txnId)?.openItemId || null;
      })
      .toBe(openItemId);

    // Matched rows leave the Unmatched chip — clear it so Mark reviewed is visible.
    await page.getByTestId("txn-filter-unmatched").click();
    await expect(page.getByTestId(`txn-mark-${txnId}`)).toBeVisible({ timeout: 15000 });
    await page.getByTestId(`txn-mark-${txnId}`).click();
    await expect
      .poll(async () => {
        const res = await page.request.get("/api/books/bank-transactions?status=ready");
        const rows2 = (await res.json()) as Array<{ id: string }>;
        return rows2.some((r) => r.id === txnId);
      })
      .toBeTruthy();

    // Approver posts (dual control) — API keeps the assert tight; UI verifies link-back.
    await setSession(context, LAYLA);
    const postedRes = await page.request.post(`/api/books/bank-transactions/${txnId}/post`, {
      data: {},
    });
    const postedBody = await postedRes.json();
    expect(postedRes.ok(), `post: ${JSON.stringify(postedBody)}`).toBeTruthy();
    expect(String(postedBody.entryNo || "")).toMatch(/^RV-/);
    expect(postedBody.journalEntryId).toBeTruthy();

    await page.goto("/books/transactions");
    await page.getByTestId("txn-tab-posted").click();
    await expect(page.getByTestId(`txn-journal-link-${txnId}`)).toBeVisible({ timeout: 15000 });
    const link = page.getByTestId(`txn-journal-link-${txnId}`);
    await expect(link).toContainText(String(postedBody.entryNo));
    const href = await link.getAttribute("href");
    expect(href).toContain(`highlight=${encodeURIComponent(String(postedBody.journalEntryId))}`);

    const journals = await page.request.get(
      `/api/books/journals?periodId=${encodeURIComponent(may!.id)}`,
    );
    const journalRows = (await journals.json()) as Array<{ id?: string; entryNo?: string }>;
    expect(
      journalRows.some(
        (r) => r.id === postedBody.journalEntryId || r.entryNo === postedBody.entryNo,
      ),
      `journal ${postedBody.entryNo} missing`,
    ).toBeTruthy();
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P4-5: reverse posted journal requires reason; original immutable status=reversed", async ({
  page,
  context,
}) => {
  const ACCT_1120 = "e3000001-0000-4000-8000-000000000001";
  const ACCT_4100 = "e3000001-0000-4000-8000-000000000007";

  const periods = await page.request.get("/api/books/periods");
  const periodRows = (await periods.json()) as Array<{ id: string; label: string }>;
  const may = periodRows.find((p) => /May 2026/i.test(p.label));
  expect(may?.id, "May 2026 period").toBeTruthy();

  // Omar prepares
  await setSession(context, OMAR);
  const created = await page.request.post("/api/books/journals", {
    data: {
      periodId: may!.id,
      entryDate: "2026-05-20",
      memo: `P4-5 reverse e2e ${Date.now()}`,
      voucherType: "Journal",
      lines: [
        { accountId: ACCT_1120, debitMinor: 777 },
        { accountId: ACCT_4100, creditMinor: 777 },
      ],
      post: false,
    },
  });
  const draft = await created.json();
  expect(created.ok(), `create: ${JSON.stringify(draft)}`).toBeTruthy();

  // Layla posts + reverses (dual control)
  await setSession(context, LAYLA);
  const postRes = await page.request.post(`/api/books/journals/${draft.id}/post`);
  const posted = await postRes.json();
  expect(postRes.ok(), `post: ${JSON.stringify(posted)}`).toBeTruthy();

  const noReason = await page.request.post(`/api/books/journals/${draft.id}/reverse`, {
    data: { entryDate: "2026-05-21", reason: "" },
  });
  expect(noReason.status()).toBe(400);

  const revRes = await page.request.post(`/api/books/journals/${draft.id}/reverse`, {
    data: { entryDate: "2026-05-21", reason: "P4-5 e2e reverse" },
  });
  const rev = await revRes.json();
  expect(revRes.ok(), `reverse: ${JSON.stringify(rev)}`).toBeTruthy();
  expect(rev.reversalId).toBeTruthy();
  expect(rev.status).toBe("reversed");

  const orig = await page.request.get(`/api/books/journals/${draft.id}`).then((r) => r.json());
  expect(orig.status).toBe("reversed");
  expect(String(orig.reversedByEntryId)).toBe(String(rev.reversalId));

  const reversal = await page.request
    .get(`/api/books/journals/${rev.reversalId}`)
    .then((r) => r.json());
  expect(reversal.status).toBe("posted");
  expect(String(reversal.reversesEntryId)).toBe(String(draft.id));
  expect(String(reversal.entryType || "")).toBe("reversal");

  // Ledger UI: Reverse control available to approver
  await page.goto("/books/journals");
  await expect(page.getByTestId("ledger-page-chrome")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("create-journal-open")).toBeVisible();
});
