TASK ID: E5
PHASE: Extraction step 5 of 5 - UI: multi-page review viewer with real highlights

OBJECTIVE:
The review viewer shows ALL pages (thumbnails, prev/next, page indicator, zoom, fit) and highlights the focused field
on the correct page at its real position, using the page+bbox the worker stores (E1/E2).

CONTEXT:
- Plan: docs/plan/arnibooks-cursor-prompts-addendum-C.md:43 (viewer: zoom, fit, page thumbnails, highlighted bbox for
  the focused field; draggable splitter).
- E1-E3 made the worker the single extractor: books_extractions.word_boxes = [{page, x0, y0, x1, y1, text, conf}]
  in PDF points (origin top-left) with per-page width/height, and each field in fields_json has
  "source": {"page": n, "bbox": [x0,y0,x1,y1]} or null.
- Viewer today: src/components/books/pdf-page-preview.tsx renders only page 1 (doc.getPage(1), line 45) and filters
  boxes to page 1 (line 71). Bbox helpers: src/lib/review-bbox.ts. Review page: src/app/books/inbox/[id]/page.tsx.

FILES TO INSPECT:
- src/components/books/pdf-page-preview.tsx, src/lib/review-bbox.ts, src/app/books/inbox/[id]/page.tsx
- the inbox/extraction API response shape in src/app/api/books/[...path]/route.ts and src/server/books/inbox.ts
- e2e/books-phase1.spec.ts

IMPLEMENTATION REQUIREMENTS:
- All pages: thumbnail strip, prev/next, page indicator "2 / 3", zoom in/out, fit width. Lazy-render pages
  (do not render every page at full resolution up front).
- Highlights come from fields_json[*].source (page + bbox), drawn only on their own page, scaled to the rendered
  size. No fixed/demo bbox positions at runtime.
- Clicking a field in the form scrolls the viewer to that field's page and highlights its bbox; fields with
  source = null show "location not found" instead of a highlight.
- Images (PNG/JPG) still work as a single page. Keep existing data-testids working (review-preview,
  review-file-pdf, bbox-*), add new ones for page indicator, thumbnails, prev/next, zoom.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "E5:".
- UI only: do not change the worker, extraction, DB, dual control, RLS, or approve checks.
- Follow .cursor/rules/arnibooks.mdc.

TESTS REQUIRED:
- Unit test for the bbox scaling/page filtering helper (page 2 box at zoom 1.5 maps to the right pixels).
- e2e: upload the 2-page synthetic invoice fixture added in E1, open review, page indicator shows "1 / 2",
  thumbnails show 2 pages, clicking the total field shows page 2 with a visible highlight; zoom/fit change the
  rendered width. Screenshots only under UPDATE_SCREENSHOTS.
- Full npm test 0 failures; e2e passes; typecheck passes.

ACCEPTANCE CRITERIA:
1. Viewer shows all pages with thumbnails, prev/next, page indicator, zoom and fit.
2. Highlights use stored page+bbox and land on the correct page (e2e proves it); no fixed demo positions at runtime.
3. Existing review e2e still passes. No test skipped/narrowed.

DO NOT:
- push, force-push, reset, rebase, delete branches
- change worker/extraction/DB code (that was E1-E3)
- edit golden expected values or ground_truth files, disable/skip/narrow any test
- commit docs/phase1/*.png, real client data, or scratch scripts (scripts/_diag-*.sh)
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If the worker's stored source/word_boxes shape is missing or different from the CONTEXT above, STOP and describe the
  actual shape in the report (do not change the worker to fit).
- When done, write the report to the path given in the prompt and stop.
