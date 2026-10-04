TASK ID: POC-001
PHASE: Phase 1 carry-over (loop proof of concept)

OBJECTIVE:
Show the "UI component gallery" link on the books Home page only in development builds.

CONTEXT:
`src/app/books/page.tsx` always renders a link to `/dev/ui` labelled "UI component gallery". It is a developer page
and must not appear to accountants. This is a small, non-accounting task used to prove the automated
Cursor → tests → review loop.

FILES TO INSPECT:
- src/app/books/page.tsx
- src/app/dev/ui (the gallery route itself, if present)
- package.json "test" script (to register any new test file)

EXPECTED BEHAVIOR:
- NODE_ENV === "development": Home shows the "UI component gallery" link (unchanged).
- Any other NODE_ENV (production build, Docker web image, e2e): the link is not rendered.
- The `/dev/ui` route itself returns 404 (notFound()) when NODE_ENV !== "development".

IMPLEMENTATION REQUIREMENTS:
- One small helper, e.g. `isDevUiEnabled(env = process.env.NODE_ENV)` in `src/lib/`, used by both the Home link and the
  /dev/ui route.
- Keep the change minimal; no styling changes.

CONSTRAINTS:
- Work on the current branch only. Make ONE local commit: "POC-001: hide UI gallery outside development".
- Do not touch db/, fixtures/, worker/, .github/, docs/reference/.

TESTS REQUIRED:
- Unit test file `src/lib/dev-ui.test.ts` (node:test via tsx, like the other tests) covering development → true,
  production → false, test → false, undefined → false. Add it to the package.json "test" script list.

ACCEPTANCE CRITERIA:
1. Home link rendered only when the helper returns true.
2. /dev/ui calls notFound() when the helper returns false.
3. `src/lib/dev-ui.test.ts` exists, is registered in `npm test`, and passes in the orchestrator's unit gate.
4. No other files changed except the ones above and package.json.

DO NOT:
- push, force-push, reset, rebase, delete branches
- edit golden expected values, disable/skip/narrow any test
- commit anything under docs/reference/outputs/ or any real client data
- run `git add -A` blindly — stage only the files for this task

STOP CONDITIONS:
- If the current branch is not a feat/* branch, or the working tree has unrelated uncommitted changes, stop and report.
- When done, write a short report to the path given in the prompt (what changed, how you tested) and stop.
