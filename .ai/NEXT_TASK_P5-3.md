TASK ID: P5-3
PHASE: Phase 5 - FX rate table + month-end FX revaluation (unrealised gain/loss)

OBJECTIVE:
Per-company manual FX rate table, and a month-end revaluation of foreign-currency monetary balances that posts one
unrealised gain/loss journal (auto-reversed on the 1st of the next month), plus the FX gate in the close checklist.

READ FIRST: .ai/HOW_TO_WORK.md; spec docs/plan/arnibooks-cursor-prompts.md line 336. Existing: fx_rate_scaled on
documents/lines/open items (scale 1e8 - see src/lib/fx.ts), P4-3/P4-4 auto-reverse scheduling (journals.ts),
accounts.currency, 1121 USD bank, open items (open_original_minor / open_aed_minor). COA 7310 FX unrealised.

REQUIREMENTS:
- New migration: books_fx_rates (client, currency, rate_date, rate_scaled to AED, source 'manual', entered_by).
  Unique (client, currency, rate_date). RLS like other books tables.
- Revaluation for a period end: for each non-AED monetary item - bank/card accounts in a foreign currency (balance
  in original currency from journal lines) and open AR/AP items in a foreign currency (open_original_minor) -
  revalued AED = original x period-end rate; difference vs carried AED goes to 7310 (gain = Cr, loss = Dr) against
  the account (bank) or the AR/AP control account (1210/2110). Rounding per item to fils; state the rule.
- One draft journal (entry_type fx_revaluation, JV) with a line per item + one 7310 line; posted with dual
  control; auto-reverse on the 1st of the next month (reuse the P4 auto-reverse mechanism). Refuse if any needed
  currency has no rate for the period-end date (fx_rate_missing with the list) - never guess a rate.
- Idempotent per period (re-run replaces the draft; a posted run blocks re-run until reversed).
- Close checklist gate "FX revaluation": pass when no foreign-currency balances, or a posted run exists for the
  period; fail lists missing rates / missing run.
- Screen: Settings > FX rates (add rate) and a "Revalue FX" action on the Close page.

TESTS (hand-computed): USD bank 1,000.00 USD carried at 3.6725 = AED 3,672.50, period-end rate 3.6730 -> gain 0.50
(Dr bank 0.50 / Cr 7310 0.50); USD AR open 500.00 carried 1,836.25, rate 3.6700 -> loss 1.25 (Dr 7310 / Cr 1210);
missing rate refused; auto-reverse entry dated 1st next month; gate behaviour.
ACCEPTANCE: exact amounts, balanced, reversal scheduled, gate wired, full gates green.
DO NOT: fetch rates from the internet; change realised FX logic in settlements.
