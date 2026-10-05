TASK ID: UI-1
PHASE: UI polish 1 of 4 - app shell and navigation (reference: docs/reference/tofu/UI-PATTERNS.md section 2)

OBJECTIVE:
Make the app shell calm and consistent: company switcher at the top of the sidebar (searchable), one global Upload
button, styled period/language controls instead of native selects, no dev-only labels in the nav.

CONTEXT:
- src/components/shell.tsx: native <select> for period (data-testid topbar-period), language, company
  (books-company-switcher) and "Working as"; nav item "Expenses (Phase 3)"; SecurityBannerChip in the top bar.
- shadcn primitives exist in src/components/ui (select, popover, dropdown-menu, tooltip). lucide-react is installed.
- Plan: .ai/ui-polish-plan.md (guardrails apply).

FILES TO INSPECT:
- src/components/shell.tsx, src/components/security-banner.tsx, src/components/books/books-shell-context.tsx,
  src/components/ui/*, src/lib/dev-ui.ts, e2e/*.spec.ts (any use of the shell controls), .cursor/rules/arnibooks.mdc

IMPLEMENTATION REQUIREMENTS:
1. Company switcher moves to the top of the sidebar: trigger shows a 2-letter chip + company name + chevron-up-down;
   opens a Popover with a search input filtering companies by name; keyboard (up/down/enter/esc) works.
   Keep data-testid books-company-switcher on the trigger; options get data-testid company-option-<id>.
   Switching keeps today's behaviour (same handler, same access rules).
2. Global "Upload" button (outline, upload icon) under the switcher; navigates to /books/inbox and opens the
   existing upload control there. No new upload path.
3. Period: shadcn Select with a status dot (OPEN green / LOCKED or CLOSED grey) - same data, same handler,
   keep data-testid topbar-period. Language: icon DropdownMenu (EN / AR), same behaviour.
4. Search: placeholder "Search..." with a "Ctrl K" hint; Ctrl/Cmd+K focuses it. No new search logic.
5. Nav: unbuilt modules show a small "Soon" badge instead of "(Phase 3)" in the label. Active item style unchanged.
6. SecurityBannerChip stays visible to everyone exactly as today in meaning; only size/position may change.
7. "Working as" stays (dev/role switch) but uses the same Select style.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "UI-1:".
- UI only: src/components/, src/app/ layout files, e2e/. No db/, worker/, src/server/, package.json.
- Keep all existing data-testids. Colours from existing theme tokens only. RTL-safe spacing (ms-/me-).

TESTS REQUIRED:
- e2e: switch company via the new switcher (type part of the name, pick it) and assert the page shows that company;
  change period via the new Select; Ctrl+K focuses search. Update existing specs that drove the old native selects
  to the new interaction without removing assertions.
- Full npm test 0 failures; typecheck; e2e green. Screenshots only under UPDATE_SCREENSHOTS.

ACCEPTANCE CRITERIA:
1. No native <select> left in src/components/shell.tsx.
2. Company switcher at top, searchable, keyboard-usable; e2e proves switching works.
3. Upload button opens the existing inbox upload; no new upload code path.
4. Security chip still rendered with the same status text; no "(Phase N)" text in nav labels.
5. No test skipped/narrowed; no files outside the allowed paths.

DO NOT:
- push, force-push, reset, rebase, delete branches
- add dependencies; change server/API/db/worker code; change access rules for company switching
- hide or remove the security chip
- commit docs/phase1/*.png or scratch files; run `git add -A` blindly

STOP CONDITIONS:
- If a needed primitive is missing from src/components/ui and would require a new dependency, STOP and report.
- When done, write the report to the path given in the prompt and stop.
