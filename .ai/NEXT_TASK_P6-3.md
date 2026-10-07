TASK ID: P6-3
PHASE: Phase 6 - Financial statement exports (Excel + PDF) gated on integrity

OBJECTIVE:
Export P&L, Balance Sheet, Cash Flow, Trial Balance and notes to Excel (one sheet each) and a branded PDF, only when
the P6-1 integrity gates pass.

READ FIRST: .ai/HOW_TO_WORK.md; spec docs/plan/arnibooks-cursor-prompts.md lines 398-400. Reuse the export code
RPT-1 added to ReportTable (XLSX/CSV/print) - no new dependency without stopping to ask.

REQUIREMENTS:
- Excel: sheets P&L, Balance Sheet, Cash Flow, Trial Balance, Notes (accounting policies placeholder, gate results,
  prepared-by, generated-at, company, period, currency AED); numbers as numbers (not text), 2 decimals, same values
  as on screen.
- PDF: Arnifi-branded header (company, period, "prepared by", page numbers), one statement per section.
- Server refuses export when any gate fails (export_blocked_gates + which gate); UI shows which gate failed.
- Export is audited (who, when, period, statement set, hash of payload - see legacy hashStatementsPayload).
TESTS: export with passing gates produces sheets with exact totals (parse the generated file in the test);
blocked when BS does not balance (simulate via a deliberately unbalanced test fixture only if the engine allows -
otherwise unit-test the gate check); audit row written.
ACCEPTANCE: files match screen numbers, gates enforced server-side, full gates green.
