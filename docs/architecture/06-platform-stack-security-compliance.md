# 06 — Platform, stack, security, compliance

**Retrieval date: 2026-10-03.**  
Demo user switcher must **not** exist in production.

## 1. Summary

The current Next.js + Postgres RLS + MinIO + Python worker + DB job queue can serve an in-house 50–100 client pilot if we add real auth, separate APIs, stronger jobs, and portal isolation. At ~1,000 clients, the DB-backed queue, single worker, and RLS-without-pooling strategy break first. Client portal (MFA, per-client isolation, download gating, audit) is year-1. No real client data before this security review passes. UAE residency preference is unset; AWS publishes `me-central-1` (UAE) and `me-south-1` (Bahrain) — [AWS Regions](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html); **confirm live Health status and Arnifi’s current region before locking**.

## 2. Options table

| Area | Options | Trade-offs | Cost | Reversibility |
|---|---|---|---|---|
| API | Keep catch-all in Next · Separate API service | Separation clearer SoD/scale | Med | Med |
| Jobs | Postgres queue · SQS+workers · Temporal/Step Functions | DB simple; SQS scales; workflow durable | Med–high | Med |
| Auth | Cookie demo switcher · Cognito/Auth0 + MFA · Entra SSO | Demo forbidden in prod | Med | High if early |
| Objects | MinIO · S3 | S3 for AWS prod | Low | High |
| Search | SQL · OpenSearch | Later | Med | High |

## 3. Recommendation (confidence: **high** for portal+MFA first; **medium** for job system timing)

**Pilot (≤100 clients):** keep Compose topology; add Cognito (or equivalent) MFA; strict RLS; SQS optional.  
**Scale (→1000):** externalize API, SQS (or Temporal) for jobs, RDS Proxy/PgBouncer, S3, structured observability, IaC.

### 3.1 What breaks first

| Component | @100 clients | @1000 clients |
|---|---|---|
| Next catch-all API | OK if horizontal web | CPU/latency; split API |
| Postgres RLS | OK with indexes | Plan regressions; need pooling |
| DB job queue | Contention / skipped polls | Move to SQS/workflow |
| Single Python worker | Backlog on OCR | Autoscaling workers |
| MinIO single node | OK for pilot | S3 multi-AZ |
| Demo session switcher | **Forbidden in prod** | — |

### 3.2 Target platform checklist

| Topic | Spec |
|---|---|
| Environments | dev / staging / prod; no prod data in dev |
| IaC | Terraform or CDK **UNVERIFIED** preference |
| CI/CD | Existing GH Actions + migrations gated |
| Feature flags | Portal, cloud OCR, MCP |
| Backups | RDS PITR; object versioning; **RPO ≤ 1h, RTO ≤ 8h** targets (**confirm with ops**) |
| Observability | Structured logs, traces, metrics; no secrets in logs |
| Migrations | Expand/contract; never rewrite journal history |

### 3.3 Client portal security

| Control | Spec |
|---|---|
| Auth | MFA mandatory (WebAuthn or TOTP); SSO later |
| Roles | `firm_admin`, `preparer`, `approver`, `client_user`, `auditor_ro` |
| SoD | preparer ≠ approver (90 days hard; policy after) |
| Isolation | Every query `client_id` + RLS; automated cross-tenant tests |
| Download gate | Pack `RELEASED` + hash match; show status/version/date; append-only `download_events` |
| Threat model | STRIDE on portal, upload, release, impersonation, IDOR |
| Session | Short TTL; no demo switcher |
| Secrets | KMS/Secrets Manager; no env in images |

### 3.4 STRIDE (condensed)

| Threat | Example | Mitigation |
|---|---|---|
| Spoofing | Stolen client password | MFA |
| Tampering | Altered journal via API | AuthZ + audit + immutability |
| Repudiation | “I didn’t download” | download_events |
| Info disclosure | Cross-client IDOR | RLS + tests |
| DoS | Upload bombs | Size limits + antivirus |
| Elevation | Client triggers release | Role checks |

### 3.5 Compliance notes (verify with counsel)

| Topic | Pointer |
|---|---|
| UAE PDPL | Federal Decree-Law 45/2021 — obligations **verify with counsel** (details **UNVERIFIED** here) |
| Companies registers retention | ≥5 years — Decree-Law 32/2021 Art. 26 — [MoET PDF](https://www.moet.gov.ae/documents/20121/376326/Commercial+Companies.pdf/12d14f53-1a3e-47b4-8e70-fac3f672c403) |
| FTA records | Tax record-keeping rules — **verify** primary FTA sources with tax lead |
| E-invoicing | MoF hub — [mof.gov.ae eInvoicing](https://mof.gov.ae/en/about-us/initiatives/einvoicing/) |
| Pen-test | Before V3 pilot |
| Incident response | Runbook + 24h notify path **UNVERIFIED** owner |

### 3.6 Residency

- Official regions include Middle East (UAE) `me-central-1` and Middle East (Bahrain) `me-south-1` — [AWS Regions list](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html).  
- Arnifi current region: **UNVERIFIED**.  
- Secondary reports of ME region disruption exist in press; **do not select a region from news alone** — check AWS Health and Arnifi infra owners at decision time.

## 4. Cost and effort

| Work | Likely pw |
|---|---|
| Auth MFA + roles | 4 |
| Portal isolation tests | 2 |
| Download gating + audit | 2 |
| SQS workers migration | 5 |
| IaC + backup drills | 4 |
| Pen-test remediation buffer | 3 |

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Demo switcher leaks to prod | Build flag; CI deny list |
| RLS bypass in worker SUPER role | Split credentials; least privilege |
| Queue backlog hides failures | SLOs + DLQ alarms |
| Wrong region choice | Decision record after Health check |

## 6. Evidence still needed

- Arnifi AWS account region and org structure.
- IdP preference (Cognito vs Entra).
- RPO/RTO sign-off.
- Counsel PDPL/FTA retention memo.

## 7. Open questions (≤10)

1. IdP choice?
2. Current AWS region?
3. Hard UAE-only residency? (none confirmed today)
4. Pen-test vendor timing?
5. Client portal in same app or subdomain?
6. Session length for clients vs staff?
7. IP allowlists for firm users?
8. Who owns IR on-call?
9. SQS now or after first backlog incident?
10. When is security review scheduled (blocks real data)?
