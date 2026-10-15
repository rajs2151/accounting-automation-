TASK ID: UI-2
PHASE: UI polish 2 of 4 - document queues (reference: docs/reference/tofu/UI-PATTERNS.md sections 4, 6, 8)

OBJECTIVE:
Inbox, Purchases, Sales and Statements lists show human status badges, a clear empty state, readable tabs and
consistent row actions - no raw enum strings on screen.

CONTEXT:
- Purchases shows raw "needs_review" / "sales_invoice" text, an underlined blue file link and Bills/Uploads tabs that
  look disabled (purchase-uploads-tab). Inbox shows an empty table with only headers. Statements list was built in E4.
- src/components/books/data-grid.tsx (books-data-grid) and shadcn badge/tabs/tooltip/dropdown-menu exist.
- Plan: .ai/ui-polish-plan.md (guardrails apply).

FILES TO INSPECT:
- src/app/books/inbox/page.tsx, src/app/books/purchases/page.tsx, src/app/books/sales/page.tsx,
  src/app/books/statements/page.tsx, src/components/books/data-grid.tsx, src/components/ui/badge.tsx,
  src/components/ui/tabs.tsx, e2e/books-phase1.spec.ts

IMPLEMENTATION REQUIREMENTS:
1. New src/components/books/status-badge.tsx + src/lib/status-labels.ts: one map from every existing document/upload
   status and doc type value to {label, tone, icon}. Tones: neutral (queued, duplicate, void), warning (extracting,
   needs review), info (ready), success (approved/posted, balanced), danger (failed). Unknown value -> neutral badge
   showing the raw value (never crash, never hide).
2. Use StatusBadge and the doc-type label everywhere these lists show status/type.
3. New src/components/books/empty-state.tsx (icon, title, one-line hint, optional action). Inbox empty: "No documents
   yet" + Upload action (existing upload). Needs-review empty: "All caught up". Statements empty: "No statements yet"
   + Upload statement.
4. Tabs (Bills | Uploads etc.) use the shadcn Tabs pill style with a clear active state; keep purchase-uploads-tab.
5. File cell: file icon + name (no underline); whole row opens review; Retry/Review move to a row kebab
   (DropdownMenu) visible on hover and on keyboard focus. Keep existing testids on the actions.
6. Amount columns right-aligned with tabular numbers, AED 2dp; blank when null.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "UI-2:".
- UI only. No db/, worker/, src/server/, API changes, no new statuses. No new dependencies.
- Keep all existing data-testids; RTL-safe spacing; theme tokens only.

TESTS REQUIRED:
- Unit: status-labels maps every status value used in src/server/books (enumerate them in the test) and falls back
  for unknown values.
- e2e: Purchases row shows "Needs review" badge (not "needs_review"); empty Inbox shows the empty state with an
  Upload button; row kebab -> Review opens the review page.
- Full npm test 0 failures; typecheck; e2e green. Screenshots only under UPDATE_SCREENSHOTS.

ACCEPTANCE CRITERIA:
1. No raw status/doc-type enum text rendered in the four lists (e2e + unit prove it).
2. Empty states render with a working action.
3. Tabs visibly active/inactive; existing e2e still pass. No test skipped/narrowed.

DO NOT:
- push, force-push, reset, rebase, delete branches
- add statuses (e.g. "Review later" needs a db task) or change status transitions
- change approve/post logic or dual control
- commit docs/phase1/*.png or scratch files; run `git add -A` blindly

STOP CONDITIONS:
- If a list needs data the API does not return, STOP and report (no API change in this task).
- When done, write the report to the path given in the prompt and stop.
