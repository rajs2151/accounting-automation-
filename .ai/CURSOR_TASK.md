TASK ID: P5-2
PHASE: Phase 5 - Fixed asset register + monthly straight-line depreciation

OBJECTIVE:
Register fixed assets per company and post monthly depreciation as dual-control journals; add the Depreciation gate
to the P5-1 close checklist.

READ FIRST: .ai/HOW_TO_WORK.md; spec docs/plan/arnibooks-cursor-prompts.md line 335. PORT from the legacy engine:
src/server/close.ts monthlyStraightLineMinor, registerFixedAsset, listDepreciation, postDepreciation.
COA: 1600 Fixed assets (sub fa), 1690 Accumulated depreciation (fa_contra), 6800 Depreciation (depr),
1790/6810 amortisation. Journal engine: src/server/books/journals.ts (create + post with dual control).

REQUIREMENTS:
- New migration: books_fixed_assets (client, name, asset account default 1600, accumulated account default 1690,
  expense account default 6800, cost_minor, residual_minor, in_service_date, life_months, method 'straight_line',
  disposed_at nullable, source journal/document optional) + books_depreciation_runs (asset, period, amount_minor,
  journal_entry_id, unique (asset, period)). RLS like other books tables.
- Monthly amount = (cost - residual) / life_months in fils, remainder distributed so the total over the life equals
  cost - residual exactly (state the rounding rule; last month absorbs the remainder). First month = month of
  in_service_date (full month; state it). Never depreciate below residual or after disposal.
- "Run depreciation for <period>": creates ONE draft journal (JV, entry_type depreciation) with one Dr 6800 /
  Cr 1690 line per asset, preparer = current user; posting needs an approver (existing dual control). Idempotent:
  running twice for the same period does not double-post (unique run per asset+period).
- Locked period -> refuse (period_locked). Disposal: out of scope (record disposed_at only, stop depreciation).
- Close checklist (P5-1) gate "Depreciation": pass when every active asset has a posted run for the period (or no
  assets), else fail with the list.
- Screen: Settings > Fixed assets (or /books/fixed-assets): list, add asset, schedule preview, Run depreciation.

TESTS (hand-computed): asset cost 36,000.00 residual 0 life 36 -> 1,000.00/month; asset 10,000.00 residual 1,000.00
life 7 -> 1,285.71 x 6 + 1,285.74 last (total 9,000.00); run twice same period -> one journal; locked period
refused; preparer cannot post own run; gate fails before run, passes after posting.
ACCEPTANCE: exact amounts, balanced journals, idempotent runs, gate wired, full gates green.
