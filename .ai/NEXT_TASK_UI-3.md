TASK ID: UI-3
PHASE: UI polish 3 of 4 - review screen on top of E5 (reference: docs/reference/tofu/UI-PATTERNS.md section 3)

OBJECTIVE:
Turn the review screen into a fast verification view: read-first fields in a two-column grid, hover a field ->
labelled highlight on its page with auto-scroll/zoom, one primary action, a totals block with VAT per code and a
balanced badge, prev/next through the needs-review queue.

CONTEXT:
- E5 (must be PASS first) gave the viewer all pages, thumbnails, zoom/fit and highlights from
  fields_json[*].source {page, bbox}. word_boxes carry per-word conf.
- Today the fields are 15 stacked always-on inputs; buttons Retry extract / Save as profile / Confirm fields sit at
  the bottom; a "low confidence" label exists on some fields; a "Statement review" link sits under the form.
- Plan: .ai/ui-polish-plan.md (guardrails apply).

FILES TO INSPECT:
- src/app/books/inbox/[id]/page.tsx, src/components/books/document-review-panels.tsx,
  src/components/books/pdf-page-preview.tsx, src/lib/review-bbox.ts, src/lib/review-fields.ts, src/lib/highlight.ts,
  src/lib/invoice-validation.ts, src/lib/vat.ts (read-only use), e2e/books-phase1.spec.ts

IMPLEMENTATION REQUIREMENTS:
1. Fields read-first: label above, value as text; hover/focus shows a border + pencil (edit) + copy icons; click or
   Enter edits; Esc cancels. Two-column grid grouped under small eyebrows: DOCUMENT, PARTY, AMOUNTS. Keep every
   field's existing testid on its input when editing and add review-field-<name> on the read view.
2. Hover or focus a field (or a line item) -> its bbox on the right page shows a labelled chip "<Label>: <value>";
   the viewer scrolls to that page and zooms so the box is visible; leaving restores the previous view.
   source = null -> small "location not found" text, no chip. Use E5 helpers; no fixed positions.
3. Confidence dot per field: green / amber / red derived ONLY from data already returned (existing confidence flag,
   or min conf of word_boxes inside the field bbox). Thresholds in one constant. Amber/red never auto-approves;
   it only marks the field. If no data, show no dot.
4. Header: prev/next (next/previous document in the company's needs-review list, same order as the list), document
   type + status badge (UI-2 StatusBadge), kebab menu with Retry extraction and Save as profile (same handlers),
   and exactly ONE primary button = today's confirm/approve action with its current label and server checks.
5. Totals block (bottom of fields): Subtotal; VAT by code ("SR 5% on 100.00 = 5.00"), computed with the existing VAT
   helper from line data (display only - not the posting path); VAT total; Grand total with a double rule; a badge
   "Balanced" (green) or "Off by X.XX" (red) using the existing printed-totals check. Keep totals-panel testid.
6. Keyboard: J/K (or Alt+Arrow) prev/next document. No auto-approve shortcut.
7. Move "Statement review" link into the kebab or remove it if the statement flow is reachable from Statements.
8. Fixed workspace, no page scroll (owner request 05 Oct): the review screen fills the viewport below the top bar
   (height: 100dvh minus top bar). The preview panel and the fields panel each scroll INSIDE their own box;
   the page itself does not scroll. Panels separated by a draggable splitter (default ~55/45, min widths, width
   remembered per user in localStorage with try/catch). The preview toolbar (page n/N, zoom, fit, rotate) and the
   fields header (prev/next, status, primary button) stay pinned at the top of their panels. Below 1024px width
   the panels stack with the preview at a fixed 60vh.
9. Flags line: replace the raw red text "Flags: tax_invoice, methods:1:doctr, company_match:mismatch, ..." with
   badges using readable labels (Tax invoice, Company mismatch, Unassigned); technical flags (methods:*) go into
   a tooltip on an info icon. Keep validation-flags testid.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "UI-3:".
- UI only: src/app/books/inbox/, src/components/books/, src/lib/ (UI helpers + tests), e2e/. No db/, worker/,
  src/server/, API changes, no new dependencies.
- Approve/confirm behaviour, dual control and printed-totals gate unchanged (same API calls).
- Keep all existing data-testids (review-*, bbox-*, source-highlight, totals-panel, validation-flags).

TESTS REQUIRED:
- Unit: VAT-by-code summary from sample lines (integer fils in, correct per-code totals out); confidence mapping
  from word conf to green/amber/red; prev/next index helper at list edges.
- e2e: at 1440x900 the document scrollHeight equals the viewport (no page scroll) while the preview panel is
  scrollable (its scrollHeight > clientHeight on the 2-page fixture) and the primary button is visible without
  scrolling.
- e2e: open the 2-page fixture, hover the total field -> page 2 shown and chip text contains the total; edit a field
  via the read-first view and save; totals block shows "Balanced" for the balanced fixture; next button opens the
  next needs-review document.
- Full npm test 0 failures; typecheck; e2e green. Screenshots only under UPDATE_SCREENSHOTS.

ACCEPTANCE CRITERIA:
1. Read-first fields with hover edit/copy; existing review e2e still pass.
2. Hover -> labelled chip on the correct page with auto-scroll/zoom (e2e proves page + chip).
3. Exactly one primary button; its behaviour and server checks unchanged.
4. Totals block shows VAT per code and the balanced badge (unit + e2e).
5. No test skipped/narrowed; no files outside the allowed paths.

DO NOT:
- push, force-push, reset, rebase, delete branches
- change the worker, extraction output, VAT posting logic, approve/post API, dual control or RLS
- guess a VAT rate in the UI; only display codes that are on the lines
- commit docs/phase1/*.png or scratch files; run `git add -A` blindly

STOP CONDITIONS:
- If E5 is not PASS on the branch, STOP.
- If per-field confidence cannot be derived from returned data, skip requirement 3, say so in the report
  (owner will decide on an E1b worker task) and continue.
- When done, write the report to the path given in the prompt and stop.
