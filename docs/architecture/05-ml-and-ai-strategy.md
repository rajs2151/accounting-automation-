# 05 — ML and AI strategy

**Retrieval date: 2026-10-03.**  
AI proposes; **rules decide** tax/VAT treatment. No model auto-files or auto-releases.

## 1. Summary

Use rules + client playbook memory first; add classical models in shadow mode from accountant corrections; use retrieval-augmented LLMs only for ambiguous extraction/classification; learn recon weights later. Cold-start from historical documents/books is allowed only with owner approval and after portal security PASS. Training data stays tenant-isolated. “Learns” is a claim we make only after measurable lift on held-out goldens.

## 2. Options table

| Stage | Approach | Pros | Cons | Data needed | Rollback |
|---|---|---|---|---|---|
| 0 | Rules + playbook + supplier memory | Deterministic; auditable | Cold start weak | Playbooks | Disable memory flags |
| 1 | Classical ML on corrections (shadow) | Cheap; controllable | Needs labels | ≥**UNVERIFIED** 5k corrections | Stop shadow write |
| 2 | RAG LLM for ambiguous cases | Handles novel layouts | Cost; privacy | Chunk store per tenant | Kill LLM route |
| 3 | Learned recon weights + anomaly | Fewer exceptions | Drift risk | Matched pairs history | Revert to heuristic weights |

## 3. Recommendation (confidence: **high** on tax determinism; **medium** on timeline)

Ship **Stage 0** with Stage A product. Stage 1 after 1–2 quarters of corrections. Stage 2 only with approved cloud/privacy path. Stage 3 after recon Stage C is stable.

### 3.1 Where each technique belongs

| Allowed | Forbidden |
|---|---|
| OCR / field extraction proposals | Final VAT box without rules |
| Doc type suggestions | Auto-release packs |
| Coding suggestions from memory | Cross-client training without isolation |
| Recon score features | Silent FX defaults |
| Ask-client question drafting | Filing/submit actions |

### 3.2 Staged plan and gates

| Stage | Gate metric | Expected lift | Cost | Risk |
|---|---|---|---|---|
| 0 | % txns with playbook hit; zero cross-tenant leaks in tests | Baseline | Low | Misconfigured playbook |
| 1 | Shadow precision/recall vs human on coding; no prod autowrite | +10–25% suggest accept **UNVERIFIED** | Low–med | Label noise |
| 2 | Escalation rate ↓; field F1 ↑ on hard set; $/doc within budget | Hard-tail only | Med–high | Data exfil |
| 3 | Auto-match precision ≥ threshold; false match < bound | Recon time ↓ | Med | Bad matches |

### 3.3 Cold-start learning

From historical Drive docs + existing books **only if**:
1. Owner approves corpus,  
2. Portal security PASS,  
3. Tenant isolation enforced,  
4. Outputs are suggestions, not auto-posts.

### 3.4 Client playbook (drives ML/rules)

Versioned document: VAT status, TRN, periods, free zone, categories, supplier rules, thresholds, folder maps. Inference and rule engine must log `playbook_version`.

### 3.5 Ask-the-client loop

Low confidence → question to client portal → answer → `corrections` table → optional promotion into playbook/supplier memory after accountant confirm.

### 3.6 MCP / agent interface

Read-only first; scoped tokens; audit every tool call; no mutate/release tools until SoD review (see doc 03/06).

### 3.7 Data governance

| Topic | Rule |
|---|---|
| Tenant isolation | No shared embeddings across clients in v1 |
| Consent | Client agreement for any cloud model |
| Labelling | Accountant corrections are gold; dual review for train set |
| Eval sets | Per-tenant + firm-wide synthetic; versioned |
| Model/prompt version | Stored on provenance_events |
| Drift | Weekly shadow report; alert on metric drop |
| Auto-approve | Off until precision gate; never for VAT treatment |
| Vendor DPA | Required before Bedrock/Vertex/OpenAI/etc. |

### 3.8 Honest bar for “learns”

We may claim learning only when: (a) supplier memory or model changes suggestions without code deploy, (b) held-out accept-rate improves vs Stage 0 baseline with CI regression guard, (c) provenance shows which memory/model version fired.

## 4. Cost and effort

| Stage | Likely pw |
|---|---|
| 0 playbook + memory | 4 |
| 1 shadow classical | 6 |
| 2 RAG LLM route | 6 |
| 3 recon learning | 5 |

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cross-client leakage | Separate indexes; tests |
| LLM tax hallucination | Rules final; LLM cannot set vat201_box alone |
| Premature “AI” marketing | Gate claims on metrics |

## 6. Evidence still needed

- Correction volume after 90 days.
- Cloud vendor DPA status.
- Accounting lead policy on client-visible AI suggestions.

## 7. Open questions (≤10)

1. Approve cold-start from historical Drive? When?
2. Shared firm-level anonymous features ever allowed?
3. Auto-approve threshold policy owner?
4. Which cloud LLM is even on the table?
5. Client-visible “AI suggested” labels required?
6. Retention of prompts/outputs?
7. Multilingual playbook (AR/EN)?
8. Who promotes corrections into memory?
9. MCP year-1 yes/no?
10. Minimum corrections before Stage 1 train?
