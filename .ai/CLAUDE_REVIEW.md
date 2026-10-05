# Review - TEST-ISO-1 iteration 3

**Decision: PASS**

Cursor fixed the open-items rebuild test, which previously could never fail. The test now creates its own synthetic company and posts three May 2026 documents through the real APIs: a sales invoice left fully open (10,000 + 500 fils), a sales invoice for 20,000 + 1,000 fils with a 10,000-fil receipt allocated against it, and a purchase bill (8,000 + 400 fils). It then runs the rebuild comparison. The original result.ok assertion is unchanged, and a new check requires rebuiltCount >= 3, so the test fails if the documents never reach the rebuild. Only phase1.test.ts changed. The orchestrator's unit gate shows 113 tests, 112 passed, 0 failed and 1 skipped (the PROVISIONAL company-A golden), and the Desert Falcon golden and the DESERT guard test both pass. Typecheck exited cleanly. The negative check is supported only by Cursor's report, which shows the 'aed:<docId>' mismatch output. That fits open-items.ts:348-349, and the committed diff contains no corruption code. One limitation: the orchestrator logs show a single unit run; the second run is reported by Cursor only.

- [PASS] 1. Test posts at least 3 documents (fully open invoice, partly settled invoice, bill) in its own test company before assertOpenItemsMatchRebuild - git diff 5b8a9b4..4763c34 src/server/books/phase1.test.ts: createTestCompany('phase1-rebuild'); openInv (SI 10000+500, 2026-05-10) posted; partialInv (SI 20000+1000, 2026-05-11) posted plus createReceiptOrPayment with a 10000-fil allocation against its open item; bill (PB 8000+400, 2026-05-13) posted; all through createBooksDocument/approveAndPostBooksDocument with OMAR preparing and LAYLA approving
- [PASS] 2. Asserts rebuiltCount >= 3 and keeps the original result.ok assertion unchanged - diff adds assert.ok(result.rebuiltCount >= 3, ...); the line assert.equal(result.ok, true, result.mismatches.join(",")) is untouched context
- [PASS] 3. Negative check described with failing output and not committed - cursor-report.md §Negative check: UPDATE open_aed_minor+1 on openInv produced 'not ok 60 ... aed:<uuid>' with 111 pass / 1 fail; this matches the mismatch format at open-items.ts:348-349; the committed diff has no UPDATE/corruption code. The check was run by Cursor; the orchestrator did not repeat it
- [PASS] 4. Unit gate 0 failures, Desert Falcon golden and guard ok, only skip is PROVISIONAL, count 113 - gates/unit.log: 'ok 60 - rebuild open items matches table', 'ok 69 - TEST-ISO-1 guard...', 'ok 70 - Desert Falcon Jun TB matches hand-computed golden', 'ok 35 ... # SKIP PROVISIONAL golden'; tests 113 / pass 112 / fail 0 / skipped 1 / todo 0
- [PASS] 5. Typecheck green - gates/typecheck.log: tsc --noEmit printed no errors (only an npm notice); package.md shows typecheck PASS
- [PASS] 6. git diff touches only src/server/books/phase1.test.ts - git diff --stat 5b8a9b4..4763c34: 1 file changed, src/server/books/phase1.test.ts (+63/-1)

Needs human validation: 

Question: 
