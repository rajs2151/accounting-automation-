# 08 — Quality, product, and risk

**Retrieval date: 2026-10-03.**  
Validation goldens = **filed VAT returns and report exports you supply**, not any external ledger product.

## 1. Summary

Quality is enforced by property-based accounting identities, integrity gates that block statement/VAT release, a deterministic recon engine with staleness, and versioned VAT rules with FTA citations and golden tests. Firm workflow gaps (portal queries, deadlines, RTL) are listed. Top risks and ranked decisions close the review set (with doc 09).

## 2. Options table

| Area | Options | Recommendation |
|---|---|---|
| Cascade invalidation | Hand-written step demotions · Hash/staleness model | **Staleness via content hash** |
| Recon | Manual only · Heuristic scorer · Learned weights | Heuristic now; learned in AI Stage 3 |
| VAT rules | Hard-coded · Versioned effective-dated store | **Versioned store + goldens** |

## 3. Recommendation (confidence: **high**)

### 3.1 Property-based identities (must be tests)

| Identity | Property | Gate |
|---|---|---|
| Trial balance | Σ debit = Σ credit for period set | Block close / statement release |
| Balance sheet | Assets = Liabilities + Equity (minor units) | Block statement release |
| Sub-ledger | Σ open AR/AP = control account balance | Block period close |
| RE roll-forward | Opening RE + NI − dividends ± adj = closing RE | Block year-end release |
| Journal | Each posted entry balanced | Block post |
| VAT pack | Box aggregates = sum of contributing lines | Block VAT release |
| Approval | Pack hash unchanged since approval | Block download |

### 3.2 Integrity gates

Release endpoints check gates atomically; failures return structured codes; overrides require dual-control + reason (except during first 90 days still preparer≠approver).

### 3.3 Reconciliation engine

| Feature | Spec |
|---|---|
| Score | amount 0.40 + date 0.20 + name 0.25 + ref 0.15 (initial weights) |
| Auto-match | ≥0.85 and no sign/cross-period flags |
| Suggest | 0.50–0.85 |
| One-to-many / partial | Subset-sum within ±0.5% invoice |
| FX | Compare in client base via stored rate; refuse unknown FX |
| Fees | Tag out-of-scope (bank fee, owner draw, intercompany) |
| Staleness | Upstream extract/posting change clears non-manual matches; sets `pass_stale` |
| Exception-first UI | Unmatched + suggested before matched lists |

### 3.4 VAT rule-engine governance

| Rule | Spec |
|---|---|
| Storage | `vat_rules(rule_id, version, phase, priority, effective_from, effective_to, fta_reference, conditions, effects, active)` |
| Immutability | Edits create new version; old retained |
| Citation | Every rule has `fta_reference` (Decree-Law / Cabinet / FTA guide section) |
| Evaluation | First-match-wins per phase; phase 4 recoverability may stack |
| Provenance | `rulesFired[{rule_id, version}]` on each determination |
| Goldens | Filed VAT packs + synthetic; CI fails on drift |
| Effective dating | Period date selects rule version set |

Detail of statement layouts lives in doc 09; governance of rules is enforced here in CI.

### 3.5 Testing strategy

| Layer | Content |
|---|---|
| Unit | Money, FX refuse, hash approvals |
| Property | Identities above |
| Golden | Filed VAT / exports (private fixture path) |
| Contract | Portal authZ IDOR suite |
| Load | 50k rows already in repo spirit; extend to journals |
| Accuracy dashboards | Field F1, recon precision, gate failure rates |

### 3.6 Firm workflow gaps (year-1 backlog)

Client portal queries, document request lists, assignments, deadline calendar, comments/mentions, Arabic RTL + a11y, sign-off trail beyond VAT pack.

## 4. Cost and effort

| Work | Likely pw |
|---|---|
| Identity tests + gates | 4 |
| Recon v1 | 8 |
| VAT rule store + goldens CI | 6 |
| Portal workflow gaps (min) | 6 |

## 5. Risk register (top 15)

| # | Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|---|
| 1 | Cross-tenant data leak | M | H | RLS + IDOR tests | Eng |
| 2 | Real data before portal PASS | M | H | Env gate | Eng/Sec |
| 3 | Wrong VAT box in release | M | H | Goldens + dual-control | Tax |
| 4 | Cloud OCR exfil | M | H | Default deny | Sec |
| 5 | Recon false match | M | M | Caps + human accept | Eng |
| 6 | Period reopen abuse | L | H | Reason+audit+stale packs | Eng |
| 7 | Dual-control bypass | M | H | DB constraint | Eng |
| 8 | Cut-over garbage | M | H | Opening identities | Acc |
| 9 | Scope creep inventory/payroll | H | M | Explicit out-of-v1 | PM |
| 10 | AWS region instability | L | H | Multi-region backup | Infra |
| 11 | Key-person tax knowledge | M | M | Rule citations | Tax |
| 12 | LLM non-determinism on tax | M | H | Rules final | Eng |
| 13 | Missing goldens | H | H | Ops collection | Ops |
| 14 | Underestimated review cost | H | M | Time study | Finance |
| 15 | E-invoice 2027 unreadiness | M | H | PINT intake Stage B/C | Tax/Eng |

## 6. Evidence still needed

- Filed VAT golden set.
- Override policy after day 90.
- Accessibility target (WCAG level).

## 7. Open questions (≤10)

1. Tolerance for VAT box diffs in goldens (fils)?
2. Manual recon override without suggestion allowed?
3. WCAG level?
4. Who signs risk acceptance for pilot?
5. Max reopen count per period?
6. Client comments visible to preparer only or full firm?
7. Arabic UI year-1 or later?
8. Anomaly detection thresholds owner?
9. Load target journals/period?
10. Rank top 3 risks to kill first?
