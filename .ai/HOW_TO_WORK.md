# How to work (every task) - speed + correctness

Rules: .cursor/rules/arnibooks.mdc. Branch feat/books-phase1, local commits only (never push), prefix = TASK ID.
Integer fils only. Never weaken RLS, dual control (preparer cannot approve/post/reverse own work), period locks,
voucher numbering, or journal immutability (never disable triggers). Synthetic data only. Never edit golden
expected values or existing fixtures/extraction/ground_truth. Tests that write data use createTestCompany
(src/server/books/test-company.ts); only the two read-only goldens may use DESERT.
New migration = next free number after the highest db/NN-*.sql, additive + idempotent, appended to
e2e/global-setup.mjs. Shared files (package.json test list, global-setup, api-error.ts, route.ts) append-only.

Speed
- Read only the spec lines and files the task names; grep for what exists before writing; reuse/port before inventing.
- Smallest change that meets the acceptance criteria; no refactors outside the task. Note extras in the report.
- Iterate with targeted tests: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ai/test-files.ps1 <files>.
  Run full gates ONCE before committing: scripts/ai/gates.ps1 unit typecheck e2e (+ pytest if worker/ changed).
- Time-box ~35 min: if not green, commit what is green and list what is left in the report.

Correctness (what past reviews caught)
- Tests prove behaviour: exact fils amounts, exact journal lines (account, Dr, Cr), journals balance, plus at least
  one negative case (blocked / rejected / no rows). Expected values computed by hand in the test, not by the code.
- Tests measure only rows they created - never company-wide counts.
- Never invent data: missing stays null/"missing"; no default VAT/dates/rates.
- Server enforces every rule; the UI only mirrors it. Locked periods reject postings with period_locked.
- Ambiguous accounting/VAT/CT policy: implement the safest option and list it under "Decisions for owner".

Before "done": tick each acceptance criterion with the test/file that proves it. Report commit, files, migrations,
exact gate counts (unit / typecheck / pytest / e2e), anything skipped, decisions for owner.
